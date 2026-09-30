// The copy layer for the hardened host (spec M20 b–d): every instruction is composed from the daemon
// identity — never from an error's message — and names this host's commands.
import { DeviceNotReadyError, InvalidTokenError } from "@ademu/adc-client";
import { PrivilegeError } from "@ademu/adc-control";
import { describe, expect, it } from "vitest";
import { EnrollmentError } from "../src/ceremony.js";
import type { DaemonIdentity } from "../src/config.js";
import { adcCommandPrefix, mintFreshLabelCommand, operatorCeremony, revokeLabelCommand } from "../src/operator.js";
import { remedyFor } from "../src/remedies.js";
import { classifyError } from "../src/status.js";

const user: DaemonIdentity = {
  dataDir: "/home/me/.openclaw/ademu/adc",
  controlSocket: "/home/me/.openclaw/ademu/adc/adc.sock",
  sessionSocket: "/home/me/.openclaw/ademu/adc/adc-session.sock",
  enrollSocket: "/home/me/.openclaw/ademu/adc/adc-enroll.sock",
  raw: {
    dataDir: "/home/me/.openclaw/ademu/adc",
    controlSocket: "/home/me/.openclaw/ademu/adc/adc.sock",
    sessionSocket: "/home/me/.openclaw/ademu/adc/adc-session.sock",
    enrollSocket: "/home/me/.openclaw/ademu/adc/adc-enroll.sock",
  },
  explicit: { dataDir: false, socketPath: false, enrollSocketPath: false },
  scope: "user",
};
const system: DaemonIdentity = { ...user, dataDir: "/var/lib/adc", raw: { ...user.raw, dataDir: "/var/lib/adc" }, scope: "system" };
const DEVICE = "aaaaaaaa-1111-4222-8333-444444444444";

describe("operator commands", () => {
  it("the CLI prefix follows the scope: sudo adc --system on a system install, ADC_DATA_DIR=<plugin dir> adc at user scope, bare adc when unknown", () => {
    expect(adcCommandPrefix(system)).toBe("sudo adc --system");
    expect(adcCommandPrefix(user)).toBe("ADC_DATA_DIR=/home/me/.openclaw/ademu/adc adc");
    expect(adcCommandPrefix(undefined)).toBe("adc");
  });

  it("the operator ceremony names the three steps and the token door", () => {
    const steps = operatorCeremony({ identity: system, agentName: "Iris", label: "openclaw-iris" });
    expect(steps).toContain('sudo adc --system agent add "Iris"');
    expect(steps).toContain("sudo adc --system token mint <device_id> --label openclaw-iris");
    expect(steps).toContain("openclaw channels add --channel ademu");
    expect(steps).toContain("I have a device token");
  });

  it("a lost mint mints a FRESH label (never the taken one); an orphaned token is revoked by its label", () => {
    expect(mintFreshLabelCommand({ identity: user, deviceId: DEVICE, label: "openclaw-iris" })).toBe(`ADC_DATA_DIR=/home/me/.openclaw/ademu/adc adc token mint ${DEVICE} --label openclaw-iris-2`);
    expect(revokeLabelCommand({ identity: system, deviceId: DEVICE, label: "openclaw-iris" })).toBe(`sudo adc --system token revoke ${DEVICE} --label openclaw-iris`);
  });
});

describe("remedies", () => {
  it("PrivilegeError → the operator instructions for THIS host; the client's message never appears", () => {
    const err = new PrivilegeError("permission denied opening the enrollment socket at /run/adc/adc-enroll.sock — SECRET-SHAPED", "permission_denied");
    const remedy = remedyFor(err, { identity: system, label: "openclaw-iris", agentName: "Iris" })!;
    expect(remedy).toContain("sudo adc --system agent add");
    expect(remedy).toContain("I have a device token");
    expect(remedy).not.toContain("SECRET-SHAPED");
    expect(remedyFor(err)).toContain("adc agent add"); // no identity: bare adc
  });

  it("enroll_quota → the quota copy with cancel + list commands and the ceremony; mint_lost / label_exists → the fresh-label instruction", () => {
    const quota = remedyFor(new EnrollmentError("enroll_quota"), { identity: user })!;
    expect(quota).toContain("enrollment budget is full");
    expect(quota).toContain("ADC_DATA_DIR=/home/me/.openclaw/ademu/adc adc agent cancel <device_id>");
    const lost = remedyFor(new EnrollmentError("mint_lost"), { identity: system, deviceId: DEVICE, label: "openclaw-iris" })!;
    expect(lost).toContain(`sudo adc --system token mint ${DEVICE} --label openclaw-iris-2`);
    expect(lost).toContain("Nothing was written");
    expect(remedyFor(new EnrollmentError("label_exists"), { identity: system, deviceId: DEVICE, label: "openclaw-iris" })).toBe(lost);
  });

  it("the token door's session errors have their own copy", () => {
    expect(remedyFor(new InvalidTokenError())).toContain("rejected that token");
    expect(remedyFor(new DeviceNotReadyError())).toContain("not enrolled yet");
  });
});

describe("status classification", () => {
  it("PrivilegeError is blocked (user-actionable), never a restart loop", () => {
    expect(classifyError(new PrivilegeError("x", "permission_denied"))).toMatchObject({ kind: "blocked" });
    expect(classifyError(new PrivilegeError("x")).lastError).toContain("refused this user");
  });
});
