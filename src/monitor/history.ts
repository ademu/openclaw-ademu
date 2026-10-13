// Room history for mention-gated rooms: the messages a room let through without addressing the agent
// are kept here, and the agent's next turn in that room gets them as `inboundHistory` (core renders
// "Chat history since last reply"). Per lease and in memory, like the refusal notes: a skipped
// message is already acked, so a restart loses what the agent had not read yet.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { HistoryEntry } from "openclaw/plugin-sdk/core";
import { normalizeTarget } from "../grammar.js";

/** OpenClaw's own group history default (`DEFAULT_GROUP_HISTORY_LIMIT`); core shows the last 20. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** Skipped room messages per conversation (normalized group id), oldest first. */
export type RoomHistory = Map<string, HistoryEntry[]>;

function keyOf(groupId: string): string {
  return normalizeTarget(groupId) ?? groupId;
}

/**
 * The room history limit for an account: `channels.ademu.accounts.<id>.historyLimit`, then
 * `channels.ademu.historyLimit` (merged into the account), then `messages.groupChat.historyLimit`,
 * then 50. 0 turns room history off.
 */
export function resolveHistoryLimit(cfg: OpenClawConfig, account: { historyLimit?: number | undefined }): number {
  const limit = account.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  return Math.max(0, Math.floor(limit));
}

/**
 * Keeps a skipped message for the conversation's next turn, dropping the oldest past `limit`. A missing
 * limit is the default, so the buffer is always bounded.
 */
export function recordSkipped(history: RoomHistory | undefined, groupId: string, entry: HistoryEntry, limit: number = DEFAULT_HISTORY_LIMIT): void {
  if (!history || limit <= 0) return;
  const id = keyOf(groupId);
  history.set(id, [...(history.get(id) ?? []), entry].slice(-limit));
}

/**
 * The conversation's kept messages. Reading them does not clear them; `consume` does, once the turn
 * is adopted, and removes only what was read.
 */
export function peekRoomHistory(history: RoomHistory | undefined, groupId: string): { entries: HistoryEntry[]; consume: () => void } | undefined {
  const id = keyOf(groupId);
  const read = history?.get(id);
  if (!history || !read?.length) return undefined;
  const taken = [...read];
  return {
    entries: taken,
    consume: () => {
      const left = (history.get(id) ?? []).filter((e) => !taken.includes(e));
      if (left.length > 0) history.set(id, left);
      else history.delete(id);
    },
  };
}

/** Drops what a conversation kept: the agent left it, so a later re-add starts with no old chatter. */
export function forgetRoomHistory(history: RoomHistory | undefined, groupId: string): void {
  history?.delete(keyOf(groupId));
}
