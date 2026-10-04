// The enrollment ceremony (plan T11) shared by both doors (wizard + `ademu_enroll` tool), driven over
// the daemon's ENROLLMENT socket (ADC Phase 3b Phase B — the plugin never opens the control socket):
//   createDevice → QR → poll (NOT awaited before the words) → four words → human confirm →
//   confirmWords (the DAEMON's words, never user-typed) → await enrolled → daemonInfo → tokenMint
//   (the first successful mint CLOSES the connection, so daemon_info comes first) → identity probe
//   over a short-lived session → { deviceId, agentUserId, ownerUserId, token }.
// The enrollment socket pins the connection to the one device it created, refuses `replace:true`
// and mints at most one token: a lost mint reply is never retried — the operator mints a fresh
// label at the CLI and pastes it into the token door (spec M20 b).
// Privacy: the QR payload, the words and the token are returned to the CALLER's rendering surface
// only; nothing in this module logs. `ControlError.detail` is never read.
import { AlreadyAttachedError, type AdcClient, type AdcClientOptions } from "@ademu/adc-client";
import { ConnectionClosedError, ControlError, ControlTimeoutError, type AdcControlClient, type FourWords, type PairingSnapshot } from "@ademu/adc-control";
import { normalizeId } from "./grammar.js";
import { DaemonAbortedError, type Attacher, type Attachment } from "./monitor/attach.js";
import type { DaemonIdentity } from "./config.js";

/** The enrollment socket's op table as the ceremony uses it (no `list_devices`, no `device_status`). */
export type ControlLike = Pick<AdcControlClient, "createDevice" | "confirmWords" | "cancelPairing" | "tokenMint" | "daemonInfo" | "pollPairing" | "close">;

export type EnrollmentFailure =
  | "aborted"
  | "cancelled"
  | "words_mismatch"
  | "revoked"
  | "retired"
  /** The daemon's enrollment budget is full (`enroll_quota`): no device was created. */
  | "enroll_quota"
  /** The account's token label already exists on the device: the enrollment socket cannot rotate it. */
  | "label_exists"
  /** The mint's reply was lost (connection closed / timed out with `token_mint` in flight): the label is occupied, the token unrecoverable. */
  | "mint_lost"
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
  /** The label the token was minted under (named in the revoke instruction if the config write fails). */
  tokenLabel: string;
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

/**
 * Mint the account's token — exactly once, never with `replace` (the enrollment socket refuses it and
 * closes the connection after the first successful mint). A reply lost in flight leaves the label
 * occupied and the token unrecoverable from here: `mint_lost`, and the caller prints the
 * mint-a-fresh-label instruction. `label_exists` is the same dead end (nothing can rotate it here).
 */
