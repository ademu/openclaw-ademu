// Status vocabulary (plan T6/V18): one CLOSED table from error classes to ChannelAccountSnapshot
// patches. `blocked` (terminal, sticky until a gateway restart or an explicit ready patch) is used
// ONLY for user-actionable failures; everything transient is `recovering`. `lastError` is always
// our own copy — never an error's `.message`/`.detail` (peer-controlled text).
import {
  AlreadyAttachedError,
  DeviceNotReadyError,
  InvalidTokenError,
  LineTooLongError,
  ProtocolViolationError,
  SessionRejectedError,
} from "@ademu/adc-client";
import { PrivilegeError } from "@ademu/adc-control";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { strings } from "./i18n/strings.js";
import {
  AdcServiceNotAnsweringError,
  AdcServiceNotInstalledError,
  AdcTooOldError,
  DaemonUnreachableError,
  DaemonUnsupportedError,
  SessionSocketMovedError,
  type Unreachable,
} from "./monitor/attach.js";

export class IdentityMismatchError extends Error {
  constructor() {
    super("account identity mismatch");
    this.name = "IdentityMismatchError";
  }
}
/** The account was aborted while its session was connecting / warming up. */
export class SessionAbortedError extends Error {
  constructor() {
    super("session open aborted");
    this.name = "SessionAbortedError";
  }
}
/** A reconnect warm-up (conversations/members) failed: transient — the account restarts. */
export class SessionWarmupError extends Error {
  constructor() {
    super("session warm-up failed after reconnect");
    this.name = "SessionWarmupError";
  }
}
/** A frame the daemon should never send (e.g. a non-integer `seq`): terminal, user must restart. */
export class IngressProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngressProtocolError";
  }
}
export class IngressHaltedError extends Error {
  constructor(readonly cause: unknown) {
    super("ingress halted before adoption");
    this.name = "IngressHaltedError";
  }
}

export type StatusPatch = Record<string, unknown>;

export function readyPatch(): StatusPatch {
  return channelReadyPatch();
}

export function recoveringPatch(lastError: string, extras: StatusPatch = {}): StatusPatch {
  return { connected: false, lifecycle: "recovering", lastError, ...extras };
}

export function blockedPatch(lastError: string): StatusPatch {
  return channelBlockedPatch(lastError, { connected: false });
}

export type Classified = { kind: "blocked" | "recovering"; lastError: string; ingressUnavailable?: true };

/** The closed mapping. Unknown errors are `recovering` with the class NAME only. */
export function classifyError(err: unknown): Classified {
  if (err instanceof InvalidTokenError) return { kind: "blocked", lastError: strings.status.tokenRevoked };
  if (err instanceof DeviceNotReadyError) return { kind: "blocked", lastError: strings.status.notEnrolled };
  if (err instanceof AlreadyAttachedError) return { kind: "blocked", lastError: strings.status.displaced };
  if (err instanceof ProtocolViolationError || err instanceof LineTooLongError || err instanceof IngressProtocolError) {
    return { kind: "blocked", lastError: strings.status.protocolViolation };
  }
  if (err instanceof IdentityMismatchError) return { kind: "blocked", lastError: strings.status.identityMismatch };
  // Every session rejection is terminal by the client's contract — future codes arrive as the base class.
  if (err instanceof SessionRejectedError) return { kind: "blocked", lastError: strings.status.sessionRejected };
  if (err instanceof SessionWarmupError) return { kind: "recovering", lastError: strings.status.warmupFailed };
  if (err instanceof DaemonUnsupportedError) return { kind: "blocked", lastError: err.message };
  // A restart cannot fix permissions: the hardened host's refusal is user-actionable, never a loop.
  if (err instanceof PrivilegeError) return { kind: "blocked", lastError: strings.status.privilegeDenied };
  // An upgrade restarts the service, but this account still needs a gateway restart to re-check.
  if (err instanceof AdcTooOldError) return { kind: "blocked", lastError: strings.status.adcTooOld };
  // The installed device host (#712): everything below is fixed by the user starting/installing adc,
  // which the gateway's restart loop then picks up — `recovering`, never `blocked`.
  if (err instanceof AdcServiceNotInstalledError) return { kind: "recovering", lastError: strings.status.adcNotInstalled };
  if (err instanceof AdcServiceNotAnsweringError) {
    return { kind: "recovering", lastError: err.disabled ? strings.status.adcServiceDisabled : strings.status.adcNotAnswering(err.layout.dataDir) };
  }
  if (err instanceof DaemonUnreachableError) return { kind: "recovering", lastError: err.message };
  if (err instanceof SessionSocketMovedError) return { kind: "recovering", lastError: strings.status.sessionSocketMoved };
  if (err instanceof IngressHaltedError) return { kind: "recovering", lastError: strings.status.ingressHalted, ingressUnavailable: true };
  const name = err instanceof Error ? err.name || err.constructor.name : typeof err;
  return { kind: "recovering", lastError: `error: ${name}` };
}

export function patchFor(err: unknown): StatusPatch {
  const c = classifyError(err);
  if (c.kind === "blocked") return blockedPatch(c.lastError);
  return recoveringPatch(c.lastError, c.ingressUnavailable ? { ingressUnavailable: true } : {});
}

/** The `recovering` copy for a runtime attachment that found nothing answering (#712). */
export function unreachableCopy(why: Unreachable): string {
  switch (why) {
    case "not_installed":
      return strings.status.adcNotInstalled;
    case "disabled":
      return strings.status.adcServiceDisabled;
    case "system_down":
      return strings.status.systemDaemonDown;
    case "not_running":
      return strings.status.adcNotRunning;
  }
}
