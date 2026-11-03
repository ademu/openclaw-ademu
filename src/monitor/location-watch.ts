// Watches and reports on live locations (openclaw-ademu #33, owner decisions 2026-11-03).
//
// A WATCH is one-shot: the model sets it from a request ("tell me when Maria is near home"), and when its
// condition holds the plugin starts exactly one agent turn in the conversation where it was set, then the
// watch is gone. It is claimed synchronously before anything asynchronous, so two positions arriving together
// never fire it twice. Kinds: `near` (within a radius of a point), `still` (no new position for N minutes —
// stopped, or out of signal: a still phone sends nothing), `ended` (the share ended). A share's end fires its
// `ended` watches first, then drops the rest.
//
// A REPORT repeats ("tell me where Maria is every 5 minutes"): the plugin sends the text itself, as a normal
// message (the owner wants the alert with the phone locked), and the model is never woken for it. A report pauses
// when the sharer seems to have stopped — a durable checkpoint followed by 3 minutes of silence (§4.29: the phone
// sends one on going still, and nothing after); a snapshot position never counts — and resumes only on real
// movement away from that point (a checkpoint on reconnect or resume at the same place is not movement). It ends
// once, terminally, with one last message, whichever comes first: the share ends, its own `until`, a cancel, or
// the conversation no longer passing the visibility rule. Sends of one report are serialized, and nothing is sent
// after its last message.
//
// Visibility (owner): a share's position reaches a conversation only if every member of that conversation can see
// the share already. `canSee` reads FRESH memberships (not the cache) and fails closed; it is checked when a watch
// fires and before every report, and the turn's own delivery checks it again (src/monitor/ingress.ts).
// Everything here lives in memory: it ends with the account (a gateway restart forgets watches and reports).
import { strings } from "../i18n/strings.js";
import { normalizeId } from "../grammar.js";
import { distanceMeters, type LiveLocations, type Point, type Share, type ShareChange } from "./locations.js";

export const MIN_REPORT_EVERY_MS = 60_000;
/** Silence after a durable checkpoint that reads "stopped, or no signal" (the checkpoint cycle is 2 min). */
export const STILL_AFTER_MS = 3 * 60_000;
/** How far from the still point counts as moving again (or the fix's accuracy, if larger). */
export const MOVED_AGAIN_M = 50;

export type Place = Point & { name: string };

export type WatchSpec =
  | { kind: "near"; point: Point; label: string; radiusM: number }
  | { kind: "still"; minutes: number }
  | { kind: "ended" };

type Owner = { conversationId: string; setterUserId: string; shareId: string };

type Watch = Owner & { id: string; spec: WatchSpec; timer?: unknown };

type Report = Owner & {
  id: string;
  everyMs: number;
  untilMs: number | undefined;
  done: boolean;
  /** Set while the sharer seems still: the point they stopped at. */
  stillAt: Point | undefined;
  tick?: unknown;
  stillTimer?: unknown;
  /** The serialized send chain. */
  chain: Promise<void>;
};

