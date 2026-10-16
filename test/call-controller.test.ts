// The call controller (openclaw-ademu#30 §4.2) over a scripted daemon: per-seat call handling, the
// answer policy (§5), the media start, a reattach that resumes from get_call in the protocol's order,
// an audio drop that reconnects or ends the call, and barge-in restarting the agent engine.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { PassThrough, Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { CallController, type CallsStatus } from "../src/calls/controller.js";
import type { CallEngineParams } from "../src/calls/engine.js";
import { AudioFrameDecoder, encodeMark, encodePcmFrame } from "../src/calls/frames.js";
import { decideCall } from "../src/calls/policy.js";
import { CALL_CAPABILITIES, type CallChanged, type CallEntry } from "../src/calls/protocol.js";
import type { AudioSocket } from "../src/calls/transport.js";
import { resolveCallsConfig, type CallsConfig } from "../src/config.js";
import { openSession } from "../src/monitor/session.js";
import { createAdemuIngressResolver } from "../src/security.js";
import { AGENT, DEVICE, FakeAdcClient, fakeConnect, GUEST, member, OWNER, ROOM_DM, ROOM_GROUP } from "./fakes/adc.js";

const ROOM_STRANGER = "0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a2b";
const CALL = "7b1e6a90-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const CALL2 = "1b1e6a90-3c4d-4e5f-8a9b-0c1d2e3f4a5c";
const ticket = (n: number) => `adca1_${String(n).padStart(43, "A")}`;

const baseCfg = {
  channels: { ademu: { accounts: { iris: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER, token: "t" } } } },
} as unknown as OpenClawConfig;

class AudioPair {
  readonly written: Buffer[] = [];
  closed = false;
  readonly toMind = new PassThrough();
  readonly socket: Duplex;
  constructor() {
    const self = this;
    this.socket = new Duplex({
      read() {},
      write(chunk: Buffer, _e, cb) {
        self.written.push(Buffer.from(chunk));
        cb();
      },
      destroy(err, cb) {
        self.closed = true;
        cb(err);
      },
    });
    this.toMind.on("data", (c: Buffer) => this.socket.push(c));
    this.toMind.on("end", () => this.socket.push(null));
  }
  frames() {
    return new AudioFrameDecoder().push(Buffer.concat(this.written));
  }
}

