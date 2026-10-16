// The device channel's call surface (AdemuMLS #874, PROTOCOL.md §Calls; until that text lands the
// fixture `adc/adc-proto/tests/fixtures/ipc_v1.ndjson` is normative). A thin wrapper over the
// client's raw `request` with the exact shapes of the protocol, until `@ademu/adc-client` carries
// typed call methods (then this file shrinks to the parsers). Everything a peer controls is
// validated here; nothing in this file logs.
import type { AdcClient, DeviceEvent } from "@ademu/adc-client";
import { looksLikeId, normalizeId } from "../grammar.js";

/** The hello capabilities a seat needs before the plugin touches calls. */
export const CALL_CAPABILITIES = ["call_changed", "call_records", "set_call_handling", "answer_call", "decline_call", "end_call", "get_call"] as const;

/** The audio rate the plugin asks for: OpenClaw's meeting engines speak `pcm16-24khz`. */
export const CALL_AUDIO_RATE = 24_000;

export type CallState = "ringing" | "connecting" | "active" | "ended";
export type CallDirection = "incoming" | "outgoing";
export type CallParticipant = { user_id: string; username: string; kind: string };

/** A call as `get_call` lists it; `audio_ticket` only for a connecting or active call (fresh each time). */
export type CallEntry = {
  call_id: string;
  group_id: string;
  state: CallState;
  direction: CallDirection;
  media: string;
  participants: CallParticipant[];
  expires_at_ms?: number;
  audio_ticket?: string;
};

/** A `call_changed` live event (never replayed, never acked). */
export type CallChanged = Omit<CallEntry, "audio_ticket"> & { seq: number; outcome?: string };

export type CallOutcome = "answered" | "missed" | "declined" | "cancelled" | "no_answer" | "busy" | "failed";
export const CALL_OUTCOMES: readonly CallOutcome[] = ["answered", "missed", "declined", "cancelled", "no_answer", "busy", "failed"];

/** The `call` block of a `ct:"call"` record. */
export type CallRecord = {
  call_id: string;
  direction: CallDirection | undefined;
  /** Undefined = an outcome this plugin does not know (a newer daemon). */
  outcome: CallOutcome | undefined;
  media: string;
  duration_seconds: number | undefined;
};

const STATES: ReadonlySet<string> = new Set(["ringing", "connecting", "active", "ended"]);
const DIRECTIONS: ReadonlySet<string> = new Set(["incoming", "outgoing"]);
/** `adca1_` + 43 base64url characters as minted; a looser bound keeps the format the daemon's to change. */
const TICKET_RE = /^adca1_[A-Za-z0-9_-]{16,256}$/;

export function supportsCalls(capabilities: ReadonlySet<string>): boolean {
  return CALL_CAPABILITIES.every((c) => capabilities.has(c));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseParticipants(v: unknown): CallParticipant[] {
  if (!Array.isArray(v)) return [];
  const out: CallParticipant[] = [];
  for (const item of v) {
    const p = asRecord(item);
    if (!p || typeof p.user_id !== "string" || !looksLikeId(p.user_id)) continue;
    out.push({ user_id: normalizeId(p.user_id), username: typeof p.username === "string" ? p.username : "", kind: typeof p.kind === "string" ? p.kind : "" });
  }
  return out;
}

/** The fields an entry and an event share; undefined when a required one is missing or malformed. */
function parseCallCore(f: Record<string, unknown>): Omit<CallEntry, "audio_ticket"> | undefined {
  const { call_id, group_id, state, direction, media } = f;
  if (typeof call_id !== "string" || !looksLikeId(call_id)) return undefined;
  if (typeof group_id !== "string" || !looksLikeId(group_id)) return undefined;
  if (typeof state !== "string" || !STATES.has(state)) return undefined;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction)) return undefined;
  const expires = f.expires_at_ms;
  return {
    call_id: normalizeId(call_id),
    group_id: normalizeId(group_id),
    state: state as CallState,
    direction: direction as CallDirection,
    media: media === "video" ? "video" : "audio",
    participants: parseParticipants(f.participants),
    ...(typeof expires === "number" && Number.isSafeInteger(expires) ? { expires_at_ms: expires } : {}),
  };
}

