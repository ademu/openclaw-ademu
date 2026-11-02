// The sender gate every inbound event passes before it is routed — a message (ingress.ts) and a
// reaction (reactions.ts) alike, so the two can never decide differently. The conversation's shape
// comes from its members (an unknown sender costs one refresh); access is the decision-only resolve:
// a stranger's two-person room is a DM the allowlist drops, and in a room membership is the gate.
import type { MemberEntry } from "@ademu/adc-client";
import { classifyConversation, type ConversationShape } from "../grammar.js";
import { resolveMessageAccess, type MessageAccessInput } from "../security.js";
import type { Session } from "./session.js";

export type SenderGate = {
  members: MemberEntry[];
  shape: ConversationShape;
  access: Awaited<ReturnType<typeof resolveMessageAccess>>;
};

export async function gateSender(params: {
  members: Session["members"];
  resolver: MessageAccessInput["resolver"];
  account: { agentUserId: string; ownerUserId: string };
  groupId: string;
  senderUserId: string;
  /** True when the body looks like a control command; a reaction never does. */
  commandRequested: boolean;
}): Promise<SenderGate> {
  const members = await params.members.getWithSender(params.groupId, params.senderUserId);
  const shape = classifyConversation({ members, agentUserId: params.account.agentUserId, ownerUserId: params.account.ownerUserId });
  const access = await resolveMessageAccess({
    resolver: params.resolver,
    senderUserId: params.senderUserId,
    ownerUserId: params.account.ownerUserId,
    conversation: { kind: shape.kind, id: params.groupId },
    commandRequested: params.commandRequested,
  });
  return { members, shape, access };
}