async function world(opts: { engineGate?: Promise<void>; calls?: CallsConfig; capabilities?: string[]; helper?: boolean; cfg?: OpenClawConfig; engine?: "agent" | "realtime" } = {}) {
  const client = new FakeAdcClient();
  client.room(ROOM_DM, [member(OWNER, "human", "Marios"), member(AGENT, "agent", "Iris")]);
  client.room(ROOM_GROUP, [member(OWNER, "human", "Marios"), member(GUEST, "human", "Jhessy"), member(AGENT, "agent", "Iris")]);
  client.room(ROOM_STRANGER, [member(GUEST, "human", "Jhessy"), member(AGENT, "agent", "Iris")]);
  client.capabilities = new Set(opts.capabilities ?? CALL_CAPABILITIES);
  const { connect } = fakeConnect(client);
  const session = await openSession({ token: "t", sessionSocketPath: "/s", account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER }, deps: { connect, now: () => 0, log: () => {} } });

  // The scripted daemon behind `request`.
  const requests: Array<{ op: string; params?: Record<string, unknown> }> = [];
  const daemon = { getCallFails: 0, handlingFails: 0, helper: opts.helper ?? true, calls: [] as CallEntry[], ticketSeq: 0, answerFails: undefined as string | undefined, refuseAudio: false };
  const fail = (code: string) => Object.assign(new Error(code), { name: "RequestError", code });
  (client as unknown as { request: (op: string, params?: Record<string, unknown>) => Promise<unknown> }).request = async (op, params) => {
    requests.push({ op, ...(params ? { params } : {}) });
    switch (op) {
      case "set_call_handling":
        if (!daemon.helper) throw fail("call_helper_unavailable");
        if (daemon.handlingFails > 0) {
          daemon.handlingFails--;
          throw Object.assign(new Error("timeout"), { name: "RequestTimeoutError" });
        }
        return { rate: 24000 };
      case "get_call":
        if (daemon.getCallFails > 0) {
          daemon.getCallFails--;
          throw Object.assign(new Error("timeout"), { name: "RequestTimeoutError" });
        }
        return {
          calls: daemon.calls.map((c) => (c.state === "connecting" || c.state === "active" ? { ...c, audio_ticket: ticket(++daemon.ticketSeq) } : c)),
        };
      case "answer_call": {
        if (daemon.answerFails) throw fail(daemon.answerFails);
        const c = daemon.calls.find((x) => x.call_id === params?.call_id);
        if (!c || c.state !== "ringing") throw fail("unknown_call");
        c.state = "connecting";
        return { audio_ticket: ticket(++daemon.ticketSeq) };
      }
      case "decline_call":
      case "end_call": {
        const c = daemon.calls.find((x) => x.call_id === params?.call_id);
        if (!c) throw fail("unknown_call");
        daemon.calls = daemon.calls.filter((x) => x !== c);
        return { state: "ended" };
      }
    }
    throw new Error(`unexpected op ${op}`);
  };

  const audio: Array<{ ticket: string; pair: AudioPair }> = [];
  const engines: Array<{ params: CallEngineParams; spoken: string[]; stopped: boolean }> = [];
  const statuses: CallsStatus[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
  const calls = resolveCallsConfig({ enabled: true, ...(opts.engine ? { engine: opts.engine } : {}), ...opts.calls });
  const cfg = opts.cfg ?? baseCfg;
  const controller = new CallController({
    accountId: "iris",
    cfg,
    calls,
    client: session.client,
    members: session.members,
    barrier: () => session.barrier(),
    sessionSocketPath: "/s",
    resolver: createAdemuIngressResolver({ accountId: "iris", cfg }),
    account: { agentUserId: AGENT, ownerUserId: OWNER },
    resolveAgentRoute: (input) => ({ agentId: "main", sessionKey: `agent:main:ademu:${(input.peer as { id: string }).id}` }),
    startEngine: async (params) => {
      const e = { params, spoken: [] as string[], stopped: false };
      engines.push(e);
      params.transport.startInput(() => {});
      if (opts.engineGate) await opts.engineGate;
      return {
        speak: (t) => e.spoken.push(t),
        stop: async () => {
          e.stopped = true;
          await params.transport.stop();
        },
      };
    },
    onStatus: (s) => statuses.push(s),
    log: (event, fields) => logs.push({ event, fields }),
    openAudio: async (_path, t) => {
      if (daemon.refuseAudio) throw new Error("refused");
      const pair = new AudioPair();
      audio.push({ ticket: t, pair });
      return { socket: pair.socket, rate: 24000, leftover: Buffer.alloc(0) } satisfies AudioSocket;
    },
    reconnect: { attempts: 3, windowMs: 10_000, delayMs: 1 },
    sleep: async () => {},
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
  };
  const ring = (over: Partial<CallEntry> & { from?: string } = {}): CallChanged => {
    const c: CallEntry = {
      call_id: over.call_id ?? CALL,
      group_id: over.group_id ?? ROOM_DM,
      state: "ringing",
      direction: "incoming",
      media: "audio",
      participants: [{ user_id: over.from ?? OWNER, username: "marios", kind: "human" }],
      expires_at_ms: 45_000,
    };
    daemon.calls.push(c);
    return { ...c, seq: 1 };
  };
  const event = (callId: string, state: CallChanged["state"], outcome?: string): CallChanged => {
    const c = daemon.calls.find((x) => x.call_id === callId);
    if (c) c.state = state;
    if (state === "ended") daemon.calls = daemon.calls.filter((x) => x.call_id !== callId);
    return {
      call_id: callId,
      group_id: c?.group_id ?? ROOM_DM,
      state,
      direction: "incoming",
      media: "audio",
      participants: c?.participants ?? [],
      seq: 2,
      ...(outcome ? { outcome } : {}),
    };
  };
  const ops = () => requests.map((r) => r.op);
  return { client, session, controller, daemon, requests, ops, audio, engines, statuses, logs, settle, ring, event, cfg };
}

describe("answer policy (§5): the caller is judged like a sender of text", () => {
  const run = async (from: string, groupId: string, mode: "allowed" | "none" = "allowed", cfg = baseCfg) => {
    const w = await world({ cfg });
    return decideCall({
      call: { call_id: CALL, group_id: groupId, participants: [{ user_id: from, username: "", kind: "human" }] },
      mode,
      cfg,
      accountId: "iris",
      members: w.session.members,
      resolver: createAdemuIngressResolver({ accountId: "iris", cfg }),
      account: { agentUserId: AGENT, ownerUserId: OWNER },
      resolveAgentRoute: (input) => ({ agentId: "main", sessionKey: `agent:main:ademu:${(input.peer as { id: string }).id}` }),
    });
  };

  it("the owner 1-1 → answer", async () => {
    expect(await run(OWNER, ROOM_DM)).toEqual({ answer: true, kind: "direct" });
  });
  it("a stranger's 1-1 → decline (the DM allowlist)", async () => {
    expect(await run(GUEST, ROOM_STRANGER)).toMatchObject({ answer: false, reason: "access" });
  });
  it("a group: the owner is always heard; a guest only where the room needs no mention", async () => {
    expect(await run(OWNER, ROOM_GROUP)).toEqual({ answer: true, kind: "group" });
    expect(await run(GUEST, ROOM_GROUP)).toMatchObject({ answer: false, reason: "requires_mention" });
    const open = {
      channels: { ademu: { ...(baseCfg as { channels: { ademu: object } }).channels.ademu, groups: { "*": { requireMention: false } } } },
    } as unknown as OpenClawConfig;
    expect(await run(GUEST, ROOM_GROUP, "allowed", open)).toEqual({ answer: true, kind: "group" });
  });
  it('answer "none" declines everyone; an inactive room declines', async () => {
    expect(await run(OWNER, ROOM_DM, "none")).toMatchObject({ answer: false, reason: "answer_none" });
    const w = await world();
    w.session.members.markInactive(ROOM_DM);
    const d = await decideCall({
      call: { call_id: CALL, group_id: ROOM_DM, participants: [{ user_id: OWNER, username: "", kind: "human" }] },
      mode: "allowed",
      cfg: baseCfg,
      accountId: "iris",
      members: w.session.members,
      resolver: createAdemuIngressResolver({ accountId: "iris", cfg: baseCfg }),
      account: { agentUserId: AGENT, ownerUserId: OWNER },
      resolveAgentRoute: (input) => ({ agentId: "main", sessionKey: `agent:main:ademu:${(input.peer as { id: string }).id}` }),
    });
    expect(d).toMatchObject({ answer: false, reason: "inactive" });
  });
});

describe("attach: call handling is per seat", () => {
  it("disabled: nothing is sent (callers get busy from the daemon)", async () => {
    const w = await world({ calls: { enabled: false } });
    w.controller.start();
    await w.settle();
    expect(w.ops()).toEqual([]);
    expect(w.controller.status()).toEqual({ enabled: false, availability: "disabled" });
  });

  it("a daemon without the call capabilities is left alone", async () => {
    const w = await world({ capabilities: ["call_changed"] });
    w.controller.start();
    await w.settle();
    expect(w.ops()).toEqual([]);
    expect(w.controller.status().availability).toBe("unsupported");
  });

  it("call_helper_unavailable: marked, no get_call, no retry until the next attach", async () => {
    const w = await world({ helper: false });
    w.controller.start();
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling"]);
    expect(w.requests[0]!.params).toEqual({ audio: { rate: 24000 } });
    expect(w.controller.status().availability).toBe("helper_unavailable");
    w.daemon.helper = true;
    w.client.emit("retry", { attempt: 1, delayMs: 1 });
    w.client.emit("reconnected");
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "set_call_handling", "get_call"]);
    expect(w.controller.status().availability).toBe("ready");
  });

  it("a ringing call found at attach is decided (its event died with the old seat)", async () => {
    const w = await world();
    w.ring();
    w.controller.start();
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "get_call", "answer_call"]);
    expect(w.engines).toHaveLength(1);
  });

  it("an active call found at attach (a restart within the grace) is taken over with its ticket", async () => {
    const w = await world();
    w.ring();
    w.daemon.calls[0]!.state = "active";
    w.controller.start();
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "get_call"]);
    expect(w.audio.map((a) => a.ticket)).toEqual([ticket(1)]);
    expect(w.engines[0]!.params).toMatchObject({ callId: CALL, agentId: "main", sessionKey: `agent:main:ademu:${ROOM_DM}` });
  });
});

