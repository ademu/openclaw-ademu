// startAccount (plan T10): compose daemon attachment → session → ingress loop for ONE account,
// publish status, and tear down under one absolute deadline (K3: the host abandons stop at 5 s; we
// finish in ≤ 4500 ms by construction, with a 2500 ms tail reserved for the release).
//
// Outcome contract with the gateway supervisor: a normal return = "done" (abort, or a user-actionable
// `blocked` state that a restart cannot fix); a throw = "restart me" (`recovering`: ingress halted,
// transient failures). The plugin never runs a device host (AdemuMLS #712): the runtime never starts
// one. A session socket with no listener (adc not installed, stopped, not up yet at boot) is waited
// for IN the task — `recovering` with the reason, re-attaching on a capped backoff — because the
// gateway's restart loop gives up after 10 attempts and replaces the reason with the raw connect
// error; once seated, the client's own reconnect loop rides out a daemon restart.
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { CHANNEL_ID, type ResolvedAdemuAccount } from "../config.js";
import { classifyConversation, type ConversationKind } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { createReplyMediaSender, registerLiveAccount, sendAdemuText, unregisterLiveAccount, type LiveAccount, type RefusalNotes } from "../outbound.js";
import { createAdemuIngressResolver } from "../security.js";
import { blockedPatch, classifyError, patchFor, readyPatch, recoveringPatch, unreachableCopy, type StatusPatch } from "../status.js";
import type { AdemuStore } from "../store.js";
import { DaemonAbortedError, SessionSocketMovedError, type Attacher, type Attachment } from "./attach.js";
import { startIngress, type IngressHandle, type RuntimeChannelSurface } from "./ingress.js";
import { openSession, type Session, type SessionDeps } from "./session.js";

export const STOP_DEADLINE_MS = 4500;
export const RELEASE_TAIL_MS = 2500;
export const DRAIN_CAP_MS = 2000;
/** Every this many consecutive reconnect attempts the session path is re-resolved (it may have moved). */
export const REPROBE_AFTER_ATTEMPTS = 5;
/** The in-task wait while nothing listens on the session socket: first delay, doubling to the cap. */
export const ABSENT_WAIT_INITIAL_MS = 2_000;
export const ABSENT_WAIT_MAX_MS = 30_000;

/** `channels.ademu.server` is deprecated and ignored (#712): say so once per process, not per account start. */
let serverDeprecationLogged = false;

/** Race a cleanup step against the remaining budget; a slow step is logged and abandoned, never awaited past the deadline. */
async function bounded(deps: StartAccountDeps, label: string, step: Promise<unknown>, budgetMs: number, log: StartAccountDeps["log"]): Promise<void> {
  let timedOut = false;
  await Promise.race([
    step.catch((err: unknown) => log(`${label}_failed`, { errorClass: err instanceof Error ? err.name : typeof err })),
    deps.sleep(Math.max(0, budgetMs)).then(() => {
      timedOut = true;
    }),
  ]);
  if (timedOut) log("cleanup_step_timed_out", { step: label });
}

export type StartAccountDeps = {
  store: AdemuStore;
  attacher: Attacher;
  session: SessionDeps;
  runtime: RuntimeChannelSurface;
  settings: { typingKeepaliveMs: number; mentionAliases: readonly string[] };
  platform: string;
  now: () => number;
  /** Resolves after `ms`, or early on `signal` (a real one clears its timer). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export type StartOutcome =
  | { kind: "aborted" }
  | { kind: "blocked"; lastError: string }
  | { kind: "restart"; lastError: string; error: unknown }
  /** The initial session connect found no listener: wait in-task, then attach again. */
  | { kind: "absent" };

/** No daemon on the socket (no file, or nobody accepting) — not a refusal by a daemon that answered. */
function nothingListening(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/**
 * Wait `ms` unless `signal` aborts (true = waited the whole time). Leaves no listener behind, and the
 * sleep is handed the signal so a real timer is cleared on abort — the in-task wait may run for hours.
 */
async function waitUnlessAborted(deps: StartAccountDeps, ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  let onAbort!: () => void;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([deps.sleep(ms, signal).then(() => !signal.aborted), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function abortPromise(signal: AbortSignal): Promise<{ kind: "aborted" }> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ kind: "aborted" });
    else signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
  });
}

function preflight(account: ResolvedAdemuAccount, platform: string): StatusPatch | undefined {
  if (!account.enabled) return { running: false, connected: false, lifecycle: "stopped", lastError: strings.status.accountDisabled };
  if (account.configError) return blockedPatch(strings.status.configCollision(account.configError));
  if (platform === "win32") return blockedPatch(strings.status.unsupportedPlatform("Windows"));
  if (!account.configured || !account.deviceId || !account.agentUserId) return blockedPatch(strings.status.notConfigured);
  if (!account.token) return blockedPatch(strings.status.notConfigured);
  return undefined;
}

