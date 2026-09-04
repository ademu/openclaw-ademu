// The enrollment ceremony (plan T11) shared by both doors (wizard + `ademu_enroll` tool):
//   createDevice → QR → poll (NOT awaited before the words) → four words → human confirm →
//   confirmWords (the DAEMON's words, never user-typed) → await enrolled → tokenMint →
//   daemonInfo → identity probe over a short-lived session → { deviceId, agentUserId, ownerUserId, token }.
// Privacy: the QR payload, the words and the token are returned to the CALLER's rendering surface
// only; nothing in this module logs. `ControlError.detail` is never read.
import { AlreadyAttachedError, type AdcClient, type AdcClientOptions } from "@ademu/adc-client";
import { ControlError, type AdcControlClient, type FourWords, type PairingSnapshot } from "@ademu/adc-control";
import { normalizeId } from "./grammar.js";
import type { DaemonManager, Lease } from "./monitor/daemon.js";
import type { DaemonIdentity } from "./config.js";

export type ControlLike = Pick<
  AdcControlClient,
  "createDevice" | "listDevices" | "deviceStatus" | "confirmWords" | "cancelPairing" | "tokenMint" | "daemonInfo" | "pollPairing" | "close"
>;

export type EnrollmentFailure =
  | "aborted"
  | "cancelled"
  | "words_mismatch"
  | "revoked"
  | "retired"
  | "not_enrolled"
  | "label_exists"
  | "device_attached"
  | "identity_mismatch"
  | "daemon_too_old"
  | "unexpected_state";

export class EnrollmentError extends Error {
  constructor(
    readonly reason: EnrollmentFailure,
    message?: string,
  ) {
    super(message ?? `enrollment failed: ${reason}`);
    this.name = "EnrollmentError";
  }
}

export type EnrollmentResult = {
  deviceId: string;
  agentUserId: string;
  ownerUserId: string;
  agentUsername: string;
  agentDisplayName: string;
  /** Plaintext device token — returned once; the caller writes it to config and forgets it. */
  token: string;
  tokenId: string;
  sessionSocketPath: string;
};

export const TOKEN_LABEL_PREFIX = "openclaw-";
export function tokenLabelFor(accountId: string): string {
  return `${TOKEN_LABEL_PREFIX}${accountId}`;
}

const TERMINAL = new Set(["enrolled", "revoked", "retired"]);

type Common = {
  control: ControlLike;
  connectSession: (opts: AdcClientOptions) => Promise<AdcClient>;
  accountId: string;
  /** Authority re-check (host `beforePersistentEffect` / tool signal) before every durable effect. */
  beforeEffect: () => Promise<void>;
  signal: AbortSignal;
  /** Asked when a token with this account's label already exists. Default: refuse (label_exists). */
  confirmReplace?: (() => Promise<boolean>) | undefined;
  /** Asked when another mind is attached to the device. Default: refuse (device_attached). */
  confirmTakeover?: (() => Promise<boolean>) | undefined;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EnrollmentError("aborted");
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new EnrollmentError("aborted"));
    else signal.addEventListener("abort", () => reject(new EnrollmentError("aborted")), { once: true });
  });
}

/** Mint the account's token; on `label_exists` ask once and rotate with `replace: true`. */
export async function mintAccountToken(params: Common & { deviceId: string }): Promise<{ token: string; tokenId: string }> {
  const label = tokenLabelFor(params.accountId);
  await params.beforeEffect();
  throwIfAborted(params.signal);
  try {
    const minted = await params.control.tokenMint({ device_id: params.deviceId, label });
    return { token: minted.token, tokenId: minted.token_id };
  } catch (err) {
    if (!(err instanceof ControlError) || err.code !== "label_exists") throw err;
    if (!params.confirmReplace || !(await params.confirmReplace())) throw new EnrollmentError("label_exists");
    await params.beforeEffect();
    throwIfAborted(params.signal);
    const minted = await params.control.tokenMint({ device_id: params.deviceId, label, replace: true });
    return { token: minted.token, tokenId: minted.token_id };
  }
}

