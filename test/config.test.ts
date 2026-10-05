import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accountIdForAgentName,
  addOwnerAllowFrom,
  AdemuChannelSchema,
  ademuConfigAdapter,
  ademuConfigSchema,
  canonicalizePath,
  defaultUserLayout,
  ENROLL_SOCKET_FILE,
  systemDataDir,
  inspectAdemuAccount,
  inspectAdemuAccountForEnrollment,
  listAdemuAccountIds,
  ownerAllowFromEntry,
  resolveAdemuAccount,
  resolveDaemonIdentity,
  validateDaemonIdentities,
} from "../src/config.js";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "ademu-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// HOME is the fixture's: the default identity is the installed user service's layout (#712), read
// from HOME's unit file — never the developer machine's real service.
const ENV = { ...process.env, OPENCLAW_STATE_DIR: join(tmp, "state"), HOME: join(tmp, "home"), XDG_DATA_HOME: "" } as NodeJS.ProcessEnv;
const USER_DATA = join(tmp, "home", ".local", "share", "adc");
const SYSTEM_DATA_DIR = systemDataDir();

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
    expect(iris.daemon.raw.enrollSocket).toBe(join(tmp, "shared", "adc-enroll.sock"));
    expect(iris.daemon.explicit).toEqual({ dataDir: true, socketPath: false, enrollSocketPath: false });
    expect(iris.daemon.scope).toBe("user");
  });

  it("the enrollment socket is derived under dataDir; an explicit enrollSocketPath wins (root or account)", () => {
    const c = cfg({
      dataDir: join(tmp, "own"),
      enrollSocketPath: join(tmp, "run", "adc-enroll.sock"),
      accounts: { a: { deviceId: "d", token: "t" }, b: { deviceId: "d", token: "t", enrollSocketPath: "~/b-enroll.sock" } },
    });
    const a = resolveAdemuAccount(c, "a", ENV);
    expect(a.daemon.raw.enrollSocket).toBe(join(tmp, "run", "adc-enroll.sock"));
    expect(a.daemon.explicit.enrollSocketPath).toBe(true);
    expect(a.daemon.raw.controlSocket).toBe(join(tmp, "own", "adc.sock"));
    const b = resolveAdemuAccount(c, "b", ENV);
    expect(b.daemon.raw.enrollSocket.endsWith("/b-enroll.sock")).toBe(true);
    expect(b.daemon.raw.enrollSocket.startsWith("~")).toBe(false);
    expect(ENROLL_SOCKET_FILE).toBe("adc-enroll.sock");
  });

  it("an account override of dataDir wins and moves the derived sockets", () => {
    const bob = resolveAdemuAccount(base, "bob", ENV);
    expect(bob.daemon.raw.dataDir).toBe(join(tmp, "bob"));
    expect(bob.daemon.raw.controlSocket).toBe(join(tmp, "bob", "adc.sock"));
  });

  it("#712: defaults the daemon to the installed user service's layout — all three sockets under its data dir", () => {
    const c = cfg({ accounts: { a: { deviceId: "d", token: "adc1_t" } } });
    const a = resolveAdemuAccount(c, "a", ENV, () => false);
    expect(defaultUserLayout(ENV).dataDir).toBe(USER_DATA);
    expect(a.daemon.raw).toEqual({
      dataDir: USER_DATA,
      controlSocket: join(USER_DATA, "adc.sock"),
      sessionSocket: join(USER_DATA, "adc-session.sock"),
      enrollSocket: join(USER_DATA, "adc-enroll.sock"),
    });
    expect(a.daemon.raw.dataDir.includes(join("state", "ademu"))).toBe(false);
  });

  it("#712: the installed unit's --data-dir is the default data dir", () => {
    const home = join(tmp, "home-unit");
    const unit = join(home, process.platform === "darwin" ? "Library/LaunchAgents/com.ademu.adc.plist" : ".config/systemd/user/adc.service");
    mkdirSync(join(unit, ".."), { recursive: true });
    const data = join(tmp, "svc-data");
    const body =
      process.platform === "darwin"
        ? `<plist><dict><key>ProgramArguments</key><array><string>/x/adc</string><string>daemon</string><string>run</string><string>--data-dir</string><string>${data}</string></array></dict></plist>`
        : `[Service]\nExecStart=/x/adc daemon run --data-dir ${data} --no-env\n`;
    writeFileSync(unit, body);
    const env = { ...ENV, HOME: home } as NodeJS.ProcessEnv;
    const id = resolveDaemonIdentity({}, env, () => false);
    expect(id.raw.dataDir).toBe(data);
    expect(id.raw.enrollSocket).toBe(join(data, "adc-enroll.sock"));
  });

  it("#712: channels.ademu.server is accepted (no config error) and ignored", () => {
    const c = cfg({ server: { wsUrl: "wss://staging.example/v1/ws" }, accounts: { a: { deviceId: "d", token: "t" } } });
    expect(AdemuChannelSchema.safeParse(c.channels!.ademu).success).toBe(true);
    const a = resolveAdemuAccount(c, "a", ENV, () => false);
    expect(a.serverConfigured).toBe(true);
    expect(a.daemon.raw.dataDir).toBe(USER_DATA);
    expect(resolveAdemuAccount(cfg({ accounts: { a: { deviceId: "d", token: "t" } } }), "a", ENV, () => false).serverConfigured).toBe(false);
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

  it("Codex #2: the enrollment socket may never be the control (or session) socket — a configError, before anything is dialled", () => {
    const c = cfg({ accounts: { a: { deviceId: "d", token: "t", dataDir: join(tmp, "dr"), enrollSocketPath: join(tmp, "dr", "adc.sock") } } });
    expect(validateDaemonIdentities(c, ENV).get("a")).toMatch(/must differ from the control and session sockets/);
    expect(inspectAdemuAccount(c, "a", ENV).configError).toMatch(/enrollment socket/);
    const c2 = cfg({ accounts: { a: { deviceId: "d", token: "t", dataDir: join(tmp, "dr"), enrollSocketPath: join(tmp, "dr", "adc-session.sock") } } });
    expect(validateDaemonIdentities(c2, ENV).get("a")).toMatch(/must differ/);
  });

  it("one enrollment socket shared by two data dirs collides", () => {
    const c = cfg({
      accounts: {
        a: { deviceId: "d", token: "t", dataDir: join(tmp, "e1"), enrollSocketPath: join(tmp, "shared-enroll.sock") },
        b: { deviceId: "d", token: "t", dataDir: join(tmp, "e2"), enrollSocketPath: join(tmp, "shared-enroll.sock") },
      },
    });
    const errors = validateDaemonIdentities(c, ENV);
    expect(errors.size).toBe(2);
    expect(errors.get("a")).toMatch(/enrollment socket .* shared by 2/);
  });

  it("two accounts naming different enrollment sockets for one data dir collide", () => {
    const c = cfg({
      accounts: {
        a: { deviceId: "d", token: "t", dataDir: join(tmp, "de"), enrollSocketPath: join(tmp, "de", "one-enroll.sock") },
        b: { deviceId: "d", token: "t", dataDir: join(tmp, "de"), enrollSocketPath: join(tmp, "de", "two-enroll.sock") },
      },
    });
    const errors = validateDaemonIdentities(c, ENV);
    expect([...errors.keys()].sort()).toEqual(["a", "b"]);
    expect(errors.get("a")).toMatch(/enrollment sockets/);
  });
});

