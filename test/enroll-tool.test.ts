import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it } from "vitest";
import type { EnrollmentLeaseDeps } from "../src/ceremony.js";
import { DaemonUnreachableError, type DaemonManager, type Lease } from "../src/monitor/daemon.js";
import { createEnrollTool, EnrollmentRegistry, registerEnrollTool, TOOL_NAME, type EnrollToolDeps } from "../src/tools/enroll.js";
import { FakeAdcClient, OWNER } from "./fakes/adc.js";
import { FakeControl, NEW_AGENT, NEW_DEVICE, QR, WORDS } from "./fakes/control.js";

const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));

function world(cfg: OpenClawConfig = {} as OpenClawConfig, acquireError?: unknown) {
  const control = new FakeControl();
  let released = 0;
  const daemonLease: Lease = {
    mode: "owned",
    role: "setup",
    identity: { dataDir: "/d" } as never,
    holderId: "h",
    info: { controlSocketPath: "/d/adc.sock", sessionSocketPath: "/d/adc-session.sock" },
    lost: new Promise<never>(() => {}),
    release: async () => void released++,
  };
  const acquires: unknown[] = [];
  const promotions: string[] = [];
  const daemons = {
    acquire: async (p: unknown) => {
      acquires.push(p);
      if (acquireError) throw acquireError;
      return daemonLease;
    },
    promotePendingPublication: (dataDir: string) => {
      promotions.push(dataDir);
      return true;
    },
  } as unknown as DaemonManager;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const lease: EnrollmentLeaseDeps = {
    daemons,
    connectControl: async () => control,
    now: () => 0,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  };
  const client = new FakeAdcClient({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER });
  const writes: OpenClawConfig[] = [];
  let current = cfg;
  const deps: EnrollToolDeps = {
    lease,
    connectSession: async () => client as never,
    qr: { terminal: async () => "", pngDataUrl: async () => "data:image/png;base64,QUJD" },
    writeConfig: async (mutate) => {
      current = mutate(current);
      writes.push(current);
    },
  };
  const registry = new EnrollmentRegistry();
  const ctx = (over: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext => ({
    senderIsOwner: true,
    sessionKey: "agent:main:webchat:owner",
    requesterSenderId: "owner-1",
    agentId: "main",
    runtimeConfig: current,
    ...over,
  });
  const tool = (over: Partial<OpenClawPluginToolContext> = {}) => createEnrollTool(ctx(over), deps, registry)!;
  const signal = new AbortController().signal;
  const call = async (args: Record<string, unknown>, over: Partial<OpenClawPluginToolContext> = {}, sig: AbortSignal | undefined = signal) =>
    tool(over).execute("call-1", args, sig);
  return { control, deps, registry, tool, call, writes, acquires, promotions, released: () => released, timers, current: () => current };
}

afterEach(() => {});

describe("ademu_enroll: gating", () => {
  it("is offered only to owners", () => {
    const w = world();
    expect(createEnrollTool({ senderIsOwner: false } as OpenClawPluginToolContext, w.deps, w.registry)).toBeNull();
    expect(createEnrollTool({} as OpenClawPluginToolContext, w.deps, w.registry)).toBeNull();
    const t = w.tool();
    expect(t.name).toBe(TOOL_NAME);
    expect(t.description).not.toMatch(/\bpair/i);
  });

  it("refuses to start without a conversation session", async () => {
    const w = world();
    const r = await w.call({ action: "start" }, { sessionKey: "" });
    expect(r.details.ok).toBe(false);
    expect(r.content[0]!.text).toContain("conversation session");
    expect(w.acquires).toHaveLength(0);
  });

  it("an absent or aborted signal is an expired authority: no device is created", async () => {
    const w = world();
    await expect(w.tool().execute("c", { action: "start" }, undefined)).rejects.toThrow(/authority/);
    const ac = new AbortController();
    ac.abort();
    await expect(w.call({ action: "start" }, {}, ac.signal)).rejects.toThrow(/authority/);
    expect(w.control.calls.some((c) => c.op === "create_device")).toBe(false);
  });

  it("refuses an accountId that already exists", async () => {
    const w = world({ channels: { ademu: { accounts: { iris: { deviceId: "d", token: "t" } } } } } as unknown as OpenClawConfig);
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(r.details).toMatchObject({ ok: false, accountId: "iris" });
    expect(w.acquires).toHaveLength(0);
  });
});

describe("ademu_enroll: the four-step flow", () => {
  it("start → wait → confirm writes the account, grants the owner, disposes the lease exactly once", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    expect(start.details).toMatchObject({ ok: true, state: "scanning", deviceId: NEW_DEVICE, accountId: "iris" });
    const leaseToken = start.details.leaseToken as string;
    expect(typeof leaseToken).toBe("string");
    expect(start.content[0]!.text).toContain("![ademu-enroll](data:image/png;base64,QUJD)");
    expect(start.content[0]!.text).toContain(QR);
    expect((w.acquires[0] as { role: string }).role).toBe("setup");
    expect(w.registry.size).toBe(1);

    // wait before the phone scanned → still waiting
    const early = await w.call({ action: "wait", leaseToken, timeoutMs: 10 });
    expect(early.content[0]!.text).toContain("Still waiting");

    w.control.emit({ state: "paired", words: WORDS });
    const waited = await w.call({ action: "wait", leaseToken });
    expect(waited.details.state).toBe("words");
    expect(waited.content[0]!.text).toContain(WORDS.join("   "));

    // confirm: the model cannot supply words; the daemon's are used
    const confirmP = w.call({ action: "confirm", leaseToken, words: ["x", "y", "z", "w"] });
    await tick(5);
    expect(w.control.calls.find((c) => c.op === "confirm_words")?.params).toEqual({ device_id: NEW_DEVICE, words: WORDS });
    w.control.finish("enrolled");
    const done = await confirmP;
    expect(done.details).toMatchObject({ ok: true, state: "done", accountId: "iris" });
    expect(done.content[0]!.text).toContain("Enrolled");

    expect(w.writes).toHaveLength(1);
    const cfg = w.current() as unknown as { channels: { ademu: { enabled: boolean; accounts: Record<string, Record<string, unknown>> } }; commands: { ownerAllowFrom: string[] } };
    expect(cfg.channels.ademu.enabled).toBe(true);
    expect(cfg.channels.ademu.accounts.iris).toMatchObject({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, token: "adc1_secret_1", agentName: "Iris" });
    expect(cfg.commands.ownerAllowFrom).toEqual([`ademu:${OWNER}`]);
    expect(w.control.calls.find((c) => c.op === "token_mint")?.params).toEqual({ device_id: NEW_DEVICE, label: "openclaw-iris" });
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect(w.control.closed).toBe(1);
  });

  it("actions on a lease from another conversation or with the wrong token are refused; status/cancel work for the owner", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    const other = await w.call({ action: "status", leaseToken, deviceId: NEW_DEVICE }, { sessionKey: "agent:main:webchat:someone-else" });
    expect(other.details.ok).toBe(false);
    const badToken = await w.call({ action: "status", leaseToken: "nope" });
    expect(badToken.details.ok).toBe(false);
    const noToken = await w.call({ action: "status" });
    expect(noToken.details.ok).toBe(false);
    const status = await w.call({ action: "status", leaseToken });
    expect(status.details).toMatchObject({ ok: true, state: "scanning" });
    const cancel = await w.call({ action: "cancel", leaseToken });
    expect(cancel.details.cancelled).toBe(true);
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
    expect(w.registry.size).toBe(0);
    expect(await w.call({ action: "status", leaseToken })).toMatchObject({ details: { ok: false } });
  });

  it("label_exists asks for consent; replace_token rotates", async () => {
    const w = world();
    w.control.tokenMintImpl = async (p) => {
      if (!p.replace) {
        throw new (await import("@ademu/adc-control")).ControlError("label_exists", "x");
      }
      return { token_id: "tid", label: p.label, token: "adc1_rotated", created_at_ms: 1 };
    };
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5);
    w.control.finish("enrolled");
    const blocked = await confirmP;
    expect(blocked.details.state).toBe("label_exists");
    expect(w.writes).toHaveLength(0);
    const rotated = await w.call({ action: "replace_token", leaseToken });
    expect(rotated.details.state).toBe("done");
    expect((w.current() as unknown as { channels: { ademu: { accounts: { iris: { token: string } } } } }).channels.ademu.accounts.iris.token).toBe("adc1_rotated");
    const mints = w.control.calls.filter((c) => c.op === "token_mint").map((c) => c.params);
    expect(mints).toEqual([
      { device_id: NEW_DEVICE, label: "openclaw-iris" },
      { device_id: NEW_DEVICE, label: "openclaw-iris", replace: true },
    ]);
  });

  it("a words mismatch disposes the lease and reports without writing", async () => {
    const w = world();
    w.control.confirmWordsImpl = async () => {
      throw new (await import("@ademu/adc-control")).ControlError("words_mismatch", "x");
    };
    const start = await w.call({ action: "start" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const r = await w.call({ action: "confirm", leaseToken });
    expect(r.details.state).toBe("words_mismatch");
    expect(w.writes).toHaveLength(0);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });

  it("the TTL timer disposes the lease (3 minutes) and a second start supersedes the first", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    expect(w.timers[0]?.ms).toBe(180_000);
    w.timers[0]!.fn();
    await tick();
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);

    await w.call({ action: "start", agentName: "Iris" });
    await w.call({ action: "start", agentName: "Bob" });
    expect(w.registry.size).toBe(1);
    expect(w.released()).toBe(2);
  });
});

