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
import { escapeRuntimeContextDelimiters } from "./content.js";
import { normalizeId } from "../grammar.js";
import { distanceMeters, type LiveLocations, type Point, type Share, type ShareChange } from "./locations.js";

export const MIN_REPORT_EVERY_MS = 60_000;
/** Silence after a durable checkpoint that reads "stopped, or no signal" (the checkpoint cycle is 2 min). */
export const STILL_AFTER_MS = 3 * 60_000;
/** How far from the still point counts as moving again (or the fix's accuracy, if larger). */
export const MOVED_AGAIN_M = 50;
/** Within this distance an `eta` watch counts as arrived, whatever the speed. */
export const ARRIVED_M = 100;
/** Below this speed (m/s) nobody is on their way: an `eta` watch waits. */
export const MOVING_MPS = 0.5;

export type Place = Point & { name: string };

/** A report's fixed phrases (keys of `strings.liveLocation.reportPhrases`); missing ones stay English. */
export type ReportPhrases = { -readonly [K in keyof typeof strings.liveLocation.reportPhrases]: string };
export type PhraseKey = keyof ReportPhrases;
export const PHRASE_KEYS = Object.keys(strings.liveLocation.reportPhrases) as PhraseKey[];
/** The longest phrase accepted from the model. */
export const MAX_PHRASE = 200;

/**
 * Phrases the agent gave, cleaned: known keys only, strings only, no control or format characters, no OpenClaw
 * runtime-context delimiters, bounded. Anything else falls back to English.
 */
export function cleanPhrases(raw: unknown): Partial<ReportPhrases> {
  const out: Partial<ReportPhrases> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const k of PHRASE_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== "string") continue;
    const t = escapeRuntimeContextDelimiters(v).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
    if (t && [...t].length <= MAX_PHRASE) out[k] = t;
  }
  return out;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