export function parseCallEntry(v: unknown): CallEntry | undefined {
  const f = asRecord(v);
  if (!f) return undefined;
  const core = parseCallCore(f);
  if (!core) return undefined;
  const ticket = f.audio_ticket;
  return { ...core, ...(typeof ticket === "string" && TICKET_RE.test(ticket) ? { audio_ticket: ticket } : {}) };
}

/**
 * A `call_changed` frame, whichever way the client surfaced it: a client that knows the event yields
 * it flat (`known: true`); `@ademu/adc-client` ≤ 0.7.0 does not, and yields it as an unknown event
 * with the wire object in `raw`. Undefined = not a call event, or a malformed one.
 */
export function parseCallChanged(ev: DeviceEvent): CallChanged | undefined {
  if (String(ev.event) !== "call_changed") return undefined;
  const f = ev.known ? (ev as unknown as Record<string, unknown>) : asRecord((ev as { raw?: unknown }).raw);
  if (!f) return undefined;
  const core = parseCallCore(f);
  if (!core) return undefined;
  const outcome = f.outcome;
  return { ...core, seq: ev.seq, ...(typeof outcome === "string" ? { outcome } : {}) };
}

/** The `call` block of a `message_received ct:"call"`; undefined when it is missing or malformed. */
export function parseCallRecord(v: unknown): CallRecord | undefined {
  const f = asRecord(v);
  if (!f || typeof f.call_id !== "string" || !looksLikeId(f.call_id)) return undefined;
  const duration = f.duration_seconds;
  return {
    call_id: normalizeId(f.call_id),
    direction: f.direction === "incoming" || f.direction === "outgoing" ? f.direction : undefined,
    outcome: CALL_OUTCOMES.find((o) => o === f.outcome),
    media: f.media === "video" ? "video" : "audio",
    duration_seconds: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : undefined,
  };
}

/** The daemon's `error.code` of a failed request, when it sent one (RequestError carries it). */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export class CallReplyError extends Error {
  constructor(readonly op: string) {
    super(`malformed ${op} reply`);
    this.name = "CallReplyError";
  }
}

/** The request slice of the client the call surface uses. */
export type CallRequester = Pick<AdcClient, "request">;

/** `set_call_handling`: this seat takes calls at `rate`. Rejects with `invalid_rate` / `call_helper_unavailable`. */
export async function setCallHandling(client: CallRequester, rate: number = CALL_AUDIO_RATE): Promise<{ rate: number }> {
  const res = asRecord(await client.request<unknown>("set_call_handling", { audio: { rate } }));
  if (!res || typeof res.rate !== "number") throw new CallReplyError("set_call_handling");
  return { rate: res.rate };
}

/** `answer_call`: the ticket for the audio connection. Rejects with `unknown_call` / `call_helper_unavailable`. */
export async function answerCall(client: CallRequester, callId: string): Promise<{ audio_ticket: string }> {
  const res = asRecord(await client.request<unknown>("answer_call", { call_id: callId }));
  if (!res || typeof res.audio_ticket !== "string" || !TICKET_RE.test(res.audio_ticket)) throw new CallReplyError("answer_call");
  return { audio_ticket: res.audio_ticket };
}

/** `decline_call` (on an answered call the daemon treats it as `end_call`). */
export async function declineCall(client: CallRequester, callId: string): Promise<void> {
  await client.request<unknown>("decline_call", { call_id: callId });
}

/** `end_call` (on a ringing call the daemon treats it as `decline_call`). */
export async function endCall(client: CallRequester, callId: string): Promise<void> {
  await client.request<unknown>("end_call", { call_id: callId });
}

/** `get_call`: the device's current calls (empty, or exactly one in v1). Malformed entries are dropped. */
export async function getCall(client: CallRequester): Promise<CallEntry[]> {
  const res = asRecord(await client.request<unknown>("get_call"));
  if (!res || !Array.isArray(res.calls)) throw new CallReplyError("get_call");
  return res.calls.map(parseCallEntry).filter((c): c is CallEntry => c !== undefined);
}