describe("a call's lifecycle", () => {
  it("ring → answer → audio → engine; active speaks the intro once; ended stops everything", async () => {
    const w = await world({ calls: { introMessage: "Hi, Iris here." } });
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "get_call", "answer_call"]);
    expect(w.requests[2]!.params).toEqual({ call_id: CALL });
    expect(w.audio.map((a) => a.ticket)).toEqual([ticket(1)]);
    expect(w.engines[0]!.params).toMatchObject({ callId: CALL, sessionKey: `agent:main:ademu:${ROOM_DM}` });
    expect(w.controller.status().call).toMatchObject({ callId: CALL, callerUserId: OWNER });

    w.controller.handleEvent(w.event(CALL, "connecting"));
    w.controller.handleEvent(w.event(CALL, "active"));
    w.controller.handleEvent(w.event(CALL, "active"));
    await w.settle();
    expect(w.engines[0]!.spoken).toEqual(["Hi, Iris here."]);

    w.controller.handleEvent(w.event(CALL, "ended", "answered"));
    await w.settle();
    expect(w.engines[0]!.stopped).toBe(true);
    expect(w.audio[0]!.pair.closed).toBe(true);
    expect(w.controller.status().call).toBeUndefined();
    // The daemon ended it: the plugin never sends end_call for an ended call.
    expect(w.ops()).not.toContain("end_call");
  });

  it("a caller the policy refuses is declined at once", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring({ from: GUEST, group_id: ROOM_STRANGER }));
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "get_call", "decline_call"]);
    expect(w.engines).toHaveLength(0);
    expect(w.logs.find((l) => l.event === "call_declined")?.fields).toEqual({ reason: "access" });
  });

  it("a second ring while a call runs is declined (one call in v1)", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.ring({ call_id: CALL2 }));
    await w.settle();
    expect(w.requests.at(-1)).toEqual({ op: "decline_call", params: { call_id: CALL2 } });
    expect(w.controller.status().call?.callId).toBe(CALL);
  });

  it("an answer the daemon refuses as unknown_call (stopped ringing) clears the call quietly", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.daemon.answerFails = "unknown_call";
    w.controller.handleEvent(w.ring());
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "get_call", "answer_call"]);
    expect(w.controller.status().call).toBeUndefined();
  });

  it("the agent hangs up: end_call, and everything stops", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    await w.controller.hangUp();
    expect(w.requests.at(-1)).toEqual({ op: "end_call", params: { call_id: CALL } });
    expect(w.engines[0]!.stopped).toBe(true);
  });
});

