// Who the agent answers (openclaw-ademu#30 §5): the caller is judged exactly as a sender of text in
// that conversation would be — the same sender gate (`sender-gate.ts`: membership shape, DM allowlist
// = [owner], rooms open by membership) and the same room manners. A voice call carries no name to
// detect, so in a room that requires addressing only the owner (always heard) gets an answer.
// Declining is visible to the caller (a durable `declined` 1-1, a sealed decline in a group); NOT
// taking calls at all is not declining — that is not sending `set_call_handling` (`config.ts`).
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeId } from "../grammar.js";
import { gateSender } from "../monitor/sender-gate.js";
import type { Session } from "../monitor/session.js";
import { CHANNEL_ID } from "../config.js";
import { resolveMessageAccess, resolveRequireMention, type MessageAccessInput } from "../security.js";
import type { CallChanged } from "./protocol.js";

export type CallAnswerMode = "allowed" | "none";

export type CallDecision =
  | { answer: true; kind: "direct" | "group" }
  | { answer: false; reason: "answer_none" | "no_caller" | "inactive" | "access" | "requires_mention" | "self" };

export async function decideCall(params: {
  call: Pick<CallChanged, "call_id" | "group_id" | "participants">;
  mode: CallAnswerMode;
  cfg: OpenClawConfig;
  accountId: string;
  members: Session["members"];
  resolver: MessageAccessInput["resolver"];
  account: { agentUserId: string; ownerUserId: string };
  resolveAgentRoute: (input: Record<string, unknown>) => { agentId: string; sessionKey: string };
}): Promise<CallDecision> {
  if (params.mode === "none") return { answer: false, reason: "answer_none" };
  const caller = params.call.participants[0];
  if (!caller) return { answer: false, reason: "no_caller" };
  if (normalizeId(caller.user_id) === normalizeId(params.account.agentUserId)) return { answer: false, reason: "self" };
  // A conversation the agent was removed from: nothing it says there would arrive.
  if (params.members.isInactive(params.call.group_id)) return { answer: false, reason: "inactive" };
  const { shape, access } = await gateSender({
    members: params.members,
    resolver: params.resolver,
    account: params.account,
    groupId: params.call.group_id,
    senderUserId: caller.user_id,
    commandRequested: false,
  });
  if (!access.senderAccess.allowed) return { answer: false, reason: "access" };
  // The context-bound resolve a message gets once routed (ingress step 6): it can still drop a sender.
  const route = params.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    peer: { kind: shape.kind, id: normalizeId(params.call.group_id) },
  });
  const bound = await resolveMessageAccess({
    resolver: params.resolver,
    senderUserId: caller.user_id,
    ownerUserId: params.account.ownerUserId,
    conversation: { kind: shape.kind, id: params.call.group_id },
    commandRequested: false,
    contextBinding: { agentId: route.agentId, sessionKey: route.sessionKey, messageId: params.call.call_id, inboundEventKind: "user_request" },
  });
  if (!bound.senderAccess.allowed) return { answer: false, reason: "access" };
  if (shape.kind === "group") {
    const isOwner = normalizeId(caller.user_id) === normalizeId(params.account.ownerUserId);
    if (!isOwner && resolveRequireMention({ cfg: params.cfg, groupId: params.call.group_id, accountId: params.accountId })) {
      return { answer: false, reason: "requires_mention" };
    }
  }
  return { answer: true, kind: shape.kind };
}