describe("ademu_enroll: registration", () => {
  it("registers the tool by name and a service that disposes leases on stop", async () => {
    const w = world();
    const registered: Array<{ name?: string }> = [];
    const services: Array<{ id: string; stop?: (ctx: unknown) => unknown }> = [];
    const api = {
      registerTool: (_factory: unknown, opts?: { name?: string }) => void registered.push(opts ?? {}),
      registerService: (svc: { id: string; stop?: (ctx: unknown) => unknown }) => void services.push(svc),
    } as unknown as OpenClawPluginApi;
    const registry = registerEnrollTool(api, w.deps);
    expect(registered).toEqual([{ name: TOOL_NAME }]);
    expect(services[0]?.id).toBe("ademu-enroll-leases");
    const t = createEnrollTool({ senderIsOwner: true, sessionKey: "s" } as OpenClawPluginToolContext, w.deps, registry)!;
    await t.execute("c", { action: "start" }, new AbortController().signal);
    expect(registry.size).toBe(1);
    await services[0]!.stop!({});
    expect(registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });
});

const NO_AXES = { requesterSenderId: undefined, agentId: undefined } as unknown as Partial<OpenClawPluginToolContext>;

describe("ademu_enroll: Codex branch-review folds", () => {
  it("#12 the agentId axis is enforced: same session, sender and token from another agent is refused", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    const other = await w.call({ action: "status", leaseToken }, { agentId: "other-agent" });
    expect(other.details.ok).toBe(false);
    const same = await w.call({ action: "status", leaseToken });
    expect(same.details.ok).toBe(true);
  });

  it("#13 replace_token before a label_exists answer is refused and mints nothing", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    const r = await w.call({ action: "replace_token", leaseToken });
    expect(r.details.ok).toBe(false);
    expect(w.control.calls.some((c) => c.op === "token_mint")).toBe(false);
    expect(w.writes).toHaveLength(0);
  });

  it("#14 a failure after the lease exists (QR render) disposes the lease exactly once and leaves no registry entry", async () => {
    const w = world();
    w.deps.qr = {
      terminal: async () => "",
      pngDataUrl: async () => {
        throw new Error("qr renderer unavailable");
      },
    };
    await expect(w.call({ action: "start", agentName: "Iris" })).rejects.toThrow(/qr renderer/);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect(w.control.closed).toBe(1);
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
  });

  it("#14 a non-retryable failure during confirm (mint error) disposes the lease; a retryable one (device attached) keeps it", async () => {
    const w = world();
    w.control.tokenMintImpl = async () => {
      throw new Error("mint exploded");
    };
    const start = await w.call({ action: "start" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5);
    w.control.finish("enrolled");
    await expect(confirmP).rejects.toThrow(/mint exploded/);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });

  it("#15 a known acquisition failure returns fixed remedy text (ok:false), never throws, never installs", async () => {
    const w = world({} as OpenClawConfig, new DaemonUnreachableError("no daemon", "/var/log/adc.log"));
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(r.details).toMatchObject({ ok: false, state: "unavailable" });
    expect(r.content[0]!.text).toContain("/var/log/adc.log");
    expect(w.registry.size).toBe(0);
  });

  it("R2#7 a background revoked/retired pairing disposes the lease at once (not at TTL)", async () => {
    for (const state of ["revoked", "retired"]) {
      const w = world();
      await w.call({ action: "start", agentName: "Iris" });
      w.control.finish(state);
      await tick(5);
      expect(w.registry.size).toBe(0);
      expect(w.released()).toBe(1);
      expect(w.control.closed).toBe(1);
    }
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.failPoll(new Error("poll transport died"));
    await tick(5);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });

  it("R2#8 axes compare exactly (absent → present is a mismatch) and only the same creator tuple may supersede", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" }, NO_AXES);
    const leaseToken = start.details.leaseToken as string;
    const withSender = await w.call({ action: "status", leaseToken }); // default ctx has a sender + agent
    expect(withSender.details.ok).toBe(false);
    const bare = await w.call({ action: "status", leaseToken }, NO_AXES);
    expect(bare.details.ok).toBe(true);
    // another agent on the same session key cannot supersede (dispose) it
    const other = await w.call({ action: "start", agentName: "Bob" });
    expect(other.details).toMatchObject({ ok: false, state: "busy" });
    expect(w.registry.size).toBe(1);
    expect(w.released()).toBe(0);
    // the same creator may
    const again = await w.call({ action: "start", agentName: "Bob" }, NO_AXES);
    expect(again.details.ok).toBe(true);
    expect(w.released()).toBe(1);
  });

  it("R3#1 a cancel that lands while confirm is probing wins: nothing is written, confirm reports cancelled", async () => {
    const w = world();
    let releaseProbe!: () => void;
    const stall = new Promise<void>((r) => {
      releaseProbe = r;
    });
    const client = new FakeAdcClient({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER });
    client.stallGetSelf = stall;
    w.deps.connectSession = async () => client as never;
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5);
    w.control.finish("enrolled");
    await tick(5); // confirm is now parked in the identity probe
    const cancel = await w.call({ action: "cancel", leaseToken });
    expect(cancel.details.cancelled).toBe(true);
    releaseProbe();
    const result = await confirmP;
    expect(result.details.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
    expect(w.released()).toBe(1);
  });

  it("R4#1 a cancel that lands after the words were confirmed but before the mint wins: no mint, no write", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5); // confirm_words sent; confirm is parked waiting for the terminal state
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(true);
    const cancel = await w.call({ action: "cancel", leaseToken });
    expect(cancel.details.cancelled).toBe(true);
    const result = await confirmP;
    expect(result.details.ok).toBe(false);
    expect(w.control.calls.some((c) => c.op === "token_mint")).toBe(false);
    expect(w.writes).toHaveLength(0);
    expect(w.released()).toBe(1);
  });

  it("R4#1 a cancel that lands while the host mutation is pending is refused (committing) and the write completes exactly once", async () => {
    const w = world();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const origWrite = w.deps.writeConfig;
    w.deps.writeConfig = async (mutate) => {
      await gate; // the host takes its time before handing us the draft
      await origWrite(mutate);
    };
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5);
    w.control.finish("enrolled");
    await tick(10); // confirm is inside writeConfig (committing)
    const cancel = await w.call({ action: "cancel", leaseToken });
    expect(cancel.details).toMatchObject({ ok: false, state: "committing" });
    releaseWrite();
    const result = await confirmP;
    expect(result.details.state).toBe("done");
    expect(w.writes).toHaveLength(1);
  });

  it("R3#3 two simultaneous starts in one conversation admit exactly one; an account created meanwhile is never overwritten", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.call({ action: "start", agentName: "Iris" }), w.call({ action: "start", agentName: "Iris" })]);
    const oks = [a, b].filter((r) => r.details.ok);
    expect(oks).toHaveLength(1);
    expect(w.registry.size).toBe(1);
    const leaseToken = oks[0]!.details.leaseToken as string;
    // someone writes channels.ademu.accounts.iris while the ceremony runs
    w.deps.writeConfig = async (mutate) => {
      const draft = { channels: { ademu: { accounts: { iris: { deviceId: "other", token: "t" } } } } } as unknown as OpenClawConfig;
      mutate(draft);
    };
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5);
    w.control.finish("enrolled");
    const r = await confirmP;
    expect(r.details).toMatchObject({ ok: false, state: "account_exists" });
    expect(w.released()).toBe(1);
  });

  it("#10 after the config write the setup-spawned daemon is promoted (pending-publication → bound)", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    const leaseToken = start.details.leaseToken as string;
    w.control.emit({ words: WORDS });
    await tick();
    const confirmP = w.call({ action: "confirm", leaseToken });
    await tick(5);
    w.control.finish("enrolled");
    await confirmP;
    expect(w.promotions).toEqual(["/d"]);
  });
});