describe("reattach and audio recovery (decision 8)", () => {
  it("after a reattach: set_call_handling, then get_call, then a new audio connection with the fresh ticket", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.event(CALL, "active"));
    await w.settle();
    const before = w.requests.length;
    w.client.emit("retry", { attempt: 1, delayMs: 1 });
    w.client.emit("reconnected");
    await w.settle();
    const after = w.requests.slice(before).map((r) => r.op);
    // set_call_handling strictly first; then the resume's get_call and the transport's fresh-ticket get_call.
    expect(after[0]).toBe("set_call_handling");
    expect(after.slice(1).every((op) => op === "get_call")).toBe(true);
    expect(w.audio).toHaveLength(2);
    expect(w.audio[0]!.pair.closed).toBe(true);
    expect(w.audio[1]!.ticket).not.toBe(w.audio[0]!.ticket);
    // The engine keeps running across the switch.
    expect(w.engines).toHaveLength(1);
    expect(w.engines[0]!.stopped).toBe(false);
  });

  it("a call that ended while the seat was away is torn down at the next attach", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.client.emit("retry", { attempt: 1, delayMs: 1 });
    w.daemon.calls = [];
    w.client.emit("reconnected");
    await w.settle();
    expect(w.engines[0]!.stopped).toBe(true);
    expect(w.controller.status().call).toBeUndefined();
  });

  it("the audio connection drops mid-call: a fresh ticket from get_call, the engine untouched", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.event(CALL, "active"));
    await w.settle();
    w.audio[0]!.pair.toMind.end();
    await w.settle();
    expect(w.audio).toHaveLength(2);
    expect(w.ops().at(-1)).toBe("get_call");
    expect(w.engines[0]!.stopped).toBe(false);
  });

  it("recovery that cannot reconnect ends the call", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.event(CALL, "active"));
    await w.settle();
    // Every fresh ticket is refused by the helper from now on.
    w.daemon.refuseAudio = true;
    w.audio[0]!.pair.toMind.end();
    await w.settle();
    expect(w.ops()).toContain("end_call");
    expect(w.engines[0]!.stopped).toBe(true);
  });
});

