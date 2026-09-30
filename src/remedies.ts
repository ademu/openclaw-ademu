// Fixed, non-sensitive remedy copy for known failures of the enrollment doors (wizard + tool). Never
// interpolates an error's `.message`/`.detail` from the daemon; only our own strings and paths. The
// optional context (the daemon identity, the device id, the token label) lets the operator
// instructions name the right commands (spec M20 b–d).
import { DeviceNotReadyError, InvalidTokenError } from "@ademu/adc-client";
import { NotInstalledError, DaemonUnreachableError as ControlDaemonUnreachableError, PrivilegeError } from "@ademu/adc-control";
import { PlatformPackageMissingError, UnsupportedPlatformError } from "@ademu/adc-bin";
import { EnrollmentError } from "./ceremony.js";
import { strings } from "./i18n/strings.js";
import { DaemonBusyError, DaemonUnreachableError, DaemonUnsupportedError } from "./monitor/daemon.js";
import { adcCommandPrefix, mintFreshLabelCommand, operatorCeremony, type OperatorContext } from "./operator.js";

export function remedyFor(err: unknown, ctx: OperatorContext = {}): string | undefined {
  if (err instanceof NotInstalledError || err instanceof PlatformPackageMissingError) return strings.enroll.notInstalled;
  if (err instanceof UnsupportedPlatformError) return strings.status.unsupportedPlatform(err.platform);
  if (err instanceof DaemonUnsupportedError) return err.message; // our own copy
  if (err instanceof DaemonBusyError) return err.message; // our own copy
  if (err instanceof DaemonUnreachableError) return strings.enroll.daemonUnreachable(err.logPath);
  if (err instanceof ControlDaemonUnreachableError) return strings.enroll.daemonUnreachable(undefined);
  // The hardened host: the enrollment socket refused this uid, or the client refused to spawn beside a
  // system install. The operator ceremony is the fallback (M20 d); the client's message is never shown.
  if (err instanceof PrivilegeError) return strings.enroll.operatorInstructions(operatorCeremony(ctx));
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