/**
 * Runs one account until abort, loss, or a terminal condition. Resolves normally for "aborted" and
 * "blocked"; REJECTS for "restart" so the gateway supervisor re-runs it (Signal's mechanism).
 */
export async function startAccount(ctx: ChannelGatewayContext<ResolvedAdemuAccount>, deps: StartAccountDeps): Promise<void> {
  const { account, accountId } = ctx;
  const setStatus = (patch: StatusPatch) => ctx.setStatus({ accountId, ...(patch as object) });
  const log = (event: string, fields?: Record<string, string | number | boolean>) => deps.log(event, { accountId, ...fields });

  setStatus({ running: true, connected: false, lifecycle: "starting", lastError: null });
  const blocked = preflight(account, deps.platform);
  if (blocked) {
    setStatus(blocked);
    return;
  }

  if (account.serverConfigured && !serverDeprecationLogged) {
    serverDeprecationLogged = true;
    log("config_server_deprecated", { ignored: true });
  }

  // --- daemon attachment (again after each in-task wait while nothing listens) -------------------
  for (let waitMs = ABSENT_WAIT_INITIAL_MS; ; waitMs = Math.min(waitMs * 2, ABSENT_WAIT_MAX_MS)) {
    let attachment: Attachment;
    try {
      attachment = await deps.attacher.attach({ identity: account.daemon, role: "runtime", signal: ctx.abortSignal });
    } catch (err) {
      if (err instanceof DaemonAbortedError || ctx.abortSignal.aborted) return;
      const c = classifyError(err);
      setStatus(patchFor(err));
      log("daemon_attach_failed", { errorClass: err instanceof Error ? err.name : typeof err, kind: c.kind });
      if (c.kind === "blocked") return;
      throw err;
    }
    log("daemon_attached", { reachable: !attachment.unreachable });

    const outcome = await runWithLease(ctx, deps, attachment, setStatus, log);
    if (outcome.kind === "restart") throw outcome.error;
    if (outcome.kind !== "absent") return;
    log("daemon_absent_waiting", { waitMs });
    if (!(await waitUnlessAborted(deps, waitMs, ctx.abortSignal))) {
      setStatus({ running: false, connected: false, lifecycle: "stopped" });
      return;
    }
  }
}

