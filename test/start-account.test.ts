// startAccount lifecycle (plan T10): lease → session → ingress → ready; outcomes; cleanup ordering
// under the deadline; blocked vs restart contract with the gateway supervisor.
import { InvalidTokenError, SessionRejectedError } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedAdemuAccount } from "../src/config.js";
import { DaemonLostError, DaemonUnreachableError, DaemonUnsupportedError, type DaemonManager, type Lease } from "../src/monitor/daemon.js";
import { DRAIN_CAP_MS, RELEASE_TAIL_MS, STOP_DEADLINE_MS, startAccount, type StartAccountDeps } from "../src/monitor/index.js";
import type { RuntimeChannelSurface } from "../src/monitor/ingress.js";
import { getLiveAccount, resetLiveAccountsForTests } from "../src/outbound.js";
import { AdemuStore } from "../src/store.js";
import { AGENT, DEVICE, FakeAdcClient, fakeConnect, GUEST, member, OWNER, ROOM_DM } from "./fakes/adc.js";

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

function fakeDaemons(opts: { acquire?: () => Promise<void>; mode?: "owned" | "foreign"; releaseHangs?: boolean } = {}) {
  const calls: unknown[] = [];
  const sweeps: unknown[] = [];
  let lease: FakeLease | undefined;
  const daemons = {
    sweepPendingPublications: async (isReferenced: unknown) => {
      sweeps.push(isReferenced);
      return [];
    },
    acquire: async (params: unknown) => {
      calls.push(params);
      await opts.acquire?.();
      let lose!: (err: unknown) => void;
      const lost = new Promise<never>((_, reject) => {
        lose = reject;
      });
      lease = {
        mode: opts.mode ?? "owned",
        role: "runtime",
        identity: (params as { identity: unknown }).identity as never,
        holderId: "h1",
        info: { controlSocketPath: "/d/adc.sock", sessionSocketPath: "/d/adc-session.sock" },
        lost,
        released: 0,
        lose,
        release: async () => {
          lease!.released++;
          if (opts.releaseHangs) await new Promise(() => {});
        },
      };
      return lease;
    },
  } as unknown as DaemonManager;
  return { daemons, calls, sweeps, lease: () => lease };
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

function world(opts: { platform?: string; connectError?: unknown; acquireError?: unknown; mode?: "owned" | "foreign"; releaseHangs?: boolean } = {}) {
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
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.releaseHangs ? { releaseHangs: true } : {}),
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

  it("an ingress halt (dispatch rejects before adoption) → recovering + ingressUnavailable + rejects", async () => {
    const w = world();
    w.deps.runtime.inbound.dispatch = () => Promise.reject(new Error("core refused"));
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.room(ROOM_DM, [member(OWNER, "human", "Marios"), member(AGENT, "agent", "Iris")]);
    w.client.message({ body: "hello" });
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("IngressHaltedError");
    const last = w.statuses.at(-1)!;
    expect(last).toMatchObject({ lifecycle: "recovering", ingressUnavailable: true });
    expect(w.client.acks).toEqual([]); // nothing acked: the daemon replays after the restart
    expect(w.dm.lease()!.released).toBe(1);
  });

  it("a protocol violation from the daemon (invalid seq) → blocked, resolves (no restart loop)", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.live({ event: "message_received", seq: -1 });
    await run;
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "blocked" });
    expect(w.dm.lease()!.released).toBe(1);
  });

  it("a terminal client error surfacing from the event iterator (token revoked mid-run) → blocked, resolves", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.failStream(new InvalidTokenError());
    await run;
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "blocked" });
    expect(String(w.statuses.at(-1)!.lastError)).toMatch(/token/i);
  });

  it("owned daemon: the 5th consecutive retry → DaemonLostError (restart); foreign: never", async () => {
    const owned = world();
    const run = startAccount(owned.ctx, owned.deps);
    await settle();
    for (let i = 1; i <= 5; i++) owned.client.emit("retry", { attempt: i, delayMs: 10 } as never);
    await expect(run).rejects.toBeInstanceOf(DaemonLostError);

    const foreign = world({ mode: "foreign" });
    const run2 = startAccount(foreign.ctx, foreign.deps);
    await settle();
    for (let i = 1; i <= 8; i++) foreign.client.emit("retry", { attempt: i, delayMs: 10 } as never);
    await settle();
    expect(foreign.statuses.at(-1)).toMatchObject({ lifecycle: "recovering" });
    foreign.ac.abort();
    await run2; // still running until abort; never rejected
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

describe("startAccount: Codex branch-review folds", () => {
  it("#8 a hung daemon release is abandoned at the deadline (logged), the account still returns", async () => {
    const w = world({ releaseHangs: true });
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.ac.abort();
    await run;
    expect(w.dm.lease()!.released).toBe(1);
    expect(w.logs.some((l) => l.event === "cleanup_step_timed_out" && l.fields?.step === "daemon_release")).toBe(true);
  });

  it("#10 the pending-publication sweep runs once per daemon manager, before the first acquire", async () => {
    const w = world();
    const run1 = startAccount(w.ctx, w.deps);
    await settle();
    w.ac.abort();
    await run1;
    expect(w.dm.sweeps).toHaveLength(1);
    // A second account start on the SAME manager (fresh client/session): no second sweep.
    const w2 = world();
    w2.deps.daemons = w.deps.daemons;
    const run2 = startAccount(w2.ctx, w2.deps);
    await settle();
    w2.ac.abort();
    await run2;
    expect(w.dm.sweeps).toHaveLength(1);
    expect(w.dm.calls).toHaveLength(2);
  });

  it("#21 a security_notice sets the fixed status copy and posts the fixed room note; the only logged fact is `room`", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.unknownEvent("security_notice", { group_id: ROOM_DM, detail: "SECRET-DETAIL", seq: 77 });
    await settle();
    expect(w.statuses.at(-1)).toMatchObject({ lastError: expect.stringContaining("security notice") });
    expect(w.client.sent).toEqual([{ group_id: ROOM_DM, body: expect.stringContaining("security notice") }]);
    const notice = w.logs.filter((l) => l.event === "security_notice");
    expect(notice).toHaveLength(1);
    expect(Object.keys(notice[0]!.fields ?? {}).sort()).toEqual(["accountId", "room"]);
    expect(w.logs.some((l) => l.event === "event_unknown")).toBe(false);
    w.ac.abort();
    await run;
  });

  it("R2#4 a failed reconnect warm-up with a replayed frame parked on the barrier → the account restarts, nothing acked, lease released", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.emit("retry", { attempt: 1, delayMs: 1 } as never);
    w.client.message({ body: "replayed" }); // the loop body parks on the barrier
    await settle();
    w.client.refreshFails = true;
    w.client.emit("reconnected");
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "recovering" });
    expect(w.client.acks).toEqual([]);
    expect(w.dm.lease()!.released).toBe(1);
  });

  it("R3#2 abort during the initial warm-up (stalled list_conversations) returns promptly, closes the client, releases the lease", async () => {
    const w = world();
    let release!: () => void;
    w.client.stallListConversations = new Promise<void>((r) => {
      release = r;
    });
    const run = startAccount(w.ctx, w.deps);
    await settle();
    expect(w.client.closed).toBe(false);
    w.ac.abort();
    await run; // must not wait for the stalled request
    expect(w.client.closed).toBe(true);
    expect(w.dm.lease()!.released).toBe(1);
    release();
  });

  it("R3#5 an event-processing failure (members lookup throws) is the pre-adoption halt: recovering + ingressUnavailable, no ack", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.getMembersFails = true;
    w.client.message({ body: "hello", sender_user_id: GUEST }); // unknown sender → members refresh → throws
    const err = await run.catch((e: unknown) => e);
    expect((err as Error).name).toBe("IngressHaltedError");
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "recovering", ingressUnavailable: true });
    expect(w.client.acks).toEqual([]);
  });

  it("R2#5 an unknown future session rejection (base class) → blocked, not a restart loop", async () => {
    const w = world();
    const run = startAccount(w.ctx, w.deps);
    await settle();
    w.client.failStream(new SessionRejectedError("future_code"));
    await run;
    expect(w.statuses.at(-1)).toMatchObject({ lifecycle: "blocked" });
    expect(String(w.statuses.at(-1)!.lastError)).toContain("rejected this session");
  });
});
