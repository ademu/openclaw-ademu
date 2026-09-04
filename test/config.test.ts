import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterAll, describe, expect, it } from "vitest";
import {
  accountIdForAgentName,
  addOwnerAllowFrom,
  ademuConfigAdapter,
  ademuConfigSchema,
  canonicalizePath,
  DEFAULT_SERVER,
  defaultDataDir,
  inspectAdemuAccount,
  listAdemuAccountIds,
  ownerAllowFromEntry,
  resolveAdemuAccount,
  resolveDaemonIdentity,
  validateDaemonIdentities,
} from "../src/config.js";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "ademu-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = { ...process.env, OPENCLAW_STATE_DIR: join(tmp, "state") } as NodeJS.ProcessEnv;

function cfg(channel: Record<string, unknown>, extra: Record<string, unknown> = {}): OpenClawConfig {
  return { channels: { ademu: channel }, ...extra } as unknown as OpenClawConfig;
}

describe("accounts and inheritance", () => {
  const base = cfg({
    dataDir: join(tmp, "shared"),
    accounts: {
      iris: { agentName: "Iris", deviceId: "d1", agentUserId: "a1", ownerUserId: "o1", token: "adc1_x" },
      bob: { agentName: "Bob", deviceId: "d2", agentUserId: "a2", ownerUserId: "o1", token: "adc1_y", dataDir: join(tmp, "bob") },
    },
    defaultAccount: "bob",
  });

  it("lists accounts and honours defaultAccount", () => {
    expect(listAdemuAccountIds(base).sort()).toEqual(["bob", "iris"]);
    expect(ademuConfigAdapter.defaultAccountId!(base)).toBe("bob");
  });

  it("inherits the root dataDir and derives both sockets beneath it", () => {
    const iris = resolveAdemuAccount(base, "iris", ENV);
    expect(iris.daemon.raw.dataDir).toBe(join(tmp, "shared"));
    expect(iris.daemon.raw.controlSocket).toBe(join(tmp, "shared", "adc.sock"));
    expect(iris.daemon.raw.sessionSocket).toBe(join(tmp, "shared", "adc-session.sock"));
    expect(iris.daemon.explicit).toEqual({ dataDir: true, socketPath: false });
  });

  it("an account override of dataDir wins and moves the derived sockets", () => {
    const bob = resolveAdemuAccount(base, "bob", ENV);
    expect(bob.daemon.raw.dataDir).toBe(join(tmp, "bob"));
    expect(bob.daemon.raw.controlSocket).toBe(join(tmp, "bob", "adc.sock"));
  });

  it("defaults the daemon under the OpenClaw state dir and the endpoints to production (R1/R11)", () => {
    const c = cfg({ accounts: { a: { deviceId: "d", token: "adc1_t" } } });
    const a = resolveAdemuAccount(c, "a", ENV);
    expect(a.daemon.raw.dataDir).toBe(join(tmp, "state", "ademu", "adc"));
    expect(defaultDataDir(ENV)).toBe(join(tmp, "state", "ademu", "adc"));
    expect(a.server).toEqual(DEFAULT_SERVER);
    expect(a.server.wsUrl.endsWith("/v1/ws")).toBe(true);
  });

  it("server overrides apply channel-wide", () => {
    const c = cfg({ server: { wsUrl: "wss://staging.example/v1/ws" }, accounts: { a: { deviceId: "d", token: "t" } } });
    expect(resolveAdemuAccount(c, "a", ENV).server).toEqual({ restBaseUrl: DEFAULT_SERVER.restBaseUrl, wsUrl: "wss://staging.example/v1/ws" });
  });

  it("slugs an agent name into a normalized account id", () => {
    expect(accountIdForAgentName("Iris")).toBe("iris");
    expect(accountIdForAgentName("Ademú Helper #2")).toBe("ademu-helper-2");
    expect(accountIdForAgentName("   ")).toBe("agent");
  });
});

describe("token status", () => {
  it("missing / available / configured_unavailable (SecretRef counts as configured)", () => {
    const c = cfg({
      accounts: {
        none: { deviceId: "d" },
        plain: { deviceId: "d", token: "adc1_abc" },
        ref: { deviceId: "d", token: { source: "env", provider: "default", id: "ADEMU_TOKEN" } },
      },
    });
    expect(inspectAdemuAccount(c, "none", ENV)).toMatchObject({ tokenStatus: "missing", tokenSource: "none", configured: false });
    expect(inspectAdemuAccount(c, "plain", ENV)).toMatchObject({ tokenStatus: "available", tokenSource: "config", configured: true });
    expect(inspectAdemuAccount(c, "ref", ENV)).toMatchObject({ tokenStatus: "configured_unavailable", tokenSource: "secretRef", configured: true });
    expect("token" in inspectAdemuAccount(c, "plain", ENV)).toBe(false);
    expect(resolveAdemuAccount(c, "plain", ENV).token).toBe("adc1_abc");
  });

  it("strict resolution throws on an unresolved SecretRef (the gateway resolves refs before runtime)", () => {
    const c = cfg({ accounts: { ref: { deviceId: "d", token: { source: "env", provider: "default", id: "X" } } } });
    expect(() => resolveAdemuAccount(c, "ref", ENV)).toThrow();
  });

  it("a disabled account is neither enabled nor configured", () => {
    const c = cfg({ accounts: { a: { enabled: false, deviceId: "d", token: "t" } } });
    expect(inspectAdemuAccount(c, "a", ENV)).toMatchObject({ enabled: false, configured: false });
    const c2 = cfg({ enabled: false, accounts: { a: { deviceId: "d", token: "t" } } });
    expect(inspectAdemuAccount(c2, "a", ENV).enabled).toBe(false);
  });
});

