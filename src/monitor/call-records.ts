// Call records (AdemuMLS #874): a finished call arrives as a durable `message_received` with
// `ct:"call"`, `body:""`, `message_id` = the call id and a `call` block (direction, outcome, media,
// duration). It is history, NEVER a turn: ONE line queued on the conversation's session through the
// host's system-event queue (the reactions pattern, `reactions.ts`), read by the agent at its next
// turn there — then the record is acked like any message. The sender gate is a message's: a record
// from a caller the agent would not hear in text is acked unseen. The agent's own (outgoing) calls
// skip the gate; the line still lands in the conversation it called.
//
// Unlike a reaction this runs IN the loop: a record is durable, so its ack waits for the line to be
// queued (or refused); a members/route failure halts like a message's and the restart replays it.
import type { MessageReceivedEvent } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { CallRecord } from "../calls/protocol.js";
import { CHANNEL_ID } from "../config.js";
import { classifyConversation, displayNameOf, normalizeId } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import type { MessageAccessInput } from "../security.js";
import { escapeRuntimeContextDelimiters } from "./content.js";
import type { RuntimeSystemSurface } from "./reactions.js";
import { gateSender } from "./sender-gate.js";
import type { Session } from "./session.js";

export type CallRecordParams = {
  accountId: string;
  cfg: OpenClawConfig;
  session: Session;
  resolver: MessageAccessInput["resolver"];
  account: { agentUserId: string; ownerUserId: string };
  resolveAgentRoute: (input: Record<string, unknown>) => { sessionKey: string };
  system: RuntimeSystemSurface;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

/** Peer-controlled text on one line, with OpenClaw's runtime-context delimiters escaped. */
function oneLine(text: string): string {
  return escapeRuntimeContextDelimiters(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function callRecordLine(record: CallRecord | undefined, params: { messageId: string; outgoing: boolean; who: string }): string {
  const callId = oneLine(normalizeId(record?.call_id ?? params.messageId));
  if (!record) return strings.calls.unreadable(callId);
  const outcome = record.outcome ? strings.calls.outcomes[record.outcome] : strings.calls.ended;
  const duration = record.outcome === "answered" && record.duration_seconds !== undefined ? strings.calls.duration(record.duration_seconds) : undefined;
  return strings.calls.line({
    outgoing: record.direction === "outgoing" || params.outgoing,
    who: params.who,
    outcome,
    video: record.media === "video",
    duration,
    callId,
  });
}

/** Decides and queues one record's line; resolves when the record may be acked. */
export async function deliverCallRecord(
  params: CallRecordParams,
  ev: MessageReceivedEvent & { seq: number; call?: unknown },
  record: CallRecord | undefined,
): Promise<void> {
  const { seq } = ev;
  const outgoing = normalizeId(ev.sender_user_id) === normalizeId(params.account.agentUserId);
  let kind: "direct" | "group";
  let who: string;
  if (outgoing) {
    const members = await params.session.members.get(ev.group_id);
    kind = classifyConversation({ members, agentUserId: params.account.agentUserId, ownerUserId: params.account.ownerUserId }).kind;
    who = "";
  } else {
    const { members, shape, access } = await gateSender({
      members: params.session.members,
      resolver: params.resolver,
      account: params.account,
      groupId: ev.group_id,
      senderUserId: ev.sender_user_id,
      commandRequested: false,
    });
    if (!access.senderAccess.allowed) {
      params.log("call_record_skipped", { seq, reason: "access" });
      return;
    }
    kind = shape.kind;
    const caller = members.find((m) => normalizeId(m.user_id) === normalizeId(ev.sender_user_id));
    who = oneLine((caller && displayNameOf(caller)) || ev.sender_username || "") || strings.calls.someone;
  }
  const route = params.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind, id: normalizeId(ev.group_id) },
  });
  const text = callRecordLine(record, { messageId: ev.message_id, outgoing, who });
  try {
    const queued = params.system.enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      // One key per call: a replayed record (restart before its ack) is not queued twice.
      contextKey: `${CHANNEL_ID}:call:${normalizeId(record?.call_id ?? ev.message_id)}`,
    });
    params.log("call_record_queued", { seq, deduped: !queued });
  } catch (err) {
    // The host's queue is not durable either: a failure here loses one history line, never a halt.
    params.log("call_record_failed", { seq, errorClass: err instanceof Error ? err.name : typeof err });
  }
}
