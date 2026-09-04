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
} from "@ademu/adc-client";
import { PlatformPackageMissingError, UnsupportedPlatformError } from "@ademu/adc-bin";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { strings } from "./i18n/strings.js";
import { DaemonBusyError, DaemonLostError, DaemonUnreachableError, DaemonUnsupportedError } from "./monitor/daemon.js";

export class IdentityMismatchError extends Error {
  constructor() {
    super("account identity mismatch");
    this.name = "IdentityMismatchError";
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
  if (err instanceof ProtocolViolationError || err instanceof LineTooLongError) {
    return { kind: "blocked", lastError: strings.status.protocolViolation };
  }
  if (err instanceof IdentityMismatchError) return { kind: "blocked", lastError: strings.status.identityMismatch };
  if (err instanceof UnsupportedPlatformError) return { kind: "blocked", lastError: strings.status.unsupportedPlatform(err.platform) };
  if (err instanceof DaemonUnsupportedError) return { kind: "blocked", lastError: err.message };
  if (err instanceof PlatformPackageMissingError) return { kind: "blocked", lastError: strings.status.daemonUnreachable(undefined) };
  if (err instanceof DaemonUnreachableError) return { kind: "recovering", lastError: strings.status.daemonUnreachable(err.logPath) };
  if (err instanceof DaemonLostError) return { kind: "recovering", lastError: strings.status.daemonLost };
  if (err instanceof DaemonBusyError) return { kind: "recovering", lastError: err.message };
  if (err instanceof IngressHaltedError) return { kind: "recovering", lastError: strings.status.ingressHalted, ingressUnavailable: true };
  const name = err instanceof Error ? err.name || err.constructor.name : typeof err;
  return { kind: "recovering", lastError: `error: ${name}` };
}

export function patchFor(err: unknown): StatusPatch {
  const c = classifyError(err);
  if (c.kind === "blocked") return blockedPatch(c.lastError);
  return recoveringPatch(c.lastError, c.ingressUnavailable ? { ingressUnavailable: true } : {});
}
