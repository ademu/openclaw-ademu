// Fixed, non-sensitive remedy copy for known failures of the enrollment doors (wizard + tool). Never
// interpolates an error's `.message`/`.detail` from the daemon; only our own strings and paths. The
// optional context (the daemon identity, the device id, the token label) lets the operator
// instructions name the right commands (spec M20 b–d).
import { DeviceNotReadyError, InvalidTokenError } from "@ademu/adc-client";
import { PrivilegeError } from "@ademu/adc-control";
import { EnrollmentError } from "./ceremony.js";
import { strings } from "./i18n/strings.js";
import {
  AdcServiceNotAnsweringError,
  AdcServiceNotInstalledError,
  AdcTooOldError,
  DaemonUnreachableError,
  DaemonUnsupportedError,
} from "./monitor/attach.js";
import { adcCommandPrefix, mintFreshLabelCommand, operatorCeremony, type OperatorContext } from "./operator.js";

/** A socket that is absent or not listening (the client passes Node's own error through unchanged). */
function isConnectFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return err instanceof Error && typeof code === "string" && ["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code);
}

export function remedyFor(err: unknown, ctx: OperatorContext = {}): string | undefined {
  if (err instanceof DaemonUnsupportedError) return err.message; // our own copy
  // The installed device host (#712): the plugin attaches to it and never runs one.
  if (err instanceof AdcServiceNotInstalledError) return strings.status.adcNotInstalled;
  if (err instanceof AdcServiceNotAnsweringError) {
    return err.disabled ? strings.status.adcServiceDisabled : strings.status.adcNotAnswering(err.layout.dataDir);
  }
  if (err instanceof AdcTooOldError) return strings.status.adcTooOld;
  if (err instanceof DaemonUnreachableError) return err.message; // our own copy
  // The hardened host: the enrollment socket refused this uid, or the client refused to spawn beside a
  // system install. The operator ceremony is the fallback (M20 d); the client's message is never shown.
  if (err instanceof PrivilegeError) return strings.enroll.operatorInstructions(operatorCeremony(ctx));
  // The enrollment socket is absent or silent (a system daemon that vanished after detection, a
  // foreign user-scope daemon that is down): the operator ceremony is the fallback (M20 d).
  if (isConnectFailure(err)) return strings.enroll.enrollSocketUnreachable(operatorCeremony(ctx));
  if (err instanceof InvalidTokenError) return strings.enroll.tokenRejected;
  if (err instanceof DeviceNotReadyError) return strings.enroll.notEnrolledDevice;
  if (err instanceof EnrollmentError) {
    switch (err.reason) {
      case "words_mismatch":
        return strings.enroll.wordsMismatch;
      case "cancelled":
      case "aborted":
        return strings.enroll.cancelled;
      case "device_attached":
        return strings.enroll.deviceAttachedRefused;
      case "enroll_quota":
        return strings.enroll.quotaFull(adcCommandPrefix(ctx.identity), operatorCeremony(ctx));
      case "mint_lost":
      case "label_exists":
        return strings.enroll.mintLost(mintFreshLabelCommand(ctx));
      default:
        return `${strings.enroll.cancelled} (${err.reason})`;
    }
  }
  return undefined;
}
