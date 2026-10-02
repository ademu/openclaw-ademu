import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDaemonIdentity } from "../src/config.js";
import { DaemonAttacher } from "../src/monitor/attach.js";
import { applyPluginSettings, DEFAULT_SETTINGS, getDaemonAttacher, setSharedForTests } from "../src/runtime.js";

describe("runtime", () => {
  it("#712: the PRODUCTION attacher is built from real deps and attaches the runtime to a host that is not there without starting anything", async () => {
    setSharedForTests(undefined);
    const attacher = getDaemonAttacher(() => {});
    expect(attacher).toBeInstanceOf(DaemonAttacher);
    expect(getDaemonAttacher(() => {})).toBe(attacher);
    // An explicit data dir that is no installed service's: real connectEnroll gets ENOENT, the runtime
    // attaches on the configured session path and names it as not running — no service manager call.
    const dataDir = join(mkdtempSync(join(tmpdir(), "ademu-attach-")), "adc");
    const identity = resolveDaemonIdentity({ dataDir }, process.env, () => false);
    const a = await attacher.attach({ identity, role: "runtime" });
    expect(a.info.sessionSocketPath).toBe(join(dataDir, "adc-session.sock"));
    expect(a.unreachable).toBe("not_running");
    setSharedForTests(undefined);
  });

  it("plugin settings clamp to the manifest schema and default sanely", () => {
    expect(applyPluginSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(applyPluginSettings({ typingKeepaliveMs: 100 }).typingKeepaliveMs).toBe(2000);
    expect(applyPluginSettings({ typingKeepaliveMs: 3000, mentionAliases: ["iris", "", 5] }).mentionAliases).toEqual(["iris"]);
    // Clamped below Ademú's ~3 s receiver TTL (AdemuMLS#621): the schema range stays, the runtime caps it.
    expect(applyPluginSettings({ typingKeepaliveMs: 3000 }).typingKeepaliveMs).toBe(2500);
    expect(applyPluginSettings({ typingKeepaliveMs: 10_000 }).typingKeepaliveMs).toBe(2500);
    expect(applyPluginSettings({ typingKeepaliveMs: 2000 }).typingKeepaliveMs).toBe(2000);
    expect(applyPluginSettings({ typingKeepaliveMs: 2500 }).typingKeepaliveMs).toBe(2500);
  });
});