export type LocationWatchesDeps = {
  locations: LiveLocations;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Fresh memberships; false when unknown (fail closed). */
  canSee: (conversationId: string, share: Share) => Promise<boolean>;
  /** The sharer's display name (already escaped for the host). */
  nameOf: (share: Share) => string;
  places: (conversationId: string) => Place[];
  /** The plugin's own message into a conversation (a normal alert). */
  send: (conversationId: string, text: string) => Promise<void>;
  /** One agent turn in the conversation, answering the person who set the watch. */
  fireTurn: (owner: Owner, text: string) => Promise<void>;
  /** Structural fields only: never coordinates, names or texts. */
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export function mapLink(p: Point): string {
  return `https://maps.apple.com/?ll=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
}

export class LocationWatches {
  readonly #d: LocationWatchesDeps;
  readonly #watches = new Map<string, Watch>();
  readonly #reports = new Map<string, Report>();
  readonly #unsubscribe: () => void;
  #next = 1;
  #stopped = false;

  constructor(deps: LocationWatchesDeps) {
    this.#d = deps;
    this.#unsubscribe = deps.locations.onChange((c) => this.#changed(c));
  }

  /** The text of one share as seen from a conversation (the read tool and the reports). */
  describe(conversationId: string, share: Share): string {
    const now = this.#d.now();
    const places = this.#d
      .places(conversationId)
      .map((p) => ({ name: p.name, m: distanceMeters(share, p) }))
      .sort((a, b) => a.m - b.m)
      .slice(0, 3)
      .map((p) => strings.liveLocation.fromPlace(strings.liveLocation.distance(p.m), p.name));
    return strings.liveLocation.line({
      who: this.#d.nameOf(share),
      places,
      age: strings.liveLocation.age(Math.max(0, now - share.fixAtMs)),
      left: strings.liveLocation.left(Math.max(0, share.untilMs - now)),
      map: mapLink(share),
    });
  }

  /** Sets a one-shot watch; `already` when its condition holds now (nothing is set). */
  addWatch(owner: Owner, spec: WatchSpec): { id: string } | { already: true } {
    const share = this.#d.locations.get(owner.shareId);
    if (!share) throw new Error("unknown share");
    if (spec.kind === "near" && distanceMeters(share, spec.point) <= spec.radiusM) return { already: true };
    const w: Watch = { ...this.#norm(owner), id: `w${this.#next++}`, spec };
    this.#watches.set(w.id, w);
    if (spec.kind === "still") this.#armStill(w, share);
    return { id: w.id };
  }

  addReport(owner: Owner, everyMs: number, untilMs?: number): { id: string } {
    if (!this.#d.locations.get(owner.shareId)) throw new Error("unknown share");
    const r: Report = {
      ...this.#norm(owner),
      id: `r${this.#next++}`,
      everyMs: Math.max(MIN_REPORT_EVERY_MS, everyMs),
      untilMs,
      done: false,
      stillAt: undefined,
      chain: Promise.resolve(),
    };
    this.#reports.set(r.id, r);
    this.#schedule(r);
    return { id: r.id };
  }

  list(conversationId: string): Array<{ id: string; kind: string; shareId: string }> {
    const c = normalizeId(conversationId);
    return [
      ...[...this.#watches.values()].filter((w) => w.conversationId === c).map((w) => ({ id: w.id, kind: w.spec.kind, shareId: w.shareId })),
      ...[...this.#reports.values()].filter((r) => r.conversationId === c && !r.done).map((r) => ({ id: r.id, kind: "report", shareId: r.shareId })),
    ];
  }

  /** Cancels a watch or a report of this conversation; a report says so once. */
  cancel(conversationId: string, id: string): boolean {
    const c = normalizeId(conversationId);
    const w = this.#watches.get(id);
    if (w && w.conversationId === c) {
      this.#dropWatch(w);
      return true;
    }
    const r = this.#reports.get(id);
    if (r && r.conversationId === c && !r.done) {
      this.#finish(r, undefined);
      return true;
    }
    return false;
  }

  /** The account stops: every timer cleared, nothing sent afterwards. */
  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
    for (const w of this.#watches.values()) if (w.timer !== undefined) this.#d.clearTimer(w.timer);
    for (const r of this.#reports.values()) this.#clearReport(r);
    this.#watches.clear();
    this.#reports.clear();
  }

  // ------------------------------------------------------------------------------------------ changes

  #changed(c: ShareChange): void {
    if (this.#stopped) return;
    const id = c.share.id;
    if (c.kind === "ended") {
      for (const w of [...this.#watches.values()].filter((x) => x.shareId === id)) {
        if (w.spec.kind === "ended") this.#fire(w, strings.liveLocation.firedWhat.ended(this.#d.nameOf(c.share)));
        else this.#dropWatch(w);
      }
      const why = strings.liveLocation.ended;
      const reason = c.reason ?? "stopped";
      const text = reason === "expired" ? why.expired : reason === "deleted" ? why.deleted : reason === "ended_while_away" ? why.away : why.stopped;
      for (const r of [...this.#reports.values()].filter((x) => x.shareId === id && !x.done)) this.#finish(r, text(this.#d.nameOf(c.share)));
      return;
    }
    const share = c.share;
    for (const w of [...this.#watches.values()].filter((x) => x.shareId === id)) {
      if (w.spec.kind === "near") {
        const m = distanceMeters(share, w.spec.point);
        if (m <= w.spec.radiusM) this.#fire(w, strings.liveLocation.firedWhat.near(this.#d.nameOf(share), w.spec.label, strings.liveLocation.distance(w.spec.radiusM)));
      } else if (w.spec.kind === "still") this.#armStill(w, share);
    }
    for (const r of [...this.#reports.values()].filter((x) => x.shareId === id && !x.done)) this.#moved(r, share);
  }

  // ------------------------------------------------------------------------------------------ watches

  #norm(owner: Owner): Owner {
    return { conversationId: normalizeId(owner.conversationId), setterUserId: normalizeId(owner.setterUserId), shareId: normalizeId(owner.shareId) };
  }

  #armStill(w: Watch, share: Share): void {
    if (w.spec.kind !== "still") return;
    if (w.timer !== undefined) this.#d.clearTimer(w.timer);
    const minutes = w.spec.minutes;
    w.timer = this.#d.setTimer(() => {
      w.timer = undefined;
      const s = this.#d.locations.get(w.shareId);
      if (s) this.#fire(w, strings.liveLocation.firedWhat.still(this.#d.nameOf(s), minutes));
    }, minutes * 60_000 - Math.max(0, this.#d.now() - share.lastAtMs));
  }

  #dropWatch(w: Watch): void {
    if (w.timer !== undefined) this.#d.clearTimer(w.timer);
    this.#watches.delete(w.id);
  }

  /** Claimed before anything asynchronous: a watch fires at most once. */
  #fire(w: Watch, what: string): void {
    if (!this.#watches.has(w.id)) return;
    this.#dropWatch(w);
    const share = this.#d.locations.get(w.shareId);
    void (async () => {
      // A share that just ended is no longer in the state; its `ended` watch carries no position, so it needs no check.
      if (share && !(await this.#d.canSee(w.conversationId, share))) {
        this.#d.log("location_watch_hidden", { kind: w.spec.kind });
        return;
      }
      await this.#d.fireTurn({ conversationId: w.conversationId, setterUserId: w.setterUserId, shareId: w.shareId }, strings.liveLocation.fired(what));
      this.#d.log("location_watch_fired", { kind: w.spec.kind });
    })().catch((err: unknown) => this.#d.log("location_watch_failed", { kind: w.spec.kind, errorClass: err instanceof Error ? err.name : typeof err }));
  }

  // ------------------------------------------------------------------------------------------ reports

  #schedule(r: Report): void {
    if (r.done || this.#stopped) return;
    r.tick = this.#d.setTimer(() => {
      r.tick = undefined;
      this.#report(r);
      this.#schedule(r);
    }, r.everyMs);
  }

  #report(r: Report): void {
    if (r.done) return;
    const share = this.#d.locations.get(r.shareId);
    if (!share) return; // its end arrives as a change
    if (r.untilMs !== undefined && this.#d.now() >= r.untilMs) {
      this.#finish(r, strings.liveLocation.ended.until(this.#d.nameOf(share)));
      return;
    }
    if (r.stillAt) return; // paused: the same position again is noise
    this.#enqueue(r, share, () => this.describe(r.conversationId, share));
  }

  #moved(r: Report, share: Share): void {
    if (r.stillTimer !== undefined) {
      this.#d.clearTimer(r.stillTimer);
      r.stillTimer = undefined;
    }
    if (r.stillAt) {
      const moved = distanceMeters(share, r.stillAt) > Math.max(MOVED_AGAIN_M, share.accuracyM ?? 0);
      if (!moved) {
        this.#armStillReport(r, share);
        return;
      }
      r.stillAt = undefined;
      this.#enqueue(r, share, () => strings.liveLocation.moving(this.#d.nameOf(share)));
    }
    this.#armStillReport(r, share);
  }

  /** Only after a durable checkpoint: the phone sends one on going still, then nothing (§4.29). */
  #armStillReport(r: Report, share: Share): void {
    if (share.lastLane !== "durable") return;
    r.stillTimer = this.#d.setTimer(() => {
      r.stillTimer = undefined;
      const s = this.#d.locations.get(r.shareId);
      if (!s || r.done || r.stillAt) return;
      r.stillAt = { lat: s.lat, lon: s.lon };
      this.#enqueue(r, s, () => strings.liveLocation.still(this.#d.nameOf(s), mapLink(s)));
    }, STILL_AFTER_MS);
  }

  /** One send at a time per report, each after a fresh visibility check; a failed check ends the report. */
  #enqueue(r: Report, share: Share, text: () => string): void {
    r.chain = r.chain.then(async () => {
      if (r.done) return;
      if (!(await this.#d.canSee(r.conversationId, share))) {
        this.#finish(r, strings.liveLocation.ended.hidden(this.#d.nameOf(share)));
        return;
      }
      if (r.done) return;
      await this.#d.send(r.conversationId, text()).catch((err: unknown) => this.#d.log("location_report_failed", { errorClass: err instanceof Error ? err.name : typeof err }));
    });
  }

  #clearReport(r: Report): void {
    if (r.tick !== undefined) this.#d.clearTimer(r.tick);
    if (r.stillTimer !== undefined) this.#d.clearTimer(r.stillTimer);
    r.tick = undefined;
    r.stillTimer = undefined;
  }

  /** The one terminal transition: marked done synchronously, its last message (if any) after the sends in flight. */
  #finish(r: Report, lastText: string | undefined): void {
    if (r.done) return;
    r.done = true;
    this.#clearReport(r);
    this.#reports.delete(r.id);
    this.#d.log("location_report_ended", { with_message: lastText !== undefined });
    if (lastText === undefined || this.#stopped) return;
    r.chain = r.chain.then(() =>
      this.#d.send(r.conversationId, lastText).catch((err: unknown) => this.#d.log("location_report_failed", { errorClass: err instanceof Error ? err.name : typeof err })),
    );
  }
}

/** What the tools reach through the live-account registry (src/outbound.ts `LiveAccount.liveLocations`). */
export type LiveLocationsHandle = {
  locations: LiveLocations;
  watches: LocationWatches;
  places: {
    list: (conversationId: string) => Place[];
    set: (conversationId: string, place: Place) => void;
    remove: (conversationId: string, name: string) => boolean;
  };
  /** Fresh memberships, fail closed: every member of the conversation is a member of the share's group. */
  canSee: (conversationId: string, share: Share) => Promise<boolean>;
  nameOf: (share: Share) => string;
};

/**
 * The owner's visibility rule over FRESH memberships (never the cache): from conversation C a share of group G is
 * visible iff every member user of C is a member of G. A lookup that fails is "not visible".
 */
export async function visibleFrom(
  getMembers: (groupId: string) => Promise<Array<{ user_id: string }>>,
  conversationId: string,
  share: Share,
): Promise<boolean> {
  try {
    const [here, there] = await Promise.all([getMembers(conversationId), getMembers(share.groupId)]);
    if (here.length === 0) return false;
    const inGroup = new Set(there.map((m) => normalizeId(m.user_id)));
    return here.every((m) => inGroup.has(normalizeId(m.user_id)));
  } catch {
    return false;
  }
}

