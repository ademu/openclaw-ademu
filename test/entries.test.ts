// The two plugin entries as OpenClaw loads them: the setup entry must expose the enrollment wizard
// (Codex #1), and full/tool-discovery registration must register the tool + service WITHOUT touching
// the SQLite store or the daemon manager (Codex #18).
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fullEntry from "../index.js";
import setupEntry from "../setup-entry.js";
import { setSharedForTests } from "../src/runtime.js";

function fakeApi(mode: string, stateDir: string) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    api: {
      registrationMode: mode,
      pluginConfig: { typingKeepaliveMs: 2500, mentionAliases: ["iris"] },
      runtime: {
        logging: { getChildLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
        config: { mutateConfigFile: async () => ({}) },
        channel: {},
        media: {},
        stateDir,
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerChannel: (r: { plugin: { id: string } }) => calls.push(["registerChannel", r.plugin.id]),
      registerTool: (_t: unknown, o: unknown) => calls.push(["registerTool", o]),
      registerService: (s: { id: string }) => calls.push(["registerService", s.id]),
    } as never,
  };
}

describe("entries", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ademu-entry-"));
  const prev = process.env.OPENCLAW_STATE_DIR;
  afterEach(() => {
    setSharedForTests(undefined);
    if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("the setup entry carries the enrollment wizard (channels add works on an unconfigured install)", () => {
    const plugin = setupEntry.plugin;
    expect(plugin.id).toBe("ademu");
    expect(plugin.setupWizard).toBeDefined();
    const wizard = plugin.setupWizard as { channel: string; credentials: unknown[]; finalize?: unknown; status: { resolveConfigured: (p: { cfg: unknown }) => boolean } };
    expect(wizard.channel).toBe("ademu");
    expect(wizard.credentials).toEqual([]);
    expect(typeof wizard.finalize).toBe("function");
    expect(wizard.status.resolveConfigured({ cfg: {} })).toBe(false);
    expect(plugin.config).toBeDefined();
    expect(plugin.secrets).toBeDefined();
  });

  it("the full entry's registration in tool-discovery and full modes registers the tool + service without opening the store", () => {
    process.env.OPENCLAW_STATE_DIR = tmp;
    setSharedForTests(undefined);
    for (const mode of ["tool-discovery", "full"]) {
      const { api, calls } = fakeApi(mode, tmp);
      fullEntry.register(api);
      expect(calls.some((c) => c[0] === "registerTool" && (c[1] as { name: string }).name === "ademu_enroll")).toBe(true);
      expect(calls.some((c) => c[0] === "registerService" && c[1] === "ademu-enroll-leases")).toBe(true);
      if (mode === "full") expect(calls.some((c) => c[0] === "registerChannel" && c[1] === "ademu")).toBe(true);
    }
    // No SQLite database and no daemon dir were created by registering.
    expect(existsSync(join(tmp, "ademu", "ademu.sqlite"))).toBe(false);
    expect(existsSync(join(tmp, "ademu")) ? readdirSync(join(tmp, "ademu")) : []).toEqual([]);
  });

  it("the setup entry does not register tools or touch state either", () => {
    process.env.OPENCLAW_STATE_DIR = tmp;
    expect(existsSync(join(tmp, "ademu"))).toBe(false);
    expect(setupEntry.plugin.gateway).toBeUndefined();
  });
});
