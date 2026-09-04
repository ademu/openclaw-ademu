// startAccount lifecycle (plan T10): lease → session → ingress → ready; outcomes; cleanup ordering
// under the deadline; blocked vs restart contract with the gateway supervisor.
import { InvalidTokenError } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedAdemuAccount } from "../src/config.js";
import { DaemonLostError, DaemonUnreachableError, DaemonUnsupportedError, type DaemonManager, type Lease } from "../src/monitor/daemon.js";
import { DRAIN_CAP_MS, RELEASE_TAIL_MS, STOP_DEADLINE_MS, startAccount, type StartAccountDeps } from "../src/monitor/index.js";
import type { RuntimeChannelSurface } from "../src/monitor/ingress.js";
import { getLiveAccount, resetLiveAccountsForTests } from "../src/outbound.js";
import { AdemuStore } from "../src/store.js";
import { AGENT, DEVICE, FakeAdcClient, fakeConnect, member, OWNER, ROOM_DM } from "./fakes/adc.js";

const cfg = { channels: { ademu: { accounts: { iris: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER, token: "t" } } } } } as unknown as OpenClawConfig;

function account(over: Partial<ResolvedAdemuAccount> = {}): ResolvedAdemuAccount {
  return {
    accountId: "iris",
    enabled: true,
    configured: true,
    agentName: "Iris",
    deviceId: DEVICE,
    agentUserId: AGENT,
    ownerUserId: OWNER,
    token: "t",
    tokenStatus: "available",
    tokenSource: "config",
    daemon: { dataDir: "/d", controlSocket: "/d/adc.sock", sessionSocket: "/d/adc-session.sock", raw: {}, explicit: {} } as never,
    server: { restBaseUrl: "https://api.example", wsUrl: "wss://gw.example/v1/ws" },
    ...over,
  };
}

type FakeLease = Lease & { released: number; lose: (err: unknown) => void };

function fakeDaemons(opts: { acquire?: () => Promise<void> } = {}) {
  const calls: unknown[] = [];
  let lease: FakeLease | undefined;
  const daemons = {
    acquire: async (params: unknown) => {
      calls.push(params);
      await opts.acquire?.();
      let lose!: (err: unknown) => void;
      const lost = new Promise<never>((_, reject) => {
        lose = reject;
      });
      lease = {
        mode: "owned",
        role: "runtime",
        identity: (params as { identity: unknown }).identity as never,
        holderId: "h1",
        info: { controlSocketPath: "/d/adc.sock", sessionSocketPath: "/d/adc-session.sock" },
        lost,
        released: 0,
        lose,
        release: async () => {
          lease!.released++;
        },
      };
      return lease;
    },
  } as unknown as DaemonManager;
  return { daemons, calls, lease: () => lease };
}

function runtimeSurface(): RuntimeChannelSurface {
  return {
    inbound: {
      buildContext: (p) => ({ ctx: p }),
      dispatch: () => new Promise(() => {}),
    },
    routing: { resolveAgentRoute: (input) => ({ agentId: "main", accountId: String(input.accountId), sessionKey: "agent:main:ademu:x", dmScope: "main" }) },
    commands: { shouldComputeCommandAuthorized: () => false, isControlCommandMessage: () => false },
  };
}

function world(opts: { platform?: string; connectError?: unknown; acquireError?: unknown } = {}) {
  const client = new FakeAdcClient();
  client.room(ROOM_DM, [member(OWNER, "human", "Marios"), member(AGENT, "agent", "Iris")]);
  const { connect } = fakeConnect(client);
  const statuses: Array<Record<string, unknown>> = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
  const ac = new AbortController();
  const dm = fakeDaemons({
    acquire: async () => {
      if (opts.acquireError) throw opts.acquireError;
    },
  });
  let now = 0;
  const deps: StartAccountDeps = {
    store: AdemuStore.open({ path: ":memory:" }),
    daemons: dm.daemons,
    session: {
      connect: async (o) => {
        if (opts.connectError) throw opts.connectError;
        return connect(o);
      },
      now: () => now,
      log: () => {},
    },
    runtime: runtimeSurface(),
    settings: { typingKeepaliveMs: 2000, mentionAliases: [] },
    platform: opts.platform ?? "darwin",
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (event, fields) => logs.push({ event, fields }),
  };
  const ctx = {
    cfg,
    accountId: "iris",
    account: account(),
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    abortSignal: ac.signal,
    getStatus: () => ({ accountId: "iris" }),
    setStatus: (s: Record<string, unknown>) => statuses.push(s),
  } as never;
  return { client, statuses, logs, ac, dm, deps, ctx, tick: (ms: number) => (now += ms) };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => resetLiveAccountsForTests());

