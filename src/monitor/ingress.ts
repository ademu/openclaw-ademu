// The ingress loop (design entry §2 R2b, plan T7) — THE correctness pin of this plugin.
//
// One sequential loop per account owns the AdcClient event iterator and produces the session's
// `lifetime`. A `ct:"call"` record is history, never a turn (`call-records.ts`); a `call_changed` live
// event goes to the call controller beside the loop. Per `message_received`: validate → watermark replay check → self-sent → decision-only
// access → mention decision → route → context-bound access → buildContext → dispatch with an
// AdoptionTracker (whose `onAdopted` commits the watermark) → await the tracker → ack. A non-text
// `ct` takes the same path with a described body (`content.ts`); nothing here waits for a file.
//
// Acks are CUMULATIVE and carry read-receipt weight, so: N+1 is never dispatched before N settled;
// gated/malformed/self-sent/replayed messages ack immediately after the decision; any pre-adoption
// failure HALTS the loop (no ack for N or anything after), the caller republishes `recovering` +
// `ingressUnavailable`, and the gateway restart replays from the daemon's cursor. Model runs proceed
// concurrently after adoption, bounded by MAX_INFLIGHT dispatches.
import { LineTooLongError, ProtocolViolationError, SessionRejectedError, type DeviceEvent, type MessageReceivedEvent } from "@ademu/adc-client";

