// Live location state (openclaw-ademu #33, AdemuMLS #941): every live share the agent can see, with its
// latest applied position. Silent: nothing here starts a turn or writes a line for the agent (AdemuMLS
// DECISIONS §4.29, owner 2026-10-23: a position never wakes the model on its own); the read tool, the
// watches and the reports read it (`src/tools/locations.ts`).
//
// The daemon applies every position before passing it (a known live START of the group, from the START's
// own device and user, a `seq` above the visible one — AdemuMLS PROTOCOL.md §Location), so this mirrors
// its read model: a START (`location` with `live`) opens a share at `seq` 0 with its own pin, a
// `live_location` on either lane (a live frame or a durable checkpoint) moves it, and `location_ended`,
// a delete of the START or leaving the group ends it. At attach the state is replaced by
// `get_live_locations`, and every event at or below its `as_of` is ignored. The bodies are read raw: the
// 1.0 client does not know these types. Nothing here is persisted or logged with coordinates.
import { PROTOCOL_CHAT } from "@ademu/adc-client";
import { normalizeId } from "../grammar.js";

export type Point = { lat: number; lon: number };

export type Share = Point & {
  /** The START's message id. */
  id: string;
  groupId: string;
  sharerUserId: string;
  untilMs: number;
  seq: number;
  accuracyM: number | undefined;
  /** When the sharer's phone measured the position (the START's: its own send time). */
  fixAtMs: number;
  /** How the latest position came: a live frame, a durable checkpoint (the START too), or the attach snapshot,
   *  which does not say (so it never counts as a checkpoint). */
  lastLane: "live" | "durable" | "seeded";
  /** This gateway's clock when the latest position arrived. */
  lastAtMs: number;
  /** Recent ground speed in m/s (smoothed over the positions' own fix times); undefined until two fixes. */
  speedMps: number | undefined;
};

/** The `get_live_locations` answer (AdemuMLS PROTOCOL.md `get_live_locations`). */
export type LiveLocationsSnapshot = {
  shares: Array<{
    message_id: string;
    group_id: string;
    sender_user_id: string;
    until_ms: number;
    comment?: string;
    share_seq: number;
    lat: number;
    lon: number;
    accuracy_m?: number;
    fix_at_ms: number;
  }>;
  as_of: number;
};

/** The `received` fields this reads. */
export type ReceivedLike = {
  seq: number;
  group_id: string;
  message_id: string;
  protocol: string;
  body: unknown;
  lane: string;
  created_at_ms: number;
  sender: { user_id: string };
};

/** `location_ended` as the 1.0 client passes it (an unknown event's raw object, plus its seq). */
export type EndedLike = { seq: number; group_id: unknown; message_id: unknown; reason?: unknown };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validPoint = (lat: unknown, lon: unknown): boolean => finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const validSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const EARTH_RADIUS_M = 6_371_008.8;
/** Two fixes closer in time than this give no speed (GPS jitter would dominate). */
const SPEED_MIN_INTERVAL_S = 5;
/** Weight of the newest speed sample (an exponential average: minutes-away follows the recent pace). */
const SPEED_SMOOTHING = 0.5;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `moved`: a new position; `seeded`: a share that survived a reconnect, at the snapshot's position; `ended`. */
export type ShareChange = { kind: "moved" | "seeded" | "ended"; share: Share; reason?: string };

export class LiveLocations {
  readonly #now: () => number;
  readonly #shares = new Map<string, Share>();
  /** Events at or below this seq were already in the snapshot (`get_live_locations.as_of`). */
  #asOf = -1;
  readonly #listeners = new Set<(change: ShareChange) => void>();

  constructor(deps: { now: () => number }) {
    this.#now = deps.now;
  }

