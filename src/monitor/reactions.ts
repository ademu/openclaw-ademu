// Reactions: a `reaction_changed` live event becomes ONE line in the conversation's session, queued on
// the host's system-event queue (`api.runtime.system.enqueueSystemEvent`). Nothing starts a turn and
// nothing asks the agent to answer: core drains the queue into the agent's NEXT turn there as
// `System: [ts] <line>` (the Telegram/Slack/Matrix pattern). The event is live-only, so it is never
// acked (an ack carries read-receipt weight), and a failure here is logged and dropped — a reaction
// never halts ingress. The loop decides a reaction like a message (membership, sender gate, route,
// behind the reconnect barrier); only the target lookup and the line run on a sequential queue beside
// it, so a daemon slow to answer `get_message` delays later reactions, never messages. Neither the daemon's event nor the host's queue is durable: a reaction that
// arrives while detached, or before a gateway restart drains it, is lost.
import type { MemberEntry, ReactionChangedEvent } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { CHANNEL_ID } from "../config.js";
import { displayNameOf, normalizeId } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import type { MessageAccessInput } from "../security.js";
import { escapeRuntimeContextDelimiters } from "./content.js";
import { gateSender } from "./sender-gate.js";
import type { Session } from "./session.js";

export type ReactionNotificationMode = "off" | "own" | "all";
export const DEFAULT_REACTION_NOTIFICATIONS: ReactionNotificationMode = "all";

/** The slice of `api.runtime.system` reactions use (host-injected). */
export type RuntimeSystemSurface = {
  enqueueSystemEvent: (text: string, options: { sessionKey: string; contextKey?: string }) => boolean;
};

/**
 * Admitted reactions not yet delivered (the one being looked up plus those waiting), per account; past
 * it the newest is skipped (logged). The host keeps the same number of queued lines per session
 * (`MAX_EVENTS` in core's system-event queue).
 */
export const MAX_PENDING_REACTIONS = 20;

/** How much of the reacted-to message the line quotes (characters, after escaping). */
export const REACTION_QUOTE_MAX = 80;