function isTerminalClientError(err: unknown): boolean {
  return err instanceof SessionRejectedError || err instanceof ProtocolViolationError || err instanceof LineTooLongError;
}
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { bindIngressLifecycleToReplyOptions, createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { CHANNEL_ID } from "../config.js";
import { describeConversation, displayNameOf, looksLikeId, normalizeId } from "../grammar.js";
import { resolveSenderRole } from "../roles.js";
import {
  agentNames,
  computeWasMentioned,
  decideMention,
  openclawMentionRegexes,
  resolveMessageAccess,
  resolveRequireMention,
  type MessageAccessInput,
} from "../security.js";
import { IngressHaltedError, IngressProtocolError } from "../status.js";
import { peekRefusalNote, type RefusalNotes } from "../outbound.js";
import type { AdemuStore } from "../store.js";
import { AdoptionFailedError, AdoptionTracker, type TurnResultLike } from "./adoption.js";
import { parseCallChanged, type CallChanged } from "../calls/protocol.js";
import { deliverCallRecord } from "./call-records.js";
import { bodyForAgent, describeContent, escapeRuntimeContextDelimiters } from "./content.js";
import { forgetRoomHistory, peekRoomHistory, recordSkipped, type RoomHistory } from "./history.js";
import { gateSender } from "./sender-gate.js";
import { createReactionQueue, DEFAULT_REACTION_NOTIFICATIONS, type ReactionNotificationMode, type RuntimeSystemSurface } from "./reactions.js";
import type { Session } from "./session.js";

export const MAX_INFLIGHT = 4;

/** The slice of `api.runtime.channel` the loop uses (typed loosely: host-injected, authoritative). */
export type RuntimeChannelSurface = {
  inbound: {
    buildContext: (params: Record<string, unknown>) => unknown;
    dispatch: (plan: Record<string, unknown>) => Promise<TurnResultLike>;
  };
  routing: {
    resolveAgentRoute: (input: Record<string, unknown>) => { agentId: string; accountId: string; sessionKey: string; dmScope?: unknown };
  };
  commands: {
    shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
    isControlCommandMessage: (rawBody: string, cfg: OpenClawConfig) => boolean;
  };
};

export type IngressParams = {
  accountId: string;
  cfg: OpenClawConfig;
  runtime: RuntimeChannelSurface;
  /** The host's system-event queue: reactions become lines the agent reads at its next turn (reactions.ts). */
  system: RuntimeSystemSurface;
  /** Which reactions are queued (missing = the default, all). */
  reactionNotifications?: ReactionNotificationMode | undefined;
  session: Session;
  store: AdemuStore;
  resolver: MessageAccessInput["resolver"];
  account: { deviceId: string; agentUserId: string; ownerUserId: string; agentName: string };
  mentionAliases: readonly string[];
  typingKeepaliveMs: number;
  /** Sends a text reply into a conversation (the outbound adapter's text send). */
  sendText: (groupId: string, text: string) => Promise<{ message_id: string }>;
  /** Sends a reply's files (and its text) into a conversation, reporting what did not go out; true = something visible went out. */
  sendMedia: (groupId: string, text: string | undefined, urls: readonly string[], agentId: string) => Promise<boolean>;
  /** Files that did not go out, per conversation: the agent's next turn there starts with a note (shared with outbound). */
  refusalNotes?: RefusalNotes | undefined;
  /** Room messages skipped for not addressing the agent, per conversation: its next turn there gets them as history. */
  roomHistory?: RoomHistory | undefined;
  /** How many skipped messages a conversation keeps (0 = none; missing = the default). */
  historyLimit?: number | undefined;
  /** Shutdown signal for the loop (NOT propagated to adopted turns). */
  signal: AbortSignal;
  /** Where `call_changed` events go (the account's call controller); missing = they are dropped. */
  onCallChanged?: ((ev: CallChanged) => void) | undefined;
  /** A future `security_notice` live event: the caller sets a fixed status and posts a fixed room note. */
  onSecurityNotice?: ((groupId: string | undefined) => void) | undefined;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
  /** Injected for tests; default = real timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  stallMs?: number;
};

export type IngressHandle = {
  /** Rejects with IngressHaltedError (halt) or the iterator's terminal error; never resolves normally. */
  lifetime: Promise<never>;
  /** In-flight dispatch promises (adopted or pending). */
  inflight: ReadonlySet<Promise<unknown>>;
  /** Close the tracker generation and abort un-adopted messages (shutdown step 1). */
  stop: () => void;
  /** Wait for in-flight dispatches to settle (shutdown step 2, bounded by the caller). */
  drain: () => Promise<void>;
};

function validMessage(ev: DeviceEvent): ev is MessageReceivedEvent & { known: true; type: "event"; seq: number } {
  if (!ev.known || ev.event !== "message_received") return false;
  const m = ev as unknown as MessageReceivedEvent;
  return (
    typeof m.message_id === "string" &&
    m.message_id.length > 0 &&
    typeof m.group_id === "string" &&
    looksLikeId(m.group_id) &&
    typeof m.sender_user_id === "string" &&
    looksLikeId(m.sender_user_id) &&
    typeof m.body === "string"
  );
}

function validSeq(seq: unknown): seq is number {
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0;
}

/**
 * The client's event stream with every `call_changed` taken out as it ARRIVES and handed to
 * `onCall`; everything else is yielded in order. The source is read continuously (it buffers without
 * bound already; this only moves the buffer), so the consumer's pace never delays a call event.
 * The source's end or error reaches the consumer after the events before it.
 */
export function readAheadCalls(source: AsyncIterator<DeviceEvent>, onCall: (ev: DeviceEvent) => void, stopped: () => boolean): AsyncIterable<DeviceEvent> {
  const items: DeviceEvent[] = [];
  let end: { error?: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  void (async () => {
    try {
      for (;;) {
        const r = await source.next();
        if (r.done) break;
        if (String(r.value.event) === "call_changed") {
          if (!stopped()) onCall(r.value);
          continue;
        }
        items.push(r.value);
        notify();
        if (stopped()) break;
      }
      end = {};
    } catch (err) {
      end = { error: err };
    }
    notify();
  })();
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<DeviceEvent>> => {
        for (;;) {
          const item = items.shift();
          if (item) return { value: item, done: false };
          if (end) {
            if ("error" in end) throw end.error;
            return { value: undefined, done: true };
          }
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      },
    }),
  };
}