/** Identity facts come from the SESSION (`get_self`), never from the control plane (Codex R2 #9). */
export async function probeIdentity(params: Common & { deviceId: string; token: string; sessionSocketPath: string }): Promise<{
  agentUserId: string;
  ownerUserId: string;
  agentUsername: string;
  agentDisplayName: string;
}> {
  const open = async (takeover: boolean) =>
    params.connectSession({ token: params.token, socketPath: params.sessionSocketPath, takeover, reconnect: "never" });
  let client: AdcClient;
  try {
    client = await open(false);
  } catch (err) {
    if (!(err instanceof AlreadyAttachedError)) throw err;
    if (!params.confirmTakeover || !(await params.confirmTakeover())) throw new EnrollmentError("device_attached");
    client = await open(true);
  }
  try {
    const self = await client.getSelf();
    if (normalizeId(client.hello.device_id) !== normalizeId(params.deviceId) || normalizeId(self.device_id) !== normalizeId(params.deviceId)) {
      throw new EnrollmentError("identity_mismatch");
    }
    if (normalizeId(client.hello.agent_user_id) !== normalizeId(self.user_id)) throw new EnrollmentError("identity_mismatch");
    return { agentUserId: self.user_id, ownerUserId: self.owner_user_id, agentUsername: self.username, agentDisplayName: self.display_name };
  } finally {
    await client.close().catch(() => {});
  }
}

async function finishWithToken(params: Common & { deviceId: string }): Promise<EnrollmentResult> {
  const { token, tokenId } = await mintAccountToken(params);
  const info = await params.control.daemonInfo();
  const sessionSocketPath = info.session_socket_path;
  if (!sessionSocketPath) throw new EnrollmentError("daemon_too_old", "the Ademú device host does not report a session socket; upgrade adc");
  const identity = await probeIdentity({ ...params, token, sessionSocketPath });
  return { deviceId: params.deviceId, token, tokenId, sessionSocketPath, ...identity };
}

export type RunEnrollmentParams = Common & {
  agentName: string;
  /** Render the QR (payload is `ademu://…`). Runs from the serial consumer, never inside a poll callback. */
  onQr: (payload: string) => Promise<void>;
  /** Show the daemon's four words to the human. */
  onWords: (words: FourWords) => Promise<void>;
  /** The human's answer to "do these match your phone?". */
  confirm: (words: FourWords) => Promise<boolean>;
  /** Called once with the new device id as soon as it exists (lease bookkeeping for cancellation). */
  onDevice?: ((deviceId: string) => void) | undefined;
};

/**
 * New-device enrollment. `pollPairing` resolves ONLY at a terminal state, so it is started and
 * observed, never awaited before the words (Codex R1 #12); `onUpdate` is synchronous and only
 * enqueues — presentation runs from the serial consumer (Codex R2 #11).
 */
export async function runEnrollment(params: RunEnrollmentParams): Promise<EnrollmentResult> {
  const { control, signal } = params;
  await params.beforeEffect();
  throwIfAborted(signal);
  const created = await control.createDevice({ agent_name: params.agentName });
  const deviceId = created.device_id;
  params.onDevice?.(deviceId);

  // Snapshot queue + serial consumer.
  const snapshots: PairingSnapshot[] = [];
  let wake: (() => void) | undefined;
  let pollDone = false;
  const onUpdate = (s: PairingSnapshot) => {
    snapshots.push(s);
    wake?.();
  };
  const terminal = control.pollPairing(deviceId, onUpdate, { signal }).finally(() => {
    pollDone = true;
    wake?.();
  });
  terminal.catch(() => {}); // observed below; never unhandled

  const wordsPresented = (async (): Promise<FourWords> => {
    await params.onQr(created.qr_payload);
    let shown = false;
    for (;;) {
      const next = snapshots.shift();
      if (next) {
        if (TERMINAL.has(next.state)) {
          if (next.state === "revoked" || next.state === "retired") throw new EnrollmentError(next.state);
          throw new EnrollmentError("unexpected_state", `device reached ${next.state} before the words were confirmed`);
        }
        if (next.words && !shown) {
          shown = true;
          await params.onWords(next.words);
          return next.words;
        }
        continue;
      }
      if (pollDone) {
        // The poll ended without words: surface its outcome.
        const last = await terminal.catch((err: unknown) => {
          throw err;
        });
        if (last.state === "revoked" || last.state === "retired") throw new EnrollmentError(last.state);
        throw new EnrollmentError("unexpected_state", `pairing ended in ${last.state} before the words`);
      }
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = undefined;
    }
  })();

  let words: FourWords;
  try {
    words = await Promise.race([wordsPresented, abortRejection(signal)]);
  } catch (err) {
    await control.cancelPairing({ device_id: deviceId }).catch(() => {});
    throw err;
  }

  const ok = await params.confirm(words);
  if (!ok) {
    await control.cancelPairing({ device_id: deviceId }).catch(() => {});
    throw new EnrollmentError("cancelled");
  }

  await params.beforeEffect();
  throwIfAborted(signal);
  try {
    await control.confirmWords({ device_id: deviceId, words });
  } catch (err) {
    if (err instanceof ControlError && err.code === "words_mismatch") throw new EnrollmentError("words_mismatch");
    throw err;
  }

  const last = await Promise.race([terminal, abortRejection(signal)]);
  if (last.state !== "enrolled") {
    if (last.state === "revoked" || last.state === "retired") throw new EnrollmentError(last.state);
    throw new EnrollmentError("unexpected_state", `pairing ended in ${last.state}`);
  }
  return finishWithToken({ ...params, deviceId });
}