describe("barge-in (§4.5)", () => {
  const loud = () => {
    const b = Buffer.alloc(480);
    for (let i = 0; i < 240; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
    return b;
  };

  it("agent engine: speech over its output clears it and restarts the engine on the same connection", async () => {
    const w = await world({ calls: { bargeIn: { holdMs: 30 } } });
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    await w.engines[0]!.params.transport.writeOutput(Buffer.alloc(48_000));
    for (let i = 0; i < 4; i++) w.audio[0]!.pair.toMind.write(encodePcmFrame(loud()));
    await w.settle();
    expect(w.audio[0]!.pair.frames().some((f) => f.kind === "clear_output")).toBe(true);
    expect(w.engines).toHaveLength(2);
    expect(w.engines[0]!.stopped).toBe(true);
    expect(w.engines[1]!.stopped).toBe(false);
    // Same connection: the stopped engine's view did not close it.
    expect(w.audio).toHaveLength(1);
    expect(w.audio[0]!.pair.closed).toBe(false);
    // The helper echoes the cleared mark; the restarted engine speaks on.
    const mark = w.audio[0]!.pair.frames().find((f) => f.kind === "mark") as { id: Buffer };
    w.audio[0]!.pair.toMind.write(encodeMark(mark.id));
    await w.engines[1]!.params.transport.writeOutput(Buffer.alloc(480));
  });

  it("realtime engine: no restart (it handles barge-in through the transport's monitor)", async () => {
    const w = await world({ engine: "realtime", calls: { bargeIn: { holdMs: 30 } } });
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    await w.engines[0]!.params.transport.writeOutput(Buffer.alloc(48_000));
    for (let i = 0; i < 4; i++) w.audio[0]!.pair.toMind.write(encodePcmFrame(loud()));
    await w.settle();
    expect(w.engines).toHaveLength(1);
  });
});

describe("review folds", () => {
  it("an engine that stops by itself (a provider error) ends the call: nobody is left on the line", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    // What OpenClaw's engines do on their own failure: stop and dispose their transport.
    await w.engines[0]!.params.transport.stop();
    await w.settle();
    expect(w.requests.at(-1)).toEqual({ op: "end_call", params: { call_id: CALL } });
    expect(w.audio[0]!.pair.closed).toBe(true);
    expect(w.controller.status().call).toBeUndefined();
  });

  it("an engine the controller stops (barge-in restart, call end) never reads as a failure", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.event(CALL, "ended", "answered"));
    await w.settle();
    expect(w.ops()).not.toContain("end_call");
  });

  it("stop() while a ring is being decided: nothing is answered, no engine starts", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    let release!: () => void;
    const members = w.session.members;
    const realGet = members.getWithSender.bind(members);
    members.getWithSender = async (g, u) => {
      await new Promise<void>((r) => (release = r));
      return realGet(g, u);
    };
    w.controller.handleEvent(w.ring());
    await w.settle();
    const stopping = w.controller.stop();
    release();
    await stopping;
    await w.settle();
    expect(w.ops()).not.toContain("answer_call");
    expect(w.engines).toHaveLength(0);
  });

  it("stop() while an engine is starting: the engine is stopped and the connection closed", async () => {
    let release!: () => void;
    const w = await world({ engineGate: new Promise<void>((r) => (release = r)) });
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    expect(w.engines).toHaveLength(1); // started, not yet returned
    const stopping = w.controller.stop();
    release();
    await stopping;
    await w.settle();
    expect(w.engines[0]!.stopped).toBe(true);
    expect(w.audio[0]!.pair.closed).toBe(true);
  });

  it("a set_call_handling that times out is retried while the seat lasts", async () => {
    const w = await world();
    w.daemon.handlingFails = 1;
    w.controller.start();
    await w.settle();
    expect(w.controller.status().availability).toBe("failed");
    await new Promise((r) => setTimeout(r, 2_200));
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "set_call_handling", "get_call"]);
    expect(w.controller.status().availability).toBe("ready");
    await w.controller.stop();
  });

  it("a second ringing call listed at a reattach is declined, never replacing the current one", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.event(CALL, "active"));
    await w.settle();
    w.ring({ call_id: CALL2 });
    w.client.emit("retry", { attempt: 1, delayMs: 1 });
    w.client.emit("reconnected");
    await w.settle();
    expect(w.requests.some((r) => r.op === "decline_call" && r.params?.call_id === CALL2)).toBe(true);
    expect(w.controller.status().call?.callId).toBe(CALL);
    expect(w.engines[0]!.stopped).toBe(false);
  });
});