describe("startAccount: happy path and abort", () => {
  it("acquires a runtime lease, opens the session, registers the live account, publishes ready, and cleans up in order on abort", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    expect(w.dm.calls).toHaveLength(1);
    expect((w.dm.calls[0] as { role: string }).role).toBe("runtime");
    expect(w.statuses.some((s) => s.lifecycle === "starting")).toBe(true);
    expect(w.statuses.at(-1)).toMatchObject({ connected: true });
    expect(getLiveAccount("iris").client).toBe(w.client);
    expect(getLiveAccount("iris").conversationKind?.(ROOM_DM)).toBe("direct");

    w.ac.abort();
    await run; // resolves (no throw) on abort
    expect(w.client.closed).toBe(true);
    expect(w.dm.lease()!.released).toBe(1);
    expect(() => getLiveAccount("iris")).toThrow(/not running/);
    expect(w.statuses.at(-1)).toMatchObject({ running: false, lifecycle: "stopped" });
    // the drain wait never exceeds the cap and leaves the release tail
    expect(DRAIN_CAP_MS).toBeLessThanOrEqual(STOP_DEADLINE_MS - RELEASE_TAIL_MS);
  });
});

describe("startAccount: restart outcomes (throw)", () => {
  it("an owned daemon loss → recovering + rejects (the supervisor restarts), lease still released", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.dm.lease()!.lose(new DaemonLostError("exited"));
    await expect(run).rejects.toBeInstanceOf(DaemonLostError);
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "recovering" });
    expect(w.dm.lease()!.released).toBe(1);
    expect(w.client.closed).toBe(true);
  });

  it("an ingress halt (terminal iterator error) → recovering with ingressUnavailable + rejects", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.live({ event: "message_received", seq: -1 }); // invalid seq → protocol violation → halt path
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const last = w.statuses.at(-1)!;
    expect(last.lifecycle === "recovering" || last.lastError !== undefined).toBe(true);
    expect(w.dm.lease()!.released).toBe(1);
  });

  it("daemon unreachable at acquire → recovering + rejects", async () => {
    const w = world({ acquireError: new DaemonUnreachableError("no socket", "/log") });
    await expect(startAccount(w.ctx, w.deps)).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "recovering" });
    expect(String(w.statuses.at(-1)!.lastError)).toContain("/log");
  });
});

describe("startAccount: blocked outcomes (return, no restart)", () => {
  it("a revoked token → blocked, lease released, resolves", async () => {
    const w = world({ connectError: new InvalidTokenError() });
    await startAccount(w.ctx, w.deps);
    const last = w.statuses.at(-1)!;
    expect(last.lifecycle).toBe("blocked");
    expect(String(last.lastError)).toMatch(/token/i);
    expect(w.dm.lease()!.released).toBe(1);
  });

  it("Windows → blocked before any daemon acquire", async () => {
    const w = world({ platform: "win32" });
    await startAccount(w.ctx, w.deps);
    expect(w.dm.calls).toHaveLength(0);
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "blocked" });
    expect(String(w.statuses.at(-1)!.lastError)).toContain("Windows");
  });

  it("unsupported platform reported by the daemon layer → blocked", async () => {
    const w = world({ acquireError: new DaemonUnsupportedError("no build") });
    await startAccount(w.ctx, w.deps);
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "blocked" });
  });

  it("not configured / disabled / identity collision never touch the daemon", async () => {
    for (const over of [
      { configured: false, token: undefined },
      { enabled: false },
      { configError: "two accounts share one data dir" },
    ] as Partial<ResolvedAdemuAccount>[]) {
      const w = world();
      (w.ctx as { account: ResolvedAdemuAccount }).account = account(over);
      await startAccount(w.ctx, w.deps);
      expect(w.dm.calls).toHaveLength(0);
      expect(w.statuses.at(-1)!.running === false || w.statuses.at(-1)!.lifecycle === "blocked").toBe(true);
    }
  });
});