describe("daemon identity canonicalization and collisions (R1)", () => {
  it("collapses .., duplicate separators and symlinked ancestors", () => {
    const real = join(tmp, "real");
    mkdirSync(real, { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link);
    expect(canonicalizePath(join(tmp, "real", "x", "..", "y"))).toBe(canonicalizePath(join(link, "y")));
    expect(canonicalizePath(`${real}//adc/`)).toBe(canonicalizePath(join(link, "adc")));
  });

  it("two accounts naming different sockets for one data dir collide", () => {
    const c = cfg({
      accounts: {
        a: { deviceId: "d", token: "t", dataDir: join(tmp, "dd"), socketPath: join(tmp, "dd", "one.sock") },
        b: { deviceId: "d", token: "t", dataDir: join(tmp, "dd", "..", "dd"), socketPath: join(tmp, "dd", "two.sock") },
      },
    });
    const errors = validateDaemonIdentities(c, ENV);
    expect([...errors.keys()].sort()).toEqual(["a", "b"]);
    expect(resolveAdemuAccount(c, "a", ENV).configError).toMatch(/collision/);
  });

  it("one socket shared by two data dirs collides", () => {
    const c = cfg({
      accounts: {
        a: { deviceId: "d", token: "t", dataDir: join(tmp, "d1"), socketPath: join(tmp, "shared.sock") },
        b: { deviceId: "d", token: "t", dataDir: join(tmp, "d2"), socketPath: join(tmp, "shared.sock") },
      },
    });
    expect(validateDaemonIdentities(c, ENV).size).toBe(2);
  });

  it("the same identity expressed two ways is one identity, not a collision", () => {
    const c = cfg({
      accounts: {
        a: { deviceId: "d", token: "t", dataDir: join(tmp, "same") },
        b: { deviceId: "d", token: "t", dataDir: join(tmp, "same", "."), socketPath: join(tmp, "same", "adc.sock") },
      },
    });
    expect(validateDaemonIdentities(c, ENV).size).toBe(0);
    const a = resolveDaemonIdentity({ dataDir: join(tmp, "same") }, ENV);
    const b = resolveDaemonIdentity({ dataDir: join(tmp, "same", "."), socketPath: join(tmp, "same", "adc.sock") }, ENV);
    expect(a.dataDir).toBe(b.dataDir);
    expect(a.controlSocket).toBe(b.controlSocket);
  });
});

describe("owner authority entry (R3) and account deletion (Rider B)", () => {
  const two = cfg(
    {
      accounts: {
        iris: { deviceId: "d1", token: "t", ownerUserId: "owner-1" },
        bob: { deviceId: "d2", token: "t", ownerUserId: "owner-1" },
        eve: { deviceId: "d3", token: "t", ownerUserId: "owner-2" },
      },
    },
    { commands: { ownerAllowFrom: ["telegram:123", ownerAllowFromEntry("owner-1"), ownerAllowFromEntry("owner-2")] } },
  );

  it("addOwnerAllowFrom is idempotent and channel-scoped", () => {
    const c = addOwnerAllowFrom(cfg({}), "o9");
    expect((c as unknown as { commands: { ownerAllowFrom: string[] } }).commands.ownerAllowFrom).toEqual(["ademu:o9"]);
    expect(addOwnerAllowFrom(c, "o9")).toBe(c);
  });

  it("deleting an account whose owner is shared keeps the entry", () => {
    const next = ademuConfigAdapter.deleteAccount!({ cfg: two, accountId: "iris" });
    expect(listAdemuAccountIds(next).sort()).toEqual(["bob", "eve"]);
    const list = (next as unknown as { commands: { ownerAllowFrom: string[] } }).commands.ownerAllowFrom;
    expect(list).toContain("ademu:owner-1");
  });

  it("deleting the last account of an owner prunes exactly that entry", () => {
    const next = ademuConfigAdapter.deleteAccount!({ cfg: two, accountId: "eve" });
    const list = (next as unknown as { commands: { ownerAllowFrom: string[] } }).commands.ownerAllowFrom;
    expect(list).toEqual(["telegram:123", "ademu:owner-1"]);
  });
});

describe("manifest schema parity with the code schema", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8")) as {
    channelConfigs: { ademu: { schema: { properties: Record<string, unknown> & { accounts: { additionalProperties: { properties: Record<string, unknown> } } } } } };
  };
  const generated = ademuConfigSchema.schema as {
    properties: Record<string, unknown> & { accounts?: { additionalProperties?: { properties?: Record<string, unknown> } } };
  };

  it("root properties agree", () => {
    expect(Object.keys(manifest.channelConfigs.ademu.schema.properties).sort()).toEqual(Object.keys(generated.properties).sort());
  });

  it("account properties agree", () => {
    const m = Object.keys(manifest.channelConfigs.ademu.schema.properties.accounts.additionalProperties.properties).sort();
    const g = Object.keys(generated.properties.accounts?.additionalProperties?.properties ?? {}).sort();
    expect(m).toEqual(g);
  });

  it("the token field is marked sensitive in both", () => {
    expect(ademuConfigSchema.uiHints?.["accounts.*.token"]?.sensitive).toBe(true);
    const raw = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8")) as {
      channelConfigs: { ademu: { uiHints: Record<string, { sensitive?: boolean }> } };
    };
    expect(raw.channelConfigs.ademu.uiHints["accounts.*.token"]?.sensitive).toBe(true);
  });
});