  /** Called on every applied position and every end, after the state changed. */
  onChange(listener: (change: ShareChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every live share, expired ones dropped first (each device on its own clock, as the phones do). */
  shares(): Share[] {
    this.#expire();
    return [...this.#shares.values()].map((s) => ({ ...s }));
  }

  get(id: string): Share | undefined {
    this.#expire();
    const s = this.#shares.get(normalizeId(id));
    return s ? { ...s } : undefined;
  }

  /**
   * At attach and after every reconnect, INSIDE the session's barrier (the ingress loop is held, so no event is
   * applied between the daemon's read and this): the daemon's shares replace the state, and every event at or below
   * `as_of` is then ignored here (only here — the message path, its acks and its watermark are untouched). A share
   * that was known and is gone ended while the session was away. A daemon without the query (before #941) has no
   * shares; a failed query leaves none (fail closed: nothing is answered from a stale state).
   */
  async seedFrom(client: { hello: { services?: readonly string[] }; request: <R>(op: string, params?: object) => Promise<R> }): Promise<"seeded" | "unsupported" | "failed"> {
    if (!(client.hello.services ?? []).includes("get_live_locations")) {
      this.seed({ shares: [], as_of: -1 }, "unsupported");
      return "unsupported";
    }
    try {
      this.seed(await client.request<LiveLocationsSnapshot>("get_live_locations"));
      return "seeded";
    } catch {
      this.seed({ shares: [], as_of: -1 }, "unavailable");
      return "failed";
    }
  }

  /** Replaces the state with the daemon's answer; events at or below `as_of` are then ignored. */
  seed(snapshot: LiveLocationsSnapshot, goneReason = "ended_while_away"): void {
    const before = new Map(this.#shares);
    this.#shares.clear();
    const now = this.#now();
    for (const s of snapshot.shares) {
      if (!validPoint(s.lat, s.lon) || !finite(s.until_ms) || !validSeq(s.share_seq)) continue;
      this.#shares.set(normalizeId(s.message_id), {
        id: normalizeId(s.message_id),
        groupId: normalizeId(s.group_id),
        sharerUserId: normalizeId(s.sender_user_id),
        untilMs: s.until_ms,
        seq: s.share_seq,
        lat: s.lat,
        lon: s.lon,
        accuracyM: finite(s.accuracy_m) ? s.accuracy_m : undefined,
        fixAtMs: finite(s.fix_at_ms) ? s.fix_at_ms : now,
        lastLane: "seeded",
        lastAtMs: now,
        speedMps: undefined,
      });
    }
    this.#asOf = validSeq(snapshot.as_of) ? snapshot.as_of : -1;
    for (const [id, old] of before) if (!this.#shares.has(id)) this.#emit({ kind: "ended", share: { ...old }, reason: goneReason });
    // A share that survived the outage may be somewhere else now: its watches and reports re-evaluate.
    for (const [id, s] of this.#shares) if (before.has(id)) this.#emit({ kind: "seeded", share: { ...s } });
    this.#expire();
  }

  /** Every `ademu.chat` `received` (any lane, any body): a START, a position or a delete of a START. */
  received(ev: ReceivedLike): void {
    if (ev.seq <= this.#asOf || ev.protocol !== PROTOCOL_CHAT || typeof ev.body !== "object" || ev.body === null) return;
    const b = ev.body as Record<string, unknown>;
    if (b.type === "location") this.#start(ev, b);
    else if (b.type === "live_location") this.#position(ev, b);
    else if (b.type === "delete" && typeof b.target_message_id === "string") this.#end(normalizeId(b.target_message_id), "deleted");
  }

  /** `location_ended`; returns the share it ended, if it was known. */
  ended(ev: EndedLike): Share | undefined {
    if (ev.seq <= this.#asOf || typeof ev.message_id !== "string") return undefined;
    return this.#end(normalizeId(ev.message_id), typeof ev.reason === "string" ? ev.reason : "ended");
  }

  /** The agent left (or was removed from) a group: its shares are no longer visible. */
  leftGroup(groupId: string): void {
    const g = normalizeId(groupId);
    for (const s of [...this.#shares.values()]) if (s.groupId === g) this.#end(s.id, "left");
  }

  #start(ev: ReceivedLike, b: Record<string, unknown>): void {
    const live = typeof b.live === "object" && b.live !== null ? (b.live as Record<string, unknown>) : undefined;
    if (!live || !finite(live.until_ms) || !validPoint(b.lat, b.lon)) return;
    const id = normalizeId(ev.message_id);
    this.#shares.set(id, {
      id,
      groupId: normalizeId(ev.group_id),
      sharerUserId: normalizeId(ev.sender.user_id),
      untilMs: live.until_ms,
      seq: 0,
      lat: b.lat as number,
      lon: b.lon as number,
      accuracyM: finite(b.accuracy_m) ? b.accuracy_m : undefined,
      fixAtMs: ev.created_at_ms,
      lastLane: "durable",
      lastAtMs: this.#now(),
      speedMps: undefined,
    });
    this.#expire();
  }

  #position(ev: ReceivedLike, b: Record<string, unknown>): void {
    if (typeof b.target_message_id !== "string" || !validSeq(b.seq) || !validPoint(b.lat, b.lon)) return;
    const share = this.#shares.get(normalizeId(b.target_message_id));
    if (!share || share.groupId !== normalizeId(ev.group_id) || share.sharerUserId !== normalizeId(ev.sender.user_id) || b.seq <= share.seq) return;
    const fixAtMs = finite(b.fix_at_ms) ? b.fix_at_ms : this.#now();
    const dtS = (fixAtMs - share.fixAtMs) / 1000;
    if (dtS >= SPEED_MIN_INTERVAL_S) {
      const inst = distanceMeters(share, { lat: b.lat as number, lon: b.lon as number }) / dtS;
      share.speedMps = share.speedMps === undefined ? inst : SPEED_SMOOTHING * inst + (1 - SPEED_SMOOTHING) * share.speedMps;
    }
    share.seq = b.seq;
    share.lat = b.lat as number;
    share.lon = b.lon as number;
    share.accuracyM = finite(b.accuracy_m) ? b.accuracy_m : undefined;
    share.fixAtMs = fixAtMs;
    if (finite(b.until_ms)) share.untilMs = b.until_ms;
    share.lastLane = ev.lane === "live" ? "live" : "durable";
    share.lastAtMs = this.#now();
    this.#emit({ kind: "moved", share: { ...share } });
  }

  #end(id: string, reason: string): Share | undefined {
    const share = this.#shares.get(id);
    if (!share) return undefined;
    this.#shares.delete(id);
    this.#emit({ kind: "ended", share: { ...share }, reason });
    return { ...share };
  }

  #expire(): void {
    const now = this.#now();
    for (const s of [...this.#shares.values()]) if (s.untilMs <= now) this.#end(s.id, "expired");
  }

  #emit(change: ShareChange): void {
    for (const l of this.#listeners) {
      try {
        l(change);
      } catch {
        // a listener's failure never breaks the state (it logs on its own side)
      }
    }
  }
}