export async function mintAccountToken(params: Common & { deviceId: string }): Promise<{ token: string; tokenId: string; tokenLabel: string }> {
  const label = tokenLabelFor(params.accountId);
  await params.beforeEffect();
  throwIfAborted(params.signal);
  try {
    const minted = await params.control.tokenMint({ device_id: params.deviceId, label });
    return { token: minted.token, tokenId: minted.token_id, tokenLabel: label };
  } catch (err) {
    if (err instanceof ControlError && err.code === "label_exists") throw new EnrollmentError("label_exists");
    if (err instanceof ConnectionClosedError && err.op === "token_mint") throw new EnrollmentError("mint_lost");
    if (err instanceof ControlTimeoutError && err.op === "token_mint") throw new EnrollmentError("mint_lost");
    throw err;
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

/**
 * Identity facts from a PASTED token (the wizard's "I have a device token" door): the same session
 * probe without an expected device id — the token names the device. Hello and `get_self` must agree.
 */
export async function probeTokenIdentity(params: {
  token: string;
  sessionSocketPath: string;
  connectSession: Common["connectSession"];
  confirmTakeover?: (() => Promise<boolean>) | undefined;
  signal: AbortSignal;
}): Promise<{ deviceId: string; agentUserId: string; ownerUserId: string; agentUsername: string; agentDisplayName: string }> {
  throwIfAborted(params.signal);
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
    if (normalizeId(client.hello.device_id) !== normalizeId(self.device_id)) throw new EnrollmentError("identity_mismatch");
    if (normalizeId(client.hello.agent_user_id) !== normalizeId(self.user_id)) throw new EnrollmentError("identity_mismatch");
    return { deviceId: self.device_id, agentUserId: self.user_id, ownerUserId: self.owner_user_id, agentUsername: self.username, agentDisplayName: self.display_name };
  } finally {
    await client.close().catch(() => {});
  }
}

/** `daemon_info` BEFORE the mint: the first successful mint closes the enrollment connection (M20 a). */
async function finishWithToken(params: Common & { deviceId: string; onMinted?: RunEnrollmentParams["onMinted"] }): Promise<EnrollmentResult> {
  const info = await params.control.daemonInfo();
  const sessionSocketPath = info.session_socket_path;
  if (!sessionSocketPath) throw new EnrollmentError("daemon_too_old", "the Ademú device host does not report a session socket; upgrade adc");
  const { token, tokenId, tokenLabel } = await mintAccountToken(params);
  // A token now exists: anything failing from here on (the identity probe included) must name it.
  params.onMinted?.({ deviceId: params.deviceId, tokenLabel });
  const identity = await probeIdentity({ ...params, token, sessionSocketPath });
  return { deviceId: params.deviceId, token, tokenId, tokenLabel, sessionSocketPath, ...identity };
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
  /** Called once, right after the mint succeeds — before the identity probe that may still fail. */
  onMinted?: ((minted: { deviceId: string; tokenLabel: string }) => void) | undefined;
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
  const created = await createDeviceOrRefuse(control, params.agentName);
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

/**
 * `create_device` on the enrollment socket: a full admission budget (`enroll_quota`) is a typed
 * refusal (nothing was created); an op refused as out of scope (`enroll_scope`) means the other end
 * is not the enrollment socket we expected — never retried, surfaced as unexpected.
 */
export async function createDeviceOrRefuse(control: ControlLike, agentName: string): Promise<{ device_id: string; qr_payload: string }> {
  try {
    return await control.createDevice({ agent_name: agentName });
  } catch (err) {
    if (err instanceof ControlError && err.code === "enroll_quota") throw new EnrollmentError("enroll_quota");
    if (err instanceof ControlError && err.code === "enroll_scope") throw new EnrollmentError("unexpected_state", "the device host refused the ceremony op as out of scope");
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// EnrollmentLease: the resources of one ceremony, disposed exactly once on every terminal path.

export type EnrollmentLease = {
  readonly id: string;
  readonly accountId: string;
  readonly control: ControlLike;
  readonly attachment: Attachment;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  deviceId?: string;
  /** Set once the device reached a terminal state (no cancelPairing on dispose). */
  terminal: boolean;
  disposed: boolean;
  dispose(reason: string): Promise<void>;
};

export type EnrollmentLeaseDeps = {
  attacher: Attacher;
  /** Opens the ENROLLMENT socket (`connectEnroll`); the ceremony has no control connection at all. */
  connectEnroll: (socketPath: string) => Promise<ControlLike>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onDisposed?: ((lease: EnrollmentLease, reason: string) => void) | undefined;
  /** Called synchronously when a disposal starts (any path, TTL included) with its promise. */
  onDisposing?: ((lease: EnrollmentLease, disposal: Promise<void>) => void) | undefined;
};

export const ENROLLMENT_TTL_MS = 3 * 60_000;

/** Attaches to the device host in the SETUP role (may start an installed user service, never runs one) and opens an enrollment-socket connection. */
export async function createEnrollmentLease(params: {
  deps: EnrollmentLeaseDeps;
  accountId: string;
  identity: DaemonIdentity;
  beforeEffect: () => Promise<void>;
  signal?: AbortSignal | undefined;
  ttlMs?: number | undefined;
}): Promise<EnrollmentLease> {
  const { deps } = params;
  if (params.signal?.aborted) throw new DaemonAbortedError();
  const abort = new AbortController();
  // The caller's signal (a tool call's execution signal) governs ONLY the attach: a cancelled call
  // must not keep waiting for a service it asked to start. It is detached the moment the lease exists.
  // The ceremony then outlives the call by design — the phone scans minutes later — and OpenClaw
  // aborts a tool call's signal when the turn returns (verified 2026-09-18 on 2026.8.2 from Telegram:
  // the pairing poll stopped five seconds after `start`, the scan landed unseen, TTL retired the
  // device). From here on only dispose (any path, TTL included) aborts `lease.signal`.
  const forwardAbort = () => abort.abort();
  params.signal?.addEventListener("abort", forwardAbort, { once: true });
  let attachment: Attachment;
  let control: ControlLike;
  try {
    attachment = await deps.attacher.attach({
      identity: params.identity,
      role: "setup",
      signal: abort.signal,
      beforeEffect: params.beforeEffect,
    });
    try {
      control = await deps.connectEnroll(attachment.info.enrollSocketPath);
    } catch (err) {
      await attachment.release().catch(() => {});
      throw err;
    }
  } finally {
    params.signal?.removeEventListener("abort", forwardAbort);
  }
  const ttl = params.ttlMs ?? ENROLLMENT_TTL_MS;
  const lease: EnrollmentLease = {
    id: `${params.accountId}-${deps.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    accountId: params.accountId,
    control,
    attachment,
    signal: abort.signal,
    expiresAt: deps.now() + ttl,
    terminal: false,
    disposed: false,
    // Memoized: every caller (first or later) awaits the SAME cleanup; nobody returns early while it
    // runs. Whoever owns the lease (the tool registry) is told the moment a disposal STARTS — TTL
    // expiry included — so plugin shutdown can wait for it.
    dispose: (reason: string) => {
      if (!disposing) {
        disposing = runDispose(reason);
        deps.onDisposing?.(lease, disposing);
      }
      return disposing;
    },
  };
  let disposing: Promise<void> | undefined;
  const runDispose = async (reason: string): Promise<void> => {
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
        await attachment.release().catch(() => {});
        deps.onDisposed?.(lease, reason);
      }
    }
  };
  const timer = deps.setTimer(() => void lease.dispose("expired"), ttl);
  return lease;
}
