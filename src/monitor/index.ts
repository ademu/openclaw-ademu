// startAccount (plan T10): compose daemon lease → session → ingress loop for ONE account, publish
// status, and tear down under one absolute deadline (K3: the host abandons stop at 5 s; we finish in
// ≤ 4500 ms by construction, with a 2500 ms tail reserved for the daemon release).
//
// Outcome contract with the gateway supervisor: a normal return = "done" (abort, or a user-actionable
// `blocked` state that a restart cannot fix); a throw = "restart me" (`recovering`: daemon lost,
// ingress halted, transient failures). Foreign daemons never reject on daemon loss (the client's own
// reconnect loop probes; status stays `recovering`).
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { CHANNEL_ID, type ResolvedAdemuAccount } from "../config.js";
import { classifyConversation, type ConversationKind } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { registerLiveAccount, sendAdemuText, unregisterLiveAccount, type LiveAccount } from "../outbound.js";
import { createAdemuIngressResolver } from "../security.js";
import { blockedPatch, classifyError, patchFor, readyPatch, recoveringPatch, type StatusPatch } from "../status.js";
import type { AdemuStore } from "../store.js";
import { DaemonAbortedError, type DaemonManager, type Lease } from "./daemon.js";
import { startIngress, type IngressHandle, type RuntimeChannelSurface } from "./ingress.js";
import { openSession, type Session, type SessionDeps } from "./session.js";

export const STOP_DEADLINE_MS = 4500;
export const RELEASE_TAIL_MS = 2500;
export const DRAIN_CAP_MS = 2000;

export type StartAccountDeps = {
  store: AdemuStore;
  daemons: DaemonManager;
  session: SessionDeps;
  runtime: RuntimeChannelSurface;
  settings: { typingKeepaliveMs: number; mentionAliases: readonly string[] };
  platform: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export type StartOutcome =
  | { kind: "aborted" }
  | { kind: "blocked"; lastError: string }
  | { kind: "restart"; lastError: string; error: unknown };

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

  // --- daemon lease -------------------------------------------------------------------------
  let lease: Lease;
  try {
    lease = await deps.daemons.acquire({ identity: account.daemon, server: account.server, role: "runtime", signal: ctx.abortSignal });
  } catch (err) {
    if (err instanceof DaemonAbortedError || ctx.abortSignal.aborted) return;
    const c = classifyError(err);
    setStatus(patchFor(err));
    log("daemon_acquire_failed", { errorClass: err instanceof Error ? err.name : typeof err, kind: c.kind });
    if (c.kind === "blocked") return;
    throw err;
  }
  log("daemon_acquired", { mode: lease.mode });

  const outcome = await runWithLease(ctx, deps, lease, setStatus, log);
  if (outcome.kind === "restart") throw outcome.error;
}

async function runWithLease(
  ctx: ChannelGatewayContext<ResolvedAdemuAccount>,
  deps: StartAccountDeps,
  lease: Lease,
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
    let retryCount = 0;
    try {
      session = await openSession({
        token: account.token!,
        sessionSocketPath: lease.info.sessionSocketPath,
        account: { deviceId: account.deviceId!, agentUserId: account.agentUserId!, ownerUserId: account.ownerUserId },
        deps: deps.session,
        onRetry: (info) => {
          retryCount = info.attempt;
          setStatus(recoveringPatch(strings.status.reconnecting(info.attempt)));
        },
        onReconnected: () => {
          retryCount = 0;
          setStatus(readyPatch());
        },
      });
    } catch (err) {
      if (ctx.abortSignal.aborted) return outcome;
      const c = classifyError(err);
      setStatus(patchFor(err));
      log("session_open_failed", { errorClass: err instanceof Error ? err.name : typeof err, kind: c.kind });
      outcome = c.kind === "blocked" ? { kind: "blocked", lastError: c.lastError } : { kind: "restart", lastError: c.lastError, error: err };
      return outcome;
    }
    void retryCount;

    const ownerUserId = account.ownerUserId ?? session.self.owner_user_id;
    const members = session.members;
    live = {
      client: session.client,
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
      signal: loopAbort.signal,
      log,
    });
    setStatus(readyPatch());
    log("account_ready", { mode: lease.mode });

    // --- run until something ends it ---------------------------------------------------------
    const ended = await Promise.race<StartOutcome>([
      abortPromise(ctx.abortSignal),
      ingress.lifetime.catch((err: unknown) => toOutcome(err)),
      lease.lost.catch((err: unknown) => toOutcome(err)),
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
    // Cleanup under the absolute deadline, every step in its own nested finally (Codex R1 #8 …).
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
          if (session) await session.close().catch(() => {});
        }
      } finally {
        await lease.release().catch((err: unknown) => log("daemon_release_failed", { errorClass: err instanceof Error ? err.name : typeof err }));
      }
    } finally {
      if (outcome.kind === "aborted") setStatus({ running: false, connected: false, lifecycle: "stopped" });
    }
  }
}

function isHalt(err: unknown): boolean {
  return classifyError(err).ingressUnavailable === true;
}

function toOutcome(err: unknown): StartOutcome {
  const c = classifyError(err);
  return c.kind === "blocked" ? { kind: "blocked", lastError: c.lastError } : { kind: "restart", lastError: c.lastError, error: err };
}

export const channelId = CHANNEL_ID;