describe("daemon scope: a hardened host (system-scope adc install) is attach-only", () => {
  const detected = () => true;

  it("with nothing configured and the detector firing, the identity IS the system layout, scope system", () => {
    const id = resolveDaemonIdentity({}, ENV, detected);
    expect(id.scope).toBe("system");
    const run = process.platform === "darwin" ? "/private/var/db/adc/run" : "/run/adc";
    expect(id.raw).toEqual({
      dataDir: SYSTEM_DATA_DIR,
      controlSocket: `${run}/adc.sock`,
      sessionSocket: `${run}/adc-session.sock`,
      enrollSocket: `${run}/adc-enroll.sock`,
    });
    expect(id.explicit).toEqual({ dataDir: false, socketPath: false, enrollSocketPath: false });
  });

  it("any explicit key (dataDir, socketPath or enrollSocketPath — root values included) keeps user scope and the configured paths", () => {
    for (const input of [{ dataDir: join(tmp, "x") }, { socketPath: join(tmp, "x.sock") }, { enrollSocketPath: join(tmp, "x-enroll.sock") }]) {
      const id = resolveDaemonIdentity(input, ENV, detected);
      expect(id.scope).toBe("user");
      expect(id.raw.dataDir).not.toBe(SYSTEM_DATA_DIR);
    }
    const c = cfg({ dataDir: join(tmp, "root"), accounts: { a: { deviceId: "d", token: "t" } } });
    expect(resolveAdemuAccount(c, "a", ENV, detected).daemon.scope).toBe("user");
  });

  it("every unconfigured account resolves to the one system identity — no collision", () => {
    const c = cfg({ accounts: { a: { deviceId: "d", token: "t" }, b: { deviceId: "e", token: "t" } } });
    expect(validateDaemonIdentities(c, ENV, detected).size).toBe(0);
    expect(inspectAdemuAccount(c, "a", ENV, detected).daemon.scope).toBe("system");
    expect(inspectAdemuAccount(c, "b", ENV, detected).daemon.dataDir).toBe(inspectAdemuAccount(c, "a", ENV, detected).daemon.dataDir);
  });

  it("without a system install the default identity is the user service's layout", () => {
    const id = resolveDaemonIdentity({}, ENV, () => false);
    expect(id.scope).toBe("user");
    expect(id.raw.dataDir).toBe(USER_DATA);
  });

  it("#712: the macOS system install is its own layout (/private/var/db/adc/run), not the Linux one", () => {
    const mac = resolveDaemonIdentity({}, ENV, () => true, undefined, "darwin");
    expect(mac.raw.enrollSocket).toBe("/private/var/db/adc/run/adc-enroll.sock");
    expect(mac.raw.dataDir).toBe("/Library/Application Support/adc");
    const linux = resolveDaemonIdentity({}, ENV, () => true, undefined, "linux");
    expect(linux.raw.enrollSocket).toBe("/run/adc/adc-enroll.sock");
    expect(linux.raw.dataDir).toBe("/var/lib/adc");
  });
});

