// Fixed, non-sensitive remedy copy for known failures of the enrollment doors (wizard + tool). Never
// interpolates an error's `.message`/`.detail` from the daemon; only our own strings and paths.
import { NotInstalledError, DaemonUnreachableError as ControlDaemonUnreachableError } from "@ademu/adc-control";
import { PlatformPackageMissingError, UnsupportedPlatformError } from "@ademu/adc-bin";
import { EnrollmentError } from "./ceremony.js";
import { strings } from "./i18n/strings.js";
import { DaemonBusyError, DaemonUnreachableError, DaemonUnsupportedError } from "./monitor/daemon.js";

export function remedyFor(err: unknown): string | undefined {
  if (err instanceof NotInstalledError || err instanceof PlatformPackageMissingError) return strings.enroll.notInstalled;
  if (err instanceof UnsupportedPlatformError) return strings.status.unsupportedPlatform(err.platform);
  if (err instanceof DaemonUnsupportedError) return err.message; // our own copy
  if (err instanceof DaemonBusyError) return err.message; // our own copy
  if (err instanceof DaemonUnreachableError) return strings.enroll.daemonUnreachable(err.logPath);
  if (err instanceof ControlDaemonUnreachableError) return strings.enroll.daemonUnreachable(undefined);
  if (err instanceof EnrollmentError) {
    switch (err.reason) {
      case "words_mismatch":
        return strings.enroll.wordsMismatch;
      case "cancelled":
      case "aborted":
        return strings.enroll.cancelled;
      case "not_enrolled":
        return strings.enroll.notEnrolledDevice;
      case "device_attached":
        return strings.enroll.deviceAttachedRefused;
      case "label_exists":
        return strings.enroll.cancelled;
      default:
        return `${strings.enroll.cancelled} (${err.reason})`;
    }
  }
  return undefined;
}
