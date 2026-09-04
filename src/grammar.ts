// Session grammar (design entry §2): an Ademú conversation is one `group_id` (UUID) — no threads.
// Direct vs group is decided by MEMBERSHIP, never by a flag: a conversation whose members are exactly
// {owner, agent} is direct; anything else is a group (so a stranger's two-member room is a DM from a
// non-allowlisted sender, and a room with third parties gets group manners).
import type { MemberEntry } from "@ademu/adc-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ademú ids are UUIDs; they compare case-insensitively (`targetIdComparison: "lowercase"`). */
export function looksLikeId(raw: string): boolean {
  return UUID_RE.test(raw.trim());
}

export function normalizeId(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Explicit `message` tool targets may carry the channel prefix (`ademu:<uuid>`). */
export function normalizeTarget(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^ademu:/i, "");
  return looksLikeId(trimmed) ? normalizeId(trimmed) : undefined;
}

export type ConversationKind = "direct" | "group";

export type ConversationShape = {
  kind: ConversationKind;
  /** Members other than the agent itself. */
  others: MemberEntry[];
  /** True when every non-agent member is the owner (the one-to-one case). */
  ownerOnly: boolean;
};

/**
 * Classifies a conversation from its member list. `direct` iff the members are exactly the owner
 * and the agent. An empty or unknown member list is treated as a group (the conservative side:
 * group manners require the agent to be addressed).
 */
export function classifyConversation(params: {
  members: readonly MemberEntry[];
  agentUserId: string;
  ownerUserId: string;
}): ConversationShape {
  const others = params.members.filter((m) => normalizeId(m.user_id) !== normalizeId(params.agentUserId));
  const ownerOnly = others.length === 1 && normalizeId(others[0]!.user_id) === normalizeId(params.ownerUserId);
  return { kind: ownerOnly ? "direct" : "group", others, ownerOnly };
}

/** Human-visible label for a conversation (used in context and status), never the raw ids. */
export function describeConversation(shape: ConversationShape, agentDisplayName: string): string {
  if (shape.kind === "direct") return `Direct chat with ${shape.others[0]?.display_name || shape.others[0]?.username || "owner"}`;
  const names = shape.others.map((m) => displayNameOf(m)).filter(Boolean);
  return names.length ? `Room: ${names.join(", ")} + ${agentDisplayName}` : `Room with ${agentDisplayName}`;
}

/** Display name with the 🤖 marker for agent members (Ademú `kind === "agent"`). */
export function displayNameOf(member: Pick<MemberEntry, "display_name" | "username" | "kind">): string {
  const base = member.display_name?.trim() || member.username?.trim() || "";
  if (!base) return "";
  return member.kind === "agent" ? `🤖 ${base}` : base;
}