/** Reconnect an already-enrolled device: mint this account's token and probe identity. */
export async function connectExisting(params: Common & { deviceId: string }): Promise<EnrollmentResult> {
  throwIfAborted(params.signal);
  const status = await params.control.deviceStatus({ device_id: params.deviceId });
  if (status.state !== "enrolled") throw new EnrollmentError("not_enrolled", `device is ${status.state}`);
  return finishWithToken(params);
}

/** Enrolled devices available for "connect an already-enrolled agent". */
export async function listEnrolledDevices(control: ControlLike): Promise<Array<{ deviceId: string; agentName: string; agentUserId: string }>> {
  const { devices } = await control.listDevices();
  return devices.filter((d) => d.state === "enrolled").map((d) => ({ deviceId: d.device_id, agentName: d.agent_name, agentUserId: d.agent_user_id }));
}

// ---------------------------------------------------------------------------------------------
// EnrollmentLease: the resources of one ceremony, disposed exactly once on every terminal path.

export type EnrollmentLease = {
  readonly id: string;
  readonly accountId: string;
  readonly control: ControlLike;
  readonly daemonLease: Lease;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  deviceId?: string;
  /** Set once the device reached a terminal state (no cancelPairing on dispose). */
  terminal: boolean;
  disposed: boolean;
  dispose(reason: string): Promise<void>;
};

export type EnrollmentLeaseDeps = {
  daemons: DaemonManager;
  connectControl: (socketPath: string) => Promise<ControlLike>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onDisposed?: ((lease: EnrollmentLease, reason: string) => void) | undefined;
};

export const ENROLLMENT_TTL_MS = 3 * 60_000;

/** Acquires a SETUP daemon lease (never stops a daemon) and a control connection. */
export async function createEnrollmentLease(params: {
  deps: EnrollmentLeaseDeps;
  accountId: string;
  identity: DaemonIdentity;
  server: { restBaseUrl: string; wsUrl: string };
  beforeEffect: () => Promise<void>;
  signal?: AbortSignal | undefined;
  ttlMs?: number | undefined;
}): Promise<EnrollmentLease> {
  const { deps } = params;
  const abort = new AbortController();
  params.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const daemonLease = await deps.daemons.acquire({
    identity: params.identity,
    server: params.server,
    role: "setup",
    signal: abort.signal,
    beforeEffect: params.beforeEffect,
  });
  let control: ControlLike;
  try {
    control = await deps.connectControl(daemonLease.info.controlSocketPath);
  } catch (err) {
    await daemonLease.release().catch(() => {});
    throw err;
  }
  const ttl = params.ttlMs ?? ENROLLMENT_TTL_MS;
  const lease: EnrollmentLease = {
    id: `${params.accountId}-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    accountId: params.accountId,
    control,
    daemonLease,
    signal: abort.signal,
    expiresAt: deps.now() + ttl,
    terminal: false,
    disposed: false,
    dispose: async (reason: string) => {
      if (lease.disposed) return;
      lease.disposed = true;
      deps.clearTimer(timer);
      abort.abort();
      try {
        if (lease.deviceId && !lease.terminal) {
          await control.cancelPairing({ device_id: lease.deviceId }, { timeoutMs: 2000 }).catch(() => {});
        }
      } finally {
        try {
          await control.close().catch(() => {});
        } finally {
          await daemonLease.release().catch(() => {});
          deps.onDisposed?.(lease, reason);
        }
      }
    },
  };
  const timer = deps.setTimer(() => void lease.dispose("expired"), ttl);
  return lease;
}