async function runWithLease(
  ctx: ChannelGatewayContext<ResolvedAdemuAccount>,
  deps: StartAccountDeps,
  lease: Attachment,
  setStatus: (patch: StatusPatch) => void,
  log: StartAccountDeps["log"],
): Promise<StartOutcome> {
  const { account, accountId, cfg } = ctx;
  let session: Session | undefined;
  let ingress: IngressHandle | undefined;
  let live: LiveAccount | undefined;
  let outcome: StartOutcome = { kind: "aborted" };
  let deadline = deps.now() + STOP_DEADLINE_MS;

  try {
    // --- session ---------------------------------------------------------------------------
    // Retries are unbounded (`recovering` while the client's own loop probes). Every
    // REPROBE_AFTER_ATTEMPTS attempts — for the whole outage, since adc may still be down at the first
    // check — the session path is re-resolved, never two at once: a device host that came back on a
    // different session socket (an adc upgrade that moved it) ends the lifetime → restart → a fresh
    // attachment on the new path.
    let reprobing = false;
    let retriesExceeded!: (err: Error) => void;
    const retriesExceededP = new Promise<never>((_, reject) => {
      retriesExceeded = reject;
    });
    retriesExceededP.catch(() => {});
    try {
      session = await openSession({
        token: account.token!,
        sessionSocketPath: lease.info.sessionSocketPath,
        account: { deviceId: account.deviceId!, agentUserId: account.agentUserId!, ownerUserId: account.ownerUserId },
        deps: deps.session,
        onRetry: (info) => {
          setStatus(recoveringPatch(strings.status.reconnecting(info.attempt)));
          if (info.attempt % REPROBE_AFTER_ATTEMPTS === 0 && !reprobing) {
            reprobing = true;
            void deps.attacher
              .resolveSessionSocket(account.daemon, ctx.abortSignal)
              .then((path) => {
                if (path !== lease.info.sessionSocketPath) retriesExceeded(new SessionSocketMovedError());
              })
              .catch(() => {})
              .finally(() => {
                reprobing = false;
              });
          }
        },
        onReconnected: () => {
          setStatus(readyPatch());
        },
        signal: ctx.abortSignal,
      });
    } catch (err) {
      if (ctx.abortSignal.aborted) return outcome;
      const c = classifyError(err);
      log("session_open_failed", { errorClass: err instanceof Error ? err.name : typeof err, kind: c.kind });
      if (c.kind === "recovering" && nothingListening(err)) {
        // Nothing listens: name WHY (not installed / disabled / not running / system down) instead of
        // the connect error, and let startAccount wait in-task (a daemon that answered at attach and
        // died since reads as not running / system down).
        const why = lease.unreachable ?? (lease.identity.scope === "system" ? "system_down" : "not_running");
        setStatus(recoveringPatch(unreachableCopy(why)));
        outcome = { kind: "absent" };
        return outcome;
      }
      setStatus(lease.unreachable && c.kind === "recovering" ? recoveringPatch(unreachableCopy(lease.unreachable)) : patchFor(err));
      outcome = c.kind === "blocked" ? { kind: "blocked", lastError: c.lastError } : { kind: "restart", lastError: c.lastError, error: err };
      return outcome;
    }

    const ownerUserId = account.ownerUserId ?? session.self.owner_user_id;
    const members = session.members;
    const refusalNotes: RefusalNotes = new Map();
    live = {
      client: session.client,
      media: session.client,
      refusalNotes,
      log,
      conversationKind: (groupId: string): ConversationKind | undefined => {
        const list = members.peek(groupId);
        return list ? classifyConversation({ members: list, agentUserId: account.agentUserId!, ownerUserId }).kind : undefined;
      },
    };
    registerLiveAccount(accountId, live);

    // --- ingress ---------------------------------------------------------------------------
    const loopAbort = new AbortController();
    ingress = startIngress({
      accountId,
      cfg,
      runtime: deps.runtime,
      session,
      store: deps.store,
      resolver: createAdemuIngressResolver({ accountId, cfg }),
      account: { deviceId: account.deviceId!, agentUserId: account.agentUserId!, ownerUserId, agentName: account.agentName },
      mentionAliases: deps.settings.mentionAliases,
      typingKeepaliveMs: deps.settings.typingKeepaliveMs,
      sendText: async (groupId, text) => {
        const chunks = await sendAdemuText({ client: session!.client, groupId, text });
        return { message_id: chunks[0]!.result.message_id };
      },
      sendMedia: createReplyMediaSender({ client: session.client, cfg, notes: refusalNotes, log }),
      refusalNotes,
      signal: loopAbort.signal,
      log,
      onSecurityNotice: (groupId) => {
        // Fixed copy only — never a field of the frame.
        setStatus({ lastError: strings.status.securityNotice });
        if (groupId) void sendAdemuText({ client: session!.client, groupId, text: strings.room.securityNotice }).catch(() => {});
      },
    });
    setStatus(readyPatch());
    log("account_ready", {});

    // --- run until something ends it ---------------------------------------------------------
    const ended = await Promise.race<Exclude<StartOutcome, { kind: "absent" }>>([
      abortPromise(ctx.abortSignal),
      ingress.lifetime.catch((err: unknown) => toOutcome(err)),
      retriesExceededP.catch((err: unknown) => toOutcome(err)),
    ]);
    outcome = ended;
    deadline = deps.now() + STOP_DEADLINE_MS;
    if (outcome.kind !== "aborted") {
      setStatus(outcome.kind === "blocked" ? blockedPatch(outcome.lastError) : recoveringPatch(outcome.lastError, isHalt(outcome.error) ? { ingressUnavailable: true } : {}));
      log("account_ended", { kind: outcome.kind });
    }
    loopAbort.abort();
    return outcome;
  } finally {
    // Cleanup under ONE absolute deadline, every step in its own nested finally and every step
    // bounded (a hung close or release is logged and abandoned, never awaited past the budget).
    try {
      try {
        try {
          if (ingress) {
            ingress.stop();
            const budget = Math.min(DRAIN_CAP_MS, deadline - deps.now() - RELEASE_TAIL_MS);
            if (budget > 0) await Promise.race([ingress.drain(), deps.sleep(budget)]);
          }
        } finally {
          if (live) unregisterLiveAccount(accountId, live);
          if (session) await bounded(deps, "session_close", session.close(), Math.max(0, deadline - deps.now() - RELEASE_TAIL_MS), log);
        }
      } finally {
        // The reserved tail: whatever is left, but at least the release cap.
        await bounded(deps, "daemon_release", lease.release(), Math.max(RELEASE_TAIL_MS, deadline - deps.now()), log);
      }
    } finally {
      if (outcome.kind === "aborted") setStatus({ running: false, connected: false, lifecycle: "stopped" });
    }
  }
}

function isHalt(err: unknown): boolean {
  return classifyError(err).ingressUnavailable === true;
}

function toOutcome(err: unknown): Exclude<StartOutcome, { kind: "absent" | "aborted" }> {
  const c = classifyError(err);
  return c.kind === "blocked" ? { kind: "blocked", lastError: c.lastError } : { kind: "restart", lastError: c.lastError, error: err };
}

export const channelId = CHANNEL_ID;