export function startIngress(params: IngressParams): IngressHandle {
  const { session, store, accountId, cfg, runtime, log } = params;
  const client = session.client;
  const trackers = new Set<AdoptionTracker>();
  const inflight = new Set<Promise<unknown>>();
  let stopped = false;
  let rejectLifetime!: (err: Error) => void;
  const lifetime = new Promise<never>((_, reject) => {
    rejectLifetime = reject;
  });
  lifetime.catch(() => {});

  // Reactions: decided in the loop like a message, delivered beside it (reactions.ts). Declared before
  // halt/stop, which close it.
  const reactions = createReactionQueue({
    accountId,
    cfg,
    mode: params.reactionNotifications ?? DEFAULT_REACTION_NOTIFICATIONS,
    session,
    resolver: params.resolver,
    account: { agentUserId: params.account.agentUserId, ownerUserId: params.account.ownerUserId },
    resolveAgentRoute: runtime.routing.resolveAgentRoute,
    system: params.system,
    log,
  });

  // Halt: close every tracker generation and end the lifetime. Adoption/ack integrity failures are
  // IngressHaltedError (recovering → restart replays); a TERMINAL client error surfacing from the
  // iterator (revoked token, displaced, protocol violation …) is passed through unwrapped so the
  // status table can classify it as `blocked` instead of restarting forever.
  const halt = (cause: unknown) => {
    if (stopped) return;
    stopped = true;
    for (const t of trackers) t.close();
    reactions.stop();
    rejectLifetime(cause instanceof Error ? cause : new IngressHaltedError(cause));
  };

  const ack = (seq: number) => {
    // `ack()` is synchronous and THROWS when not seated or for an invalid seq; either is a halt
    // (the watermark, if already committed, makes the replay re-ack without redispatch).
    try {
      client.ack(seq);
    } catch (err) {
      throw new IngressHaltedError(err);
    }
  };

  const names = agentNames({
    displayName: session.self.display_name,
    username: session.self.username,
    agentName: params.account.agentName,
    aliases: params.mentionAliases,
  });

  const handleMessage = async (ev: MessageReceivedEvent & { seq: number }): Promise<void> => {
    const seq = ev.seq;
    const deviceId = params.account.deviceId;

    // 1. Watermark replay check (§2 R2b rider R2).
    const wm = store.getWatermark(accountId);
    if (wm && normalizeId(wm.deviceId) === normalizeId(deviceId) && seq <= wm.adoptedSeq) {
      log("ingress_replay_acked", { seq });
      ack(seq);
      return;
    }
    // A call record (AdemuMLS #874) is history, never a turn — the agent's own calls included, so it
    // is decided before the self-sent rule: one queued line, then the ack.
    const content = describeContent(ev);
    if (content.kind === "call") {
      await deliverCallRecord(
        {
          accountId,
          cfg,
          session,
          resolver: params.resolver,
          account: { agentUserId: params.account.agentUserId, ownerUserId: params.account.ownerUserId },
          resolveAgentRoute: runtime.routing.resolveAgentRoute,
          system: params.system,
          log,
        },
        ev,
        content.record,
      );
      ack(seq);
      return;
    }
    // 2. Self-sent (our own outgoing echoes back through the durable stream).
    if (normalizeId(ev.sender_user_id) === normalizeId(params.account.agentUserId)) {
      ack(seq);
      return;
    }
    // A non-text message (a file, or a kind this plugin does not handle) is never a command; its
    // caption still counts for the mention decision below.
    // Sender-controlled text never reaches the host with OpenClaw's runtime-context delimiters (content.ts).
    const body = escapeRuntimeContextDelimiters(ev.body);
    const commandRequested = content.kind === "text" && runtime.commands.shouldComputeCommandAuthorized(body, cfg);
    const isTextCommand = content.kind === "text" && runtime.commands.isControlCommandMessage(body, cfg);

    // 3–4. Conversation shape from membership (unknown sender → one refresh), then the decision-only
    // access (cheap drop of strangers in DMs) — the sender gate reactions share (sender-gate.ts).
    const { members, shape, access: pre } = await gateSender({
      members: session.members,
      resolver: params.resolver,
      account: params.account,
      groupId: ev.group_id,
      senderUserId: ev.sender_user_id,
      commandRequested,
    });
    const isGroup = shape.kind === "group";
    const senderRole = resolveSenderRole(ev.sender_user_id, params.account.ownerUserId);
    const sender = members.find((m) => normalizeId(m.user_id) === normalizeId(ev.sender_user_id));
    if (!pre.senderAccess.allowed) {
      log("ingress_sender_dropped", { seq, kind: shape.kind });
      ack(seq);
      return;
    }
    // 5. Route first (the routed agent's own mention patterns count), then the mention decision.
    const conversationId = normalizeId(ev.group_id);
    const route = runtime.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer: { kind: shape.kind, id: conversationId },
    });
    const wasMentioned = computeWasMentioned({
      text: body,
      senderRole,
      names,
      mentionRegexes: openclawMentionRegexes(cfg, route.agentId),
    });
    const requireMention = isGroup ? resolveRequireMention({ cfg, groupId: ev.group_id, accountId }) : false;
    const mention = decideMention({
      isGroup,
      requireMention,
      wasMentioned,
      hasControlCommand: isTextCommand,
      commandAuthorized: pre.commandAccess.authorized,
    });
    // A daemon that serves files (`get_blob`, AdemuMLS #440) lets the agent open them in its own turn.
    const described =
      content.kind === "text"
        ? undefined : bodyForAgent(body, content, client.capabilities.has("get_blob") ? { messageId: ev.message_id } : {});
    const senderName = sender ? escapeRuntimeContextDelimiters(displayNameOf(sender)) : undefined;
    if (mention.shouldSkip) {
      // Not for the agent, but part of the room: its next turn here gets it as history.
      recordSkipped(
        params.roomHistory,
        ev.group_id,
        {
          sender: senderName || escapeRuntimeContextDelimiters(ev.sender_username?.trim() || normalizeId(ev.sender_user_id)),
          body: described ?? body,
          timestamp: ev.created_at_ms,
          messageId: ev.message_id,
        },
        params.historyLimit,
      );
      log("ingress_unaddressed_skipped", { seq });
      ack(seq);
      return;
    }
    // 6. The context-bound access resolve (the result that enters buildContext).
    const access = await resolveMessageAccess({
      resolver: params.resolver,
      senderUserId: ev.sender_user_id,
      ownerUserId: params.account.ownerUserId,
      conversation: { kind: shape.kind, id: ev.group_id },
      commandRequested,
      contextBinding: { agentId: route.agentId, sessionKey: route.sessionKey, messageId: ev.message_id, inboundEventKind: "user_request" },
    });
    if (!access.senderAccess.allowed) {
      log("ingress_sender_dropped_late", { seq });
      ack(seq);
      return;
    }
    // 7. Context (Tlon/SMS projection).
    // Files of the agent's that did not go out since its last turn here: the note opens this turn. A
    // control command is answered by the host, not the agent, so the note waits for the next turn; it
    // is cleared only once this turn is adopted (below). The room's skipped messages follow the same rule.
    const pendingNote = isTextCommand ? undefined : peekRefusalNote(params.refusalNotes, ev.group_id);
    const note = pendingNote?.text;
    const pendingHistory = isTextCommand ? undefined : peekRoomHistory(params.roomHistory, ev.group_id);
    const text = described ?? body;
    const label = escapeRuntimeContextDelimiters(describeConversation(shape, params.account.agentName));
    const ctxPayload = runtime.inbound.buildContext({
      channel: CHANNEL_ID,
      accountId,
      messageId: ev.message_id,
      timestamp: ev.created_at_ms,
      from: `${CHANNEL_ID}:${normalizeId(ev.sender_user_id)}`,
      sender: {
        id: normalizeId(ev.sender_user_id),
        ...(senderName ? { name: senderName } : {}),
        ...(sender?.username ? { username: escapeRuntimeContextDelimiters(sender.username) } : {}),
        roles: [senderRole],
        isBot: sender?.kind === "agent",
      },
      conversation: {
        kind: shape.kind,
        id: conversationId,
        label,
        routePeer: { kind: shape.kind, id: conversationId },
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: `${CHANNEL_ID}:${conversationId}`,
        originatingTo: `${CHANNEL_ID}:${conversationId}`,
      },
      message: {
        rawBody: text,
        commandBody: text,
        // The note is for the agent only: commands still parse from commandBody.
        ...(described !== undefined || note !== undefined ? { bodyForAgent: note === undefined ? text : `${note}\n${text}` } : {}),
        ...(pendingHistory ? { inboundHistory: pendingHistory.entries } : {}),
      },
      access: {
        mentions: {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: wasMentioned,
          requireMention,
          effectiveWasMentioned: mention.effectiveWasMentioned,
        },
        ...(commandRequested ? { commands: { authorized: access.commandAccess.authorized } } : {}),
      },
      ...(isTextCommand ? { command: { kind: "text-slash", body, authorized: access.commandAccess.authorized } } : {}),
      channelIngress: access,
      extra: { SenderRole: senderRole },
    });

    // 8. Dispatch with our adoption tracker; NEVER await the dispatch promise for ordering.
    const tracker = new AdoptionTracker({
      seq,
      commit: () => store.setWatermark(accountId, deviceId, seq),
      ...(params.stallMs !== undefined ? { stallMs: params.stallMs } : {}),
      ...(params.setTimer ? { setTimer: params.setTimer } : {}),
      ...(params.clearTimer ? { clearTimer: params.clearTimer } : {}),
    });
    trackers.add(tracker);
    const groupId = ev.group_id;
    const dispatchPromise = runtime.inbound
      .dispatch({
        channel: CHANNEL_ID,
        accountId,
        cfg,
        route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
        ctxPayload,
        replyPipeline: createChannelMessageReplyPipeline({
          cfg,
          agentId: route.agentId,
          channel: CHANNEL_ID,
          accountId,
          typing: {
            start: async () => {
              await client.sendTyping({ group_id: groupId, active: true });
            },
            onStartError: (err: unknown) => log("typing_failed", { errorClass: err instanceof Error ? err.name : typeof err }),
            keepaliveIntervalMs: params.typingKeepaliveMs,
          },
        }),
        delivery: {
          durable: () => ({ to: `${CHANNEL_ID}:${conversationId}` }),
          deliver: async (payload: { text?: string; mediaUrl?: string | null; mediaUrls?: readonly (string | null | undefined)[] | null }) => {
            const urls = [...new Set([payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter((u): u is string => typeof u === "string" && u.length > 0))];
            if (urls.length > 0) return { visibleReplySent: await params.sendMedia(groupId, payload.text, urls, route.agentId) };
            if (!payload.text) return { visibleReplySent: false };
            await params.sendText(groupId, payload.text);
            return { visibleReplySent: true };
          },
          onError: (err: unknown) => log("reply_failed", { errorClass: err instanceof Error ? err.name : typeof err }),
        },
        replyOptions: bindIngressLifecycleToReplyOptions(tracker.lifecycle),
        record: {
          onRecordError: (err: unknown) => log("session_record_failed", { errorClass: err instanceof Error ? err.name : typeof err }),
        },
      })
      .then(
        (result) => tracker.onDispatchSettled(result),
        (err: unknown) => tracker.onDispatchSettled(undefined, err),
      );
    inflight.add(dispatchPromise);
    void dispatchPromise.finally(() => inflight.delete(dispatchPromise));
    // The tracker stays reachable by stop() until ITS OWN terminal state — a deferred turn's
    // dispatch promise resolves before adoption, and a late onAdopted after shutdown must hit the
    // closed generation (throw), not a forgotten tracker.
    void tracker.settled.then(
      () => trackers.delete(tracker),
      () => trackers.delete(tracker),
    );

    // 9. Adoption-ordered ack.
    let outcome;
    try {
      outcome = await tracker.settled;
    } catch (err) {
      throw new IngressHaltedError(err instanceof AdoptionFailedError ? err : new AdoptionFailedError("dispatch_rejected", err));
    }
    if (outcome.kind === "adopted-equivalent") log(outcome.reason === "callback_free_completion" ? "callback_free_completion" : "adopted_equivalent", { seq });
    // The agent read the note and the room history unless core declined the turn; then they stay for the next one.
    if (!(outcome.kind === "adopted-equivalent" && outcome.reason === "declined")) {
      pendingNote?.consume();
      pendingHistory?.consume();
    }
    ack(seq);

    // 10. Bound on concurrent runs (deferred turns are released from the bound at adoption).
    while (inflight.size >= MAX_INFLIGHT && !stopped) {
      await Promise.race([...inflight]);
    }
  };

  // Calls: live-only, never acked, never a halt. Read AHEAD of the loop (which waits on adoption and
  // on in-flight turns), so a ring is decided within its 45 s window however busy the agent is. A
  // client that does not know the event yet surfaces it as unknown, with the frame in `raw`.
  const routeCall = (ev: DeviceEvent) => {
    const call = parseCallChanged(ev);
    if (!call) return log("call_event_malformed", { seq: ev.seq });
    log("call_event", { seq: ev.seq, state: call.state });
    try {
      params.onCallChanged?.(call);
    } catch (err) {
      log("call_event_failed", { seq: ev.seq, errorClass: err instanceof Error ? err.name : typeof err });
    }
  };

  void (async () => {
    try {
      for await (const ev of readAheadCalls(client.events(), routeCall, () => stopped)) {
        if (stopped) break;
        await session.barrier();
        if (stopped) break;
        if (!ev.known) {
          if (String(ev.event) === "security_notice") {
            // Forward-compatible: fixed status copy + a fixed room note. The ONLY logged fact is
            // whether a room id was present — no field of the frame, not even its seq.
            const raw = (ev as { raw?: { group_id?: unknown } }).raw;
            const groupId = typeof raw?.group_id === "string" && looksLikeId(raw.group_id) ? normalizeId(raw.group_id) : undefined;
            log("security_notice", { room: groupId !== undefined });
            params.onSecurityNotice?.(groupId);
            continue;
          }
          log("event_unknown", { event: String(ev.event), seq: ev.seq });
          continue;
        }
        switch (ev.event) {
          case "message_received": {
            const seq: unknown = ev.seq;
            if (!validSeq(seq)) throw new IngressProtocolError("the Ademú device host sent a message_received frame with an invalid seq");
            if (!validMessage(ev)) {
              log("message_malformed", { seq });
              ack(seq);
              break;
            }
            try {
              await handleMessage(ev);
            } catch (err) {
              // Event-PROCESSING failures (members lookup, routing, access, context, dispatch) are the
              // pre-adoption halt (recovering + ingressUnavailable, replay after restart); only
              // explicit terminal errors keep their class and end the account as `blocked`.
              if (err instanceof IngressHaltedError || err instanceof IngressProtocolError || isTerminalClientError(err)) throw err;
              throw new IngressHaltedError(err);
            }
            break;
          }
          case "membership_changed":
          case "added_to_group":
            session.members.invalidate(ev.group_id);
            log("membership_changed", { seq: ev.seq });
            break;
          case "removed_from_group":
            session.members.markInactive(ev.group_id);
            forgetRoomHistory(params.roomHistory, ev.group_id);
            log("removed_from_group", { seq: ev.seq });
            break;
          case "reaction_changed":
            // Live-only: queued for the agent's next turn there, never acked, never a halt. Decided here
            // like a message; the target lookup runs beside the loop, so it never holds up a message.
            await reactions.admit(ev);
            break;
          case "message_status_changed":
          // A file's download progress (live-only, never acked): the media tool reads the state when asked.
          case "media_fetch_changed":
          // An own media send's outcome (live-only, never acked): the client's waitForMediaSend consumes it.
          case "media_send_changed":
            break;
        }
      }
      // The iterator finished cleanly (client closed) — only shutdown does that.
      if (!stopped) halt(new Error("event stream ended"));
    } catch (err) {
      halt(err);
    }
  })();

  return {
    lifetime,
    inflight,
    stop: () => {
      stopped = true;
      reactions.stop();
      for (const t of trackers) {
        t.abort();
        t.close();
      }
    },
    drain: async () => {
      await Promise.allSettled([...inflight]);
    },
  };
}