export type ReactionParams = {
  accountId: string;
  cfg: OpenClawConfig;
  mode: ReactionNotificationMode;
  session: Session;
  resolver: MessageAccessInput["resolver"];
  account: { agentUserId: string; ownerUserId: string };
  resolveAgentRoute: (input: Record<string, unknown>) => { sessionKey: string };
  system: RuntimeSystemSurface;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

type SkipReason = "off" | "self" | "access" | "not_own" | "lookup_failed" | "backlog" | "stopped";

/** Peer-controlled text on one line, with OpenClaw's runtime-context delimiters escaped (content.ts). */
function oneLine(text: string): string {
  return escapeRuntimeContextDelimiters(text).replace(/\s+/g, " ").trim();
}

function quoteOf(body: string): string | undefined {
  const chars = Array.from(oneLine(body));
  if (chars.length === 0) return undefined;
  return chars.length > REACTION_QUOTE_MAX ? `${chars.slice(0, REACTION_QUOTE_MAX).join("")}…` : chars.join("");
}

/** What the loop decided about a reaction; the rest (the target lookup, the line) runs beside it. */
type AdmittedReaction = {
  ev: ReactionChangedEvent & { seq: number };
  /** Members as the loop saw them when it admitted the reaction (names for the line). */
  members: readonly MemberEntry[];
  sessionKey: string;
};

export type ReactionQueue = {
  /**
   * Runs IN the ingress loop, after its reconnect barrier, like a message: mode, own echo, membership
   * and the sender gate, and the route. A slow members refresh holds the loop exactly as a message's
   * would. The admitted reaction then waits its turn beside the loop for the target lookup and the line.
   */
  admit: (ev: ReactionChangedEvent & { seq: number }) => Promise<void>;
  /** Nothing more is queued, and no line is queued after this (the account is stopping). */
  stop: () => void;
};

export function createReactionQueue(params: ReactionParams): ReactionQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let stopped = false;
  // A reaction's own log line must not be what halts ingress (a host logger that throws).
  const logSafe = (event: string, fields: Record<string, string | number | boolean>) => {
    try {
      params.log(event, fields);
    } catch {
      // Nothing to report it to.
    }
  };
  const skip = (seq: number, reason: SkipReason) => logSafe("reaction_skipped", { seq, reason });
  const failed = (seq: number, err: unknown) => logSafe("reaction_failed", { seq, errorClass: err instanceof Error ? err.name : typeof err });

  const deliver = async ({ ev, members, sessionKey }: AdmittedReaction): Promise<void> => {
    const { seq } = ev;
    try {
      let target: Awaited<ReturnType<Session["client"]["getMessage"]>> | undefined;
      try {
        target = await params.session.client.getMessage({ message_id: ev.message_id });
      } catch {
        target = undefined;
      }
      // The lookup can outlive the account: a closed session rejects it, which must not read as "no target".
      if (stopped) return skip(seq, "stopped");
      if (params.mode === "own" && !target) return skip(seq, "lookup_failed");
      if (params.mode === "own" && !target!.is_outgoing) return skip(seq, "not_own");

      const nameOf = (userId: string, fallback: string) => {
        const m = members.find((x) => normalizeId(x.user_id) === normalizeId(userId));
        return oneLine((m && displayNameOf(m)) || fallback);
      };
      const reactor = nameOf(ev.reactor_user_id, strings.reactions.someone) || strings.reactions.someone;
      const targetLabel = !target
        ? strings.reactions.aMessage
        : target.is_outgoing
          ? strings.reactions.yourMessage
          : strings.reactions.someonesMessage(nameOf(target.sender_user_id, target.sender_username || strings.reactions.someone) || strings.reactions.someone);
      const removed = ev.emoji === "";
      const text = strings.reactions.line({
        emoji: removed ? undefined : oneLine(ev.emoji),
        reactor,
        target: targetLabel,
        messageId: oneLine(ev.message_id),
        quote: target && !target.deleted ? quoteOf(target.body) : undefined,
      });
      const queued = params.system.enqueueSystemEvent(text, {
        sessionKey,
        // One key per daemon event: add → remove → add again must all reach the session (core drops a
        // queued event whose key and text repeat one still pending).
        contextKey: `${CHANNEL_ID}:reaction:${seq}:${removed ? "removed" : "added"}:${normalizeId(ev.group_id)}:${ev.message_id}:${normalizeId(ev.reactor_user_id)}:${ev.emoji}`,
      });
      logSafe("reaction_queued", { seq, deduped: !queued });
    } catch (err) {
      failed(seq, err);
    }
  };

  return {
    admit: async (ev) => {
      const { seq } = ev;
      try {
        if (stopped) return;
        if (params.mode === "off") return skip(seq, "off");
        // The agent's own send_reaction comes back as reaction_changed too.
        if (normalizeId(ev.reactor_user_id) === normalizeId(params.account.agentUserId)) return skip(seq, "self");
        // The same sender gate as a message (sender-gate.ts). No mention gate: a reaction has no text.
        const { members, shape, access } = await gateSender({
          members: params.session.members,
          resolver: params.resolver,
          account: params.account,
          groupId: ev.group_id,
          senderUserId: ev.reactor_user_id,
          commandRequested: false,
        });
        if (!access.senderAccess.allowed) return skip(seq, "access");
        const route = params.resolveAgentRoute({
          cfg: params.cfg,
          channel: CHANNEL_ID,
          accountId: params.accountId,
          peer: { kind: shape.kind, id: normalizeId(ev.group_id) },
        });
        // Bounded: active + waiting, per account; past it the newest is skipped.
        if (pending >= MAX_PENDING_REACTIONS) return skip(seq, "backlog");
        pending++;
        const admitted: AdmittedReaction = { ev, members, sessionKey: route.sessionKey };
        tail = tail
          .then(() => deliver(admitted))
          .catch(() => {})
          .finally(() => {
            pending--;
          });
      } catch (err) {
        failed(seq, err);
      }
    },
    stop: () => {
      stopped = true;
    },
  };
}