describe("the recorded scope (daemonScope): an enrolled account stays on the device host that minted its token", () => {
  it("recorded user scope + a system install added later → still the default user-scope data dir; the detector is not consulted", () => {
    let consulted = 0;
    const id = resolveDaemonIdentity({ enrolledScope: "user" }, ENV, () => (consulted++, true));
    expect(id).toMatchObject({ scope: "user", scopeSource: "enrolled" });
    expect(id.raw.dataDir).toBe(USER_DATA);
    expect(consulted).toBe(0);
  });

  it("recorded system scope + no system install detected (down, or not up yet at boot) → the system layout, never a private daemon", () => {
    const id = resolveDaemonIdentity({ enrolledScope: "system" }, ENV, () => false, undefined, "linux");
    expect(id).toMatchObject({ scope: "system", scopeSource: "enrolled" });
    expect(id.raw.enrollSocket).toBe("/run/adc/adc-enroll.sock");
  });

  it("an explicit key beats the recorded scope: an operator who names paths gets exactly those paths", () => {
    const id = resolveDaemonIdentity({ enrolledScope: "system", dataDir: join(tmp, "named") }, ENV, () => true);
    expect(id).toMatchObject({ scope: "user", scopeSource: "explicit" });
    expect(id.raw.dataDir).toBe(join(tmp, "named"));
  });

  it("nothing recorded or configured → the detector decides (an account enrolled before the key)", () => {
    expect(resolveDaemonIdentity({}, ENV, () => true)).toMatchObject({ scope: "system", scopeSource: "detected" });
    expect(resolveDaemonIdentity({}, ENV, () => false)).toMatchObject({ scope: "user", scopeSource: "detected" });
  });

  it("the key is per account: accepted on an account, refused at the root and for any other value", () => {
    expect(AdemuChannelSchema.safeParse({ accounts: { a: { daemonScope: "system" } } }).success).toBe(true);
    expect(AdemuChannelSchema.safeParse({ daemonScope: "system" }).success).toBe(false);
    expect(AdemuChannelSchema.safeParse({ accounts: { a: { daemonScope: "root" } } }).success).toBe(false);
  });

  it("account resolution honours the recorded scope; the enrollment doors' resolution ignores it (a re-enrollment lands where the host points now)", () => {
    const c = cfg({ accounts: { a: { deviceId: "d", token: "t", daemonScope: "user" } } });
    expect(resolveAdemuAccount(c, "a", ENV, () => true).daemon).toMatchObject({ scope: "user", scopeSource: "enrolled" });
    expect(inspectAdemuAccount(c, "a", ENV, () => true).daemon).toMatchObject({ scope: "user", scopeSource: "enrolled" });
    expect(inspectAdemuAccountForEnrollment(c, "a", ENV, () => true).daemon).toMatchObject({ scope: "system", scopeSource: "detected" });
    expect(inspectAdemuAccountForEnrollment(c, "a", ENV, () => false).daemon).toMatchObject({ scope: "user", scopeSource: "detected" });
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

  it("deleting an account prunes exactly its own route binding and leaves every other row", () => {
    const rows = [
      { agentId: "iris", match: { channel: "ademu", accountId: "iris" } },
      { agentId: "ledger", match: { channel: "ademu", accountId: "*" } },
      { agentId: "iris", match: { channel: "telegram", accountId: "iris" } },
      { type: "acp", agentId: "x", match: { channel: "ademu", accountId: "iris" } },
    ];
    const withBindings = { ...two, bindings: rows } as unknown as OpenClawConfig;
    const next = ademuConfigAdapter.deleteAccount!({ cfg: withBindings, accountId: "iris" });
    expect((next as unknown as { bindings: unknown[] }).bindings).toEqual(rows.slice(1));
    // an account with no binding of its own leaves the array identical
    const untouched = ademuConfigAdapter.deleteAccount!({ cfg: withBindings, accountId: "eve" });
    expect((untouched as unknown as { bindings: unknown[] }).bindings).toEqual(rows);
  });
});

describe("manifest schema parity with the code schema", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8")) as {
    channelConfigs: { ademu: { schema: Record<string, unknown>; uiHints: Record<string, { sensitive?: boolean }> } };
  };

  it("the manifest channel schema IS the zod schema (regenerate with scripts/sync-manifest-schema.mjs)", () => {
    const derived = z.toJSONSchema(AdemuChannelSchema, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    delete derived.$schema;
    expect(manifest.channelConfigs.ademu.schema).toEqual(derived);
  });

  it("the derived schema is strict everywhere it matters (groups, accounts, token SecretRef variants)", () => {
    const schema = manifest.channelConfigs.ademu.schema as {
      additionalProperties: boolean;
      properties: {
        groups: { additionalProperties: { additionalProperties: boolean; properties: Record<string, unknown> } };
        accounts: { additionalProperties: { additionalProperties: boolean; properties: { token: { anyOf: Array<{ type?: string; oneOf?: Array<{ required: string[]; additionalProperties: boolean }> }> } } } };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.groups.additionalProperties.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.groups.additionalProperties.properties)).toContain("requireMention");
    expect(schema.properties.accounts.additionalProperties.additionalProperties).toBe(false);
    const token = schema.properties.accounts.additionalProperties.properties.token;
    expect(token.anyOf[0]).toEqual({ type: "string" });
    for (const variant of token.anyOf[1]!.oneOf!) {
      expect(variant.required).toEqual(["source", "provider", "id"]);
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("#712: the packaged manifest accepts the account shape the doors write (daemonScope, enrollSocketPath)", () => {
    const accounts = (manifest.channelConfigs.ademu.schema as {
      properties: { accounts: { additionalProperties: { additionalProperties: boolean; properties: Record<string, { enum?: string[]; type?: string }> } } };
    }).properties.accounts.additionalProperties;
    expect(accounts.additionalProperties).toBe(false);
    expect(accounts.properties.daemonScope?.enum).toEqual(["user", "system"]);
    expect(accounts.properties.enrollSocketPath?.type).toBe("string");
  });

  it("the token field is marked sensitive in both", () => {
    expect(ademuConfigSchema.uiHints?.["accounts.*.token"]?.sensitive).toBe(true);
    expect(manifest.channelConfigs.ademu.uiHints["accounts.*.token"]?.sensitive).toBe(true);
  });
});

describe("enrollment candidates are validated before any dial (Codex branch pass 5, #712 PR-b)", () => {
  it("a root enrollSocketPath naming the control socket is a configError for an account that does not exist yet", () => {
    const c = { channels: { ademu: { dataDir: "/d", enrollSocketPath: "/d/adc.sock" } } } as unknown as OpenClawConfig;
    expect(listAdemuAccountIds(c)).not.toContain("newbie");
    expect(inspectAdemuAccountForEnrollment(c, "newbie", ENV, () => false).configError).toMatch(/enrollment socket .* must differ/);
  });

  it("Codex branch pass 6: an enrollment socket that is ANOTHER account's control or session socket is a role error — for a candidate and for persisted accounts", () => {
    const b = { dataDir: "/b", enrollSocketPath: "/b/adc-enroll.sock" };
    const candidate = { channels: { ademu: { accounts: { b }, dataDir: "/a", enrollSocketPath: "/b/adc.sock" } } } as unknown as OpenClawConfig;
    expect(inspectAdemuAccountForEnrollment(candidate, "a", ENV, () => false).configError).toMatch(/enrollment socket \/b\/adc\.sock is another daemon's control or session socket/);
    const persisted = { channels: { ademu: { accounts: { b, a: { dataDir: "/a", enrollSocketPath: "/b/adc-session.sock" } } } } } as unknown as OpenClawConfig;
    expect(resolveAdemuAccount(persisted, "a", ENV, () => false).configError).toMatch(/is another daemon's control or session socket/);
    expect(inspectAdemuAccountForEnrollment(persisted, "a", ENV, () => false).configError).toMatch(/is another daemon's control or session socket/);
  });

  it("a candidate whose enrollment socket another data dir already uses collides", () => {
    const c = { channels: { ademu: { enrollSocketPath: "/a/adc-enroll.sock", accounts: { a: { dataDir: "/a" } }, dataDir: "/b" } } } as unknown as OpenClawConfig;
    expect(inspectAdemuAccountForEnrollment(c, "b", ENV, () => false).configError).toMatch(/enrollment socket \/a\/adc-enroll\.sock is shared/);
    // the runtime view of the existing account is unchanged by a candidate that does not exist
    expect(resolveAdemuAccount(c, "a", ENV, () => false).configError).toBeUndefined();
  });
});