describe("the agent hangs up (ademu_end_call)", () => {
  it("the call ends only after the asking consult settled and its reply has played", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    w.controller.handleEvent(w.event(CALL, "active"));
    await w.settle();
    expect(w.controller.endAfterReply(CALL2)).toBe(false);
    expect(w.controller.endAfterReply(CALL.toUpperCase())).toBe(true);
    const engine = w.engines[0]!.params;
    await new Promise((r) => setTimeout(r, 1_000));
    expect(w.ops()).not.toContain("end_call"); // the consult that asked has not answered yet
    engine.onConsultSettled?.();
    await engine.transport.writeOutput(Buffer.alloc(4_800)); // "Goodbye!"
    await new Promise((r) => setTimeout(r, 1_000));
    expect(w.ops()).not.toContain("end_call"); // still playing: its mark has not come back
    const mark = w.audio[0]!.pair.frames().find((f) => f.kind === "mark") as { id: Buffer };
    w.audio[0]!.pair.toMind.write(encodeMark(mark.id));
    await new Promise((r) => setTimeout(r, 1_200));
    expect(w.requests.at(-1)).toEqual({ op: "end_call", params: { call_id: CALL } });
    expect(w.engines[0]!.stopped).toBe(true);
  });

  it("only the owner's 1-1 call gets the agent's own tools; a room call the owner places does not", async () => {
    const open = {
      channels: { ademu: { ...(baseCfg as { channels: { ademu: object } }).channels.ademu, groups: { "*": { requireMention: false } } } },
    } as unknown as OpenClawConfig;
    const w = await world({ cfg: open });
    w.controller.start();
    await w.settle();
    w.controller.handleEvent(w.ring());
    await w.settle();
    expect(w.engines[0]!.params.toolPolicy).toBe("owner");
    w.controller.handleEvent(w.event(CALL, "ended", "answered"));
    await w.settle();
    w.controller.handleEvent(w.ring({ call_id: CALL2, from: GUEST, group_id: ROOM_GROUP }));
    await w.settle();
    expect(w.engines[1]!.params.toolPolicy).toBe("safe-read-only");
    w.controller.handleEvent(w.event(CALL2, "ended", "answered"));
    await w.settle();
    // The owner rings the room: anyone in it speaks into the same stream.
    w.controller.handleEvent(w.ring({ call_id: "2b1e6a90-3c4d-4e5f-8a9b-0c1d2e3f4a5d", from: OWNER, group_id: ROOM_GROUP }));
    await w.settle();
    expect(w.engines[2]!.params.toolPolicy).toBe("safe-read-only");
  });

  it("a ring waits for the reconnect barrier before membership decides it", async () => {
    const w = await world();
    w.controller.start();
    await w.settle();
    w.client.emit("retry", { attempt: 1, delayMs: 1 }); // barrier closed until `reconnected` refreshes
    w.controller.handleEvent(w.ring());
    await w.settle();
    expect(w.ops()).not.toContain("answer_call");
    w.client.emit("reconnected");
    await w.settle();
    expect(w.ops()).toContain("answer_call");
  });
});

describe("H6: get_call after attach is retried", () => {
  it("a ring learned only from get_call is still answered when the first get_calls fail", async () => {
    const w = await world();
    w.ring();
    w.daemon.getCallFails = 2;
    w.controller.start();
    await new Promise((r) => setTimeout(r, 3_300));
    await w.settle();
    expect(w.ops()).toEqual(["set_call_handling", "get_call", "get_call", "get_call", "answer_call"]);
    expect(w.engines).toHaveLength(1);
  });
});