/** The texts of one report, in its phrases. */
class ReportText {
  readonly #p: ReportPhrases;
  constructor(phrases: Partial<ReportPhrases> = {}) {
    this.#p = { ...strings.liveLocation.reportPhrases, ...phrases };
  }
  #span(ms: number): string {
    const min = Math.round(ms / 60_000);
    if (min < 60) return `${Math.max(1, min)} ${this.#p.min}`;
    return `${Math.floor(min / 60)} ${this.#p.h} ${min % 60} ${this.#p.min}`;
  }
  line(r: { who: string; places: Array<{ name: string; m: number }>; ageMs: number; leftMs: number; map: string }): string {
    const places = r.places.map((p) => fill(this.#p.from, { distance: strings.liveLocation.distance(p.m), place: p.name }));
    const age = r.ageMs < 60_000 ? this.#p.just_now : fill(this.#p.ago, { time: this.#span(r.ageMs) });
    const left = fill(this.#p.left, { time: this.#span(r.leftMs) });
    return `📍 ${r.who}${places.length ? ` — ${places.join(", ")}` : ""} · ${age} · ${left}\n${r.map}`;
  }
  say(key: PhraseKey, name: string): string {
    return fill(this.#p[key], { name });
  }
  lastPosition(map: string): string {
    return `${this.#p.last_position} ${map}`;
  }
}

export type WatchSpec =
  | { kind: "near"; point: Point; label: string; radiusM: number }
  /** "N minutes away": distance over the recent speed, no routing (#33); arriving counts too. */
  | { kind: "eta"; point: Point; label: string; minutes: number }
  | { kind: "still"; minutes: number }
  | { kind: "ended" };

type Owner = { conversationId: string; setterUserId: string; shareId: string };

type Watch = Owner & { id: string; spec: WatchSpec; timer?: unknown };

type Report = Owner & {
  id: string;
  everyMs: number;
  untilMs: number | undefined;
  untilTimer?: unknown;
  done: boolean;
  /** Set while the sharer seems still: the point they stopped at. */
  stillAt: Point | undefined;
  tick?: unknown;
  stillTimer?: unknown;
  /** The serialized send chain. */
  chain: Promise<void>;
  /** Its texts, in the phrases the agent gave (the person's language). */
  text: ReportText;
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
  /**
   * One agent turn in the conversation, answering the person who set the watch. `share` is the share as it was when
   * the watch fired (an ended one included): the turn's delivery checks visibility against it, never "allowed"
   * because the share is gone.
   */
  fireTurn: (owner: Owner, share: Share, text: string) => Promise<void>;
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

  /** The text of one share as seen from a conversation (the read tool, and the reports in their phrases). */
  describe(conversationId: string, share: Share, text: ReportText = new ReportText()): string {
    const now = this.#d.now();
    const places = this.#d
      .places(conversationId)
      .map((p) => ({ name: p.name, m: distanceMeters(share, p) }))
      .sort((a, b) => a.m - b.m)
      .slice(0, 3);
    return text.line({ who: this.#d.nameOf(share), places, ageMs: Math.max(0, now - share.fixAtMs), leftMs: Math.max(0, share.untilMs - now), map: mapLink(share) });
  }

  /** Sets a one-shot watch; `already` when its condition holds now (nothing is set). */
  addWatch(owner: Owner, spec: WatchSpec): { id: string } | { already: true } {
    const share = this.#d.locations.get(owner.shareId);
    if (!share) throw new Error("unknown share");
    if (this.#holds(spec, share)) return { already: true };
    const w: Watch = { ...this.#norm(owner), id: `w${this.#next++}`, spec };
    this.#watches.set(w.id, w);
    if (spec.kind === "still") this.#armStill(w, share);
    return { id: w.id };
  }

  addReport(owner: Owner, everyMs: number, untilMs?: number, phrases: Partial<ReportPhrases> = {}): { id: string } {
    if (!this.#d.locations.get(owner.shareId)) throw new Error("unknown share");
    const r: Report = {
      ...this.#norm(owner),
      id: `r${this.#next++}`,
      everyMs: Math.max(MIN_REPORT_EVERY_MS, everyMs),
      untilMs,
      done: false,
      stillAt: undefined,
      chain: Promise.resolve(),
      text: new ReportText(phrases),
    };
    this.#reports.set(r.id, r);
    this.#schedule(r);
    if (untilMs !== undefined) {
      r.untilTimer = this.#d.setTimer(() => {
        r.untilTimer = undefined;
        const s = this.#d.locations.get(r.shareId);
        this.#finish(r, r.text.say("until", s ? this.#d.nameOf(s) : ""), s);
      }, Math.max(0, untilMs - this.#d.now()));
    }
    // A share that already went still before the report was asked for: its checkpoint counts from when it came.
    const share = this.#d.locations.get(r.shareId);
    if (share) this.#armStillReport(r, share);
    return { id: r.id };
  }

  /** The person switched language: the report's phrases are replaced (missing ones English). */
  updatePhrases(conversationId: string, id: string, phrases: Partial<ReportPhrases>): boolean {
    const r = this.#reports.get(id);
    if (!r || r.done || r.conversationId !== normalizeId(conversationId)) return false;
    r.text = new ReportText(phrases);
    return true;
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
    for (const r of this.#reports.values()) {
      r.done = true;
      this.#clearReport(r);
    }
    this.#watches.clear();
    this.#reports.clear();
  }

  // ------------------------------------------------------------------------------------------ changes

  #changed(c: ShareChange): void {
    if (this.#stopped) return;
    const id = c.share.id;
    if (c.kind === "ended") {
      for (const w of [...this.#watches.values()].filter((x) => x.shareId === id)) {
        if (w.spec.kind === "ended") this.#fire(w, c.share, strings.liveLocation.firedWhat.ended(this.#d.nameOf(c.share)));
        else this.#dropWatch(w);
      }
      const reason = c.reason ?? "stopped";
      const key: PhraseKey = reason === "expired" ? "expired" : reason === "deleted" ? "deleted" : reason === "ended_while_away" ? "away" : "stopped";
      for (const r of [...this.#reports.values()].filter((x) => x.shareId === id && !x.done)) this.#finish(r, r.text.say(key, this.#d.nameOf(c.share)), c.share);
      return;
    }
    const share = c.share;
    for (const w of [...this.#watches.values()].filter((x) => x.shareId === id)) {
      if (w.spec.kind === "still") this.#armStill(w, share);
      else if (this.#holds(w.spec, share)) {
        const who = this.#d.nameOf(share);
        const what =
          w.spec.kind === "near"
            ? strings.liveLocation.firedWhat.near(who, w.spec.label, strings.liveLocation.distance(w.spec.radiusM))
            : w.spec.kind === "eta"
              ? strings.liveLocation.firedWhat.eta(who, w.spec.label, strings.liveLocation.distance(distanceMeters(share, w.spec.point)))
              : "";
        if (what) this.#fire(w, share, what);
      }
    }
    for (const r of [...this.#reports.values()].filter((x) => x.shareId === id && !x.done)) this.#moved(r, share);
  }

  // ------------------------------------------------------------------------------------------ watches

  /** Whether a position-based watch's condition holds for the share now. */
  #holds(spec: WatchSpec, share: Share): boolean {
    if (spec.kind === "near") return distanceMeters(share, spec.point) <= spec.radiusM;
    if (spec.kind === "eta") {
      const m = distanceMeters(share, spec.point);
      if (m <= ARRIVED_M) return true;
      const v = share.speedMps;
      return v !== undefined && v >= MOVING_MPS && m / v <= spec.minutes * 60;
    }
    return false;
  }

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
      if (s) this.#fire(w, s, strings.liveLocation.firedWhat.still(this.#d.nameOf(s), minutes));
    }, minutes * 60_000 - Math.max(0, this.#d.now() - share.lastAtMs));
  }

  #dropWatch(w: Watch): void {
    if (w.timer !== undefined) this.#d.clearTimer(w.timer);
    this.#watches.delete(w.id);
  }

  /** Claimed before anything asynchronous: a watch fires at most once. */
  #fire(w: Watch, share: Share, what: string): void {
    if (!this.#watches.has(w.id)) return;
    this.#dropWatch(w);
    void (async () => {
      // Checked against the share as it was when the watch fired — an ended one too (the turn may still say where).
      if (this.#stopped || !(await this.#d.canSee(w.conversationId, share))) {
        this.#d.log("location_watch_hidden", { kind: w.spec.kind });
        return;
      }
      if (this.#stopped) return;
      await this.#d.fireTurn({ conversationId: w.conversationId, setterUserId: w.setterUserId, shareId: w.shareId }, share, strings.liveLocation.fired(what));
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
      this.#finish(r, r.text.say("until", this.#d.nameOf(share)), share);
      return;
    }
    if (r.stillAt) return; // paused: the same position again is noise
    this.#enqueue(r, share, () => this.describe(r.conversationId, share, r.text));
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
      this.#enqueue(r, share, () => r.text.say("moving", this.#d.nameOf(share)));
    }
    this.#armStillReport(r, share);
  }

  /** Only after a durable checkpoint: the phone sends one on going still, then nothing (§4.29). */
  #armStillReport(r: Report, share: Share): void {
    if (share.lastLane !== "durable" || r.done) return;
    if (r.stillTimer !== undefined) this.#d.clearTimer(r.stillTimer);
    r.stillTimer = this.#d.setTimer(() => {
      r.stillTimer = undefined;
      const s = this.#d.locations.get(r.shareId);
      if (!s || r.done || r.stillAt) return;
      r.stillAt = { lat: s.lat, lon: s.lon };
      this.#enqueue(r, s, () => `${r.text.say("still", this.#d.nameOf(s))}\n${mapLink(s)}`);
    }, Math.max(0, STILL_AFTER_MS - Math.max(0, this.#d.now() - share.lastAtMs)));
  }

  /** One send at a time per report, each after a fresh visibility check; a failed check ends the report. */
  #enqueue(r: Report, share: Share, text: () => string): void {
    r.chain = r.chain.then(async () => {
      if (r.done || this.#stopped) return;
      const pastUntil = () => r.untilMs !== undefined && this.#d.now() >= r.untilMs;
      if (pastUntil()) {
        this.#finish(r, r.text.say("until", this.#d.nameOf(share)), share);
        return;
      }
      if (!(await this.#d.canSee(r.conversationId, share))) {
        this.#finish(r, r.text.say("hidden", this.#d.nameOf(share)));
        return;
      }
      if (r.done || this.#stopped) return;
      if (pastUntil()) {
        this.#finish(r, r.text.say("until", this.#d.nameOf(share)), share);
        return;
      }
      await this.#d.send(r.conversationId, text()).catch((err: unknown) => this.#d.log("location_report_failed", { errorClass: err instanceof Error ? err.name : typeof err }));
    });
  }

  #clearReport(r: Report): void {
    for (const t of [r.tick, r.stillTimer, r.untilTimer]) if (t !== undefined) this.#d.clearTimer(t);
    r.tick = undefined;
    r.stillTimer = undefined;
    r.untilTimer = undefined;
  }

  /**
   * The one terminal transition: marked done synchronously, its last message (if any) after the sends in flight. With
   * `share` (the share ended), the message ends with its last position — only if the conversation still passes the
   * visibility rule.
   */
  #finish(r: Report, lastText: string | undefined, share?: Share): void {
    if (r.done) return;
    r.done = true;
    this.#clearReport(r);
    this.#reports.delete(r.id);
    this.#d.log("location_report_ended", { with_message: lastText !== undefined });
    if (lastText === undefined || this.#stopped) return;
    r.chain = r.chain.then(async () => {
      if (this.#stopped) return;
      const where = share && (await this.#d.canSee(r.conversationId, share)) ? `\n${r.text.lastPosition(mapLink(share))}` : "";
      if (this.#stopped) return;
      await this.#d.send(r.conversationId, lastText + where).catch((err: unknown) => this.#d.log("location_report_failed", { errorClass: err instanceof Error ? err.name : typeof err }));
    });
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

