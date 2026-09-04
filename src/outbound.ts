// Outbound (plan T8): the `message` adapter (durable-final text, ack policy `after_agent_dispatch`)
// and the `messaging` block (target grammar). Replies go through the account's LIVE session client
// — the one `startAccount` opened — via a small registry keyed by accountId; there is no second
// connection for outbound (a device has one seat). Long texts are split at TEXT_CHUNK_LIMIT (V7: no
// daemon body cap exists; 1 MiB line ceiling; 4000 chars is the conservative default), every chunk
// is one `send_text` reported through `onDeliveryResult`, and a failure after the first accepted
// chunk throws `createChannelPartialDeliveryError` so core never re-sends delivered chunks.
import type { AdcClient, SendTextResult } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { buildChannelOutboundSessionRoute, type ChannelOutboundSessionRouteParams } from "openclaw/plugin-sdk/channel-core";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
  type ChannelMessageSendTextContext,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { CHANNEL_ID } from "./config.js";
import { looksLikeId, normalizeTarget, type ConversationKind } from "./grammar.js";

/** Conservative per-message ceiling (V7). Not a config knob in v1. */
export const TEXT_CHUNK_LIMIT = 4000;

export class AccountNotRunningError extends Error {
  constructor(readonly accountId: string) {
    super(`Ademú account "${accountId}" is not running; start the channel before sending.`);
    this.name = "AccountNotRunningError";
  }
}

/** The subset of the session client outbound needs (the fake in tests implements it too). */
export type OutboundClient = Pick<AdcClient, "sendText" | "sendReaction">;

export type LiveAccount = {
  client: OutboundClient;
  /** Conversation kind lookup from the session's members cache (undefined = unknown). */
  conversationKind?: (groupId: string) => ConversationKind | undefined;
};

const live = new Map<string, LiveAccount>();

export function registerLiveAccount(accountId: string, account: LiveAccount): void {
  live.set(accountId, account);
}

/** Removes the registration only if it is still the same object (a successor may have replaced it). */
export function unregisterLiveAccount(accountId: string, account: LiveAccount): void {
  if (live.get(accountId) === account) live.delete(accountId);
}

export function getLiveAccount(accountId: string): LiveAccount {
  const entry = live.get(accountId);
  if (!entry) throw new AccountNotRunningError(accountId);
  return entry;
}

export function resetLiveAccountsForTests(): void {
  live.clear();
}

/** The account an outbound call targets: explicit accountId, else the only running one. */
export function resolveOutboundAccountId(accountId: string | null | undefined): string {
  if (accountId) return accountId;
  if (live.size === 1) return [...live.keys()][0]!;
  throw new AccountNotRunningError(accountId ?? "default");
}

export type SentChunk = { group_id: string; result: SendTextResult };

export function createAdemuReceipt(chunks: readonly SentChunk[], sentAt: number = Date.now()): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    results: chunks.map((chunk) => ({
      channel: CHANNEL_ID,
      messageId: chunk.result.message_id,
      conversationId: chunk.group_id,
      chatId: chunk.group_id,
      meta: { status: chunk.result.status },
    })),
    kind: "text",
    sentAt,
  });
}

function sendResultFor(chunks: readonly SentChunk[]): ChannelMessageSendResult {
  const receipt = createAdemuReceipt(chunks);
  const first = chunks[0];
  return {
    receipt,
    ...(first ? { messageId: first.result.message_id, target: { kind: "conversation", id: first.group_id } } : {}),
  };
}

/**
 * Sends `text` into `groupId` as one or more `send_text` calls. A failure after ≥1 accepted chunk
 * is surfaced as a partial-delivery error carrying the accepted receipts (SMS precedent).
 */
export async function sendAdemuText(params: {
  client: OutboundClient;
  groupId: string;
  text: string;
  signal?: AbortSignal | undefined;
  onDeliveryResult?: ((result: ChannelMessageSendResult) => Promise<void> | void) | undefined;
}): Promise<SentChunk[]> {
  const pieces = chunkTextForOutbound(params.text, TEXT_CHUNK_LIMIT).filter((piece) => piece.trim().length > 0);
  if (pieces.length === 0) throw new Error("Ademú send requires non-empty text.");
  const sent: SentChunk[] = [];
  try {
    for (const body of pieces) {
      params.signal?.throwIfAborted();
      const result = await params.client.sendText({ group_id: params.groupId, body });
      const chunk = { group_id: params.groupId, result };
      sent.push(chunk);
      await params.onDeliveryResult?.(sendResultFor([chunk]));
    }
  } catch (error) {
    if (sent.length === 0) throw error;
    throw createChannelPartialDeliveryError(error, {
      messageIds: sent.map((chunk) => chunk.result.message_id),
      receipt: createAdemuReceipt(sent),
      visibleReplySent: true,
    });
  }
  return sent;
}

/** Resolves an outbound `to` into a conversation id (UUID) or throws a clear error. */
export function resolveConversationTarget(to: string): string {
  const id = normalizeTarget(to);
  if (!id) throw new Error(`Ademú targets are conversation ids (UUID), optionally prefixed "ademu:"; got "${to.trim()}".`);
  return id;
}

async function sendText(ctx: ChannelMessageSendTextContext<OpenClawConfig>): Promise<ChannelMessageSendResult> {
  const accountId = resolveOutboundAccountId(ctx.accountId);
  const { client } = getLiveAccount(accountId);
  const groupId = resolveConversationTarget(ctx.to);
  const chunks = await sendAdemuText({
    client,
    groupId,
    text: ctx.text,
    signal: ctx.signal,
    onDeliveryResult: ctx.onDeliveryResult,
  });
  return sendResultFor(chunks);
}

export const ademuMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: { capabilities: { text: true } },
  send: { text: sendText },
  receive: {
    // Rider R4: "After the agent run is dispatched" — core's `onAdopted` is our ack point (§2 R2b).
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_agent_dispatch"],
  },
});

/** Direct vs group for an explicit target: from the running account's members cache, else group. */
export function inferConversationKind(to: string, accountId?: string | null): ConversationKind | undefined {
  const id = normalizeTarget(to);
  if (!id) return undefined;
  const entries = accountId ? [live.get(accountId)] : [...live.values()];
  for (const entry of entries) {
    const kind = entry?.conversationKind?.(id);
    if (kind) return kind;
  }
  return "group";
}

export function resolveAdemuOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const id = normalizeTarget(params.resolvedTarget?.to ?? params.target);
  if (!id) return null;
  const kind = inferConversationKind(id, params.accountId) ?? "group";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId ?? null,
    recipientSessionExact: true,
    peer: { kind, id },
    chatType: kind,
    from: `${CHANNEL_ID}:${id}`,
    to: `${CHANNEL_ID}:${id}`,
  });
}

export const ademuMessaging: ChannelMessagingAdapter = {
  targetPrefixes: [CHANNEL_ID],
  targetIdComparison: "lowercase",
  normalizeTarget: (raw) => normalizeTarget(raw),
  inferTargetChatType: ({ to }) => inferConversationKind(to),
  resolveOutboundSessionRoute: (params) => resolveAdemuOutboundSessionRoute(params),
  targetResolver: {
    looksLikeId: (raw) => looksLikeId(raw.replace(/^ademu:/i, "")),
    hint: "<conversation-id>",
  },
};
