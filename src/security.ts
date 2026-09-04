// Security defaults (design decision 5, plan §2 V3/V4/V5, T4):
//   - DMs: allowlist = [owner_user_id], learned at runtime from the daemon's `get_self` and passed to
//     OpenClaw's ingress resolver per message (Tlon's model — `resolveStableChannelMessageIngress`
//     with a runtime `allowFrom`, never a static config list).
//   - Rooms: membership is the gate (`groupPolicy: "open"` — a human added the agent); manners come
//     from the mention decision: the owner is always heard, guests only when they address the agent.
//   - Sender identity is MLS-authenticated end to end, so the identity field is declared `verified`
//     with participant provenance (domain ademu.com, id kind user_id).
//   - Command authorization rides the same resolver (owner = command owner) and is projected into
//     the inbound context (Codex R3 #8; SMS precedent).
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  resolveInboundMentionDecision,
  type InboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ChannelIngressContextBinding,
  type ChannelIngressResolver,
  type ResolvedChannelMessageIngress,
  type StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { CHANNEL_ID } from "./config.js";
import { looksLikeId, normalizeId, type ConversationKind } from "./grammar.js";
import type { SenderRole } from "./roles.js";

export const IDENTITY_KEY = "user-id";

/** Ademú sender identity: the MLS-authenticated `user_id` (UUID), compared case-insensitively. */
export const ademuIngressIdentity = {
  key: IDENTITY_KEY,
  kind: "stable-id",
  normalize: (value: string) => (looksLikeId(value) ? normalizeId(value) : undefined),
  authentication: "verified",
  sensitivity: "normal",
  isWildcardEntry: () => false,
  entryIdPrefix: "ademu-entry",
  resolveParticipant: (subject) =>
    subject.stableId != null && looksLikeId(String(subject.stableId))
      ? { domain: "ademu.com", idKind: "user_id", id: normalizeId(String(subject.stableId)) }
      : undefined,
} satisfies StableChannelIngressIdentityParams;

export function createAdemuIngressResolver(params: { accountId: string; cfg: OpenClawConfig }): ChannelIngressResolver {
  const accessGroups = (params.cfg as { accessGroups?: unknown }).accessGroups;
  return createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: params.accountId,
    identity: defineStableChannelIngressIdentity(ademuIngressIdentity),
    cfg: accessGroups ? ({ accessGroups } as never) : null,
    defaultDmPolicy: "allowlist",
    defaultGroupPolicy: "open",
  });
}

export type MessageAccessInput = {
  resolver: ChannelIngressResolver;
  senderUserId: string;
  ownerUserId: string | undefined;
  conversation: { kind: ConversationKind; id: string };
  /** True when the body looks like a control command (host: `shouldComputeCommandAuthorized`). */
  commandRequested: boolean;
  /** Omit for the decision-only pre-check; supply for the final, context-bound resolve. */
  contextBinding?: ChannelIngressContextBinding;
};

/**
 * One resolver call for one message. DMs: allowlist = [owner]. Groups: open (membership gates).
 * Commands: the owner is the command owner. Call once WITHOUT `contextBinding` before routing
 * (cheap drop of strangers), then again WITH it once the route is known (the result that enters
 * `buildContext` must be bound — `admission-evidence.ts` rejects an unbound handoff).
 */
export async function resolveMessageAccess(input: MessageAccessInput): Promise<ResolvedChannelMessageIngress> {
  const allowFrom = input.ownerUserId ? [normalizeId(input.ownerUserId)] : [];
  return input.resolver.message({
    subject: {
      stableId: normalizeId(input.senderUserId),
      authentication: { [IDENTITY_KEY]: "verified" },
    },
    conversation: { kind: input.conversation.kind, id: normalizeId(input.conversation.id) },
    ...(input.contextBinding ? { contextBinding: input.contextBinding } : {}),
    allowFrom,
    groupAllowFrom: allowFrom,
    dmPolicy: "allowlist",
    groupPolicy: "open",
    command: input.commandRequested
      ? { modeWhenAccessGroupsOff: "configured", commandOwnerAllowFrom: allowFrom, groupOwnerAllowFrom: "configured" }
      : false,
  });
}

// ---------------------------------------------------------------------------------------------
// Mentions (rooms): Ademú has no mention structure, so "addressed" = a name appears in the text.
// ---------------------------------------------------------------------------------------------

/** Names that count as addressing the agent: display name, username, agent name, configured aliases. */
export function agentNames(params: {
  displayName?: string | undefined;
  username?: string | undefined;
  agentName?: string | undefined;
  aliases?: readonly string[] | undefined;
}): string[] {
  const all = [params.displayName, params.username, params.agentName, ...(params.aliases ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const name = raw?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive, Unicode-aware name match (so "Irisa" does not address "Iris"). */
export function textAddresses(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`, "iu");
    return re.test(text);
  });
}

/** OpenClaw's own identity-derived mention patterns for the routed agent (`agents.entries.<id>.identity`). */
export function openclawMentionRegexes(cfg: OpenClawConfig, agentId: string | undefined): RegExp[] {
  return buildMentionRegexes(cfg, agentId);
}

/**
 * The plugin-supplied `wasMentioned` fact: the owner is ALWAYS considered to have addressed the
 * agent (decision 5 — "owner always heard, guests when addressed"); anyone else only when a known
 * name appears in the text or OpenClaw's identity patterns match.
 */
export function computeWasMentioned(params: {
  text: string;
  senderRole: SenderRole;
  names: readonly string[];
  mentionRegexes?: RegExp[];
}): boolean {
  if (params.senderRole === "owner") return true;
  if (textAddresses(params.text, params.names)) return true;
  return params.mentionRegexes ? matchesMentionPatterns(params.text, params.mentionRegexes) : false;
}

export function resolveRequireMention(params: { cfg: OpenClawConfig; groupId: string; accountId: string }): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: CHANNEL_ID as never,
    groupId: normalizeId(params.groupId),
    accountId: params.accountId,
    groupIdCaseInsensitive: true,
  });
}

/**
 * Mention gating applies to ROOMS only: the SDK's decision core does not consult `isGroup` for
 * `shouldSkip` (`mention-gating.ts:157-181`; Signal applies the skip only when `isGroup`), so a
 * direct conversation is never skipped here.
 */
export function decideMention(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}): InboundMentionDecision {
  const decision = resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned: params.wasMentioned,
      hasAnyMention: params.wasMentioned,
      implicitMentionKinds: [],
    },
    policy: {
      isGroup: params.isGroup,
      requireMention: params.requireMention,
      allowTextCommands: true,
      hasControlCommand: params.hasControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });
  return params.isGroup ? decision : { ...decision, shouldSkip: false };
}
