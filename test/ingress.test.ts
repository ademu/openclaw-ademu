// THE correctness pin (plan T7): the ingress loop over a fake client, a fake host runtime with a
// controllable dispatch, the real security resolver, and the real in-memory store. Every ack rule
// of §2 R2b is asserted here.
import { InvalidTokenError } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import { AdoptionFailedError } from "../src/monitor/adoption.js";
import { startIngress, MAX_INFLIGHT, type RuntimeChannelSurface } from "../src/monitor/ingress.js";
import { openSession } from "../src/monitor/session.js";
import { createAdemuIngressResolver } from "../src/security.js";
import { IngressHaltedError, IngressProtocolError } from "../src/status.js";
import { AdemuStore } from "../src/store.js";
import { AGENT, DEVICE, FakeAdcClient, fakeConnect, GUEST, member, OWNER, ROOM_DM, ROOM_GROUP } from "./fakes/adc.js";

const cfg = {
  channels: { ademu: { accounts: { iris: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER, token: "t" } } } },
  agents: { entries: { main: { identity: { name: "Iris" } } } },
} as unknown as OpenClawConfig;

type Dispatch = {
  plan: Record<string, unknown>;
  lifecycle: { onAdopted: () => Promise<void>; onDeferred: () => void; onAbandoned: () => void; abortSignal: AbortSignal };
  resolve: (result: { dispatched: boolean; dispatchResult?: unknown }) => void;
  reject: (err: unknown) => void;
};

function fakeRuntime() {
  const dispatches: Dispatch[] = [];
  let waiters: Array<(d: Dispatch) => void> = [];
  const runtime: RuntimeChannelSurface = {
    inbound: {
      buildContext: (params) => ({ ctx: params }),
      dispatch: (plan) =>
        new Promise((resolve, reject) => {
          const lifecycle = (plan.replyOptions as { turnAdoptionLifecycle: Dispatch["lifecycle"] }).turnAdoptionLifecycle;
          const d: Dispatch = { plan, lifecycle, resolve, reject };
          dispatches.push(d);
          for (const w of waiters.splice(0)) w(d);
        }),
    },
    routing: {
      resolveAgentRoute: (input) => ({ agentId: "main", accountId: String(input.accountId), sessionKey: `agent:main:ademu:${(input.peer as { id: string }).id}`, dmScope: "main" }),
    },
    commands: {
      shouldComputeCommandAuthorized: (body) => body.trim().startsWith("/"),
      isControlCommandMessage: (body) => body.trim().startsWith("/"),
    },
  };
  const nextDispatch = () =>
    new Promise<Dispatch>((r) => {
      const pending = dispatches.find((d) => !(d as { seen?: boolean }).seen);
      if (pending) {
        (pending as { seen?: boolean }).seen = true;
        r(pending);
      } else waiters.push((d) => {
        (d as { seen?: boolean }).seen = true;
        r(d);
      });
    });
  return { runtime, dispatches, nextDispatch };
}

async function world(
  opts: {
    lastAckedSeq?: number;
    watermark?: { deviceId: string; adoptedSeq: number };
    agentName?: string;
    onSecurityNotice?: (groupId: string | undefined) => void;
  } = {},
) {
  const client = new FakeAdcClient({ lastAckedSeq: opts.lastAckedSeq });
  client.room(ROOM_DM, [member(OWNER, "human", "Marios"), member(AGENT, "agent", "Iris")]);
  client.room(ROOM_GROUP, [member(OWNER, "human", "Marios"), member(GUEST, "human", "Jhessy", "jhessy"), member(AGENT, "agent", "Iris")]);
  const { connect } = fakeConnect(client);
  const logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
  const store = AdemuStore.open({ path: ":memory:" });
  if (opts.watermark) store.setWatermark("iris", opts.watermark.deviceId, opts.watermark.adoptedSeq);
  const session = await openSession({ token: "t", sessionSocketPath: "/s", account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER }, deps: { connect, now: () => 0, log: () => {} } });
  const rt = fakeRuntime();
  const ac = new AbortController();
  const handle = startIngress({
    accountId: "iris",
    cfg,
    runtime: rt.runtime,
    session,
    store,
    resolver: createAdemuIngressResolver({ accountId: "iris", cfg }),
    account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER, agentName: opts.agentName ?? "Iris" },
    mentionAliases: [],
    typingKeepaliveMs: 2000,
    sendText: async (group_id, body) => client.sendText({ group_id, body }),
    signal: ac.signal,
    log: (event, fields) => logs.push({ event, fields }),
    stallMs: 60_000,
    ...(opts.onSecurityNotice ? { onSecurityNotice: opts.onSecurityNotice } : {}),
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { client, store, session, rt, handle, logs, ac, settle };
}

describe("ack at adoption, in order", () => {
  it("does not ack before onAdopted; commits the watermark inside onAdopted; acks after", async () => {
    const w = await world();
    const ev = w.client.message({ body: "hi" });
    const d = await w.rt.nextDispatch();
    await w.settle();
    expect(w.client.acks).toEqual([]);
    expect(w.store.getWatermark("iris")).toBeUndefined();
    await d.lifecycle.onAdopted();
    expect(w.store.getWatermark("iris")).toEqual({ deviceId: DEVICE, adoptedSeq: ev.seq });
    await w.settle();
    expect(w.client.acks).toEqual([ev.seq]);
    // the run is still in flight; the message was acked at adoption, not completion
    expect(w.handle.inflight.size).toBe(1);
    d.resolve({ dispatched: true, dispatchResult: { queuedFinal: true, counts: { final: 1 } } });
  });

  it("N+1 is not dispatched until N is adopted; runs then overlap", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    w.client.message({ body: "two" });
    const d1 = await w.rt.nextDispatch();
    await w.settle();
    expect(w.rt.dispatches).toHaveLength(1);
    await d1.lifecycle.onAdopted();
    const d2 = await w.rt.nextDispatch();
    expect(w.rt.dispatches).toHaveLength(2);
    expect(w.handle.inflight.size).toBe(2); // both runs alive concurrently
    await d2.lifecycle.onAdopted();
    await w.settle();
    expect(w.client.acks).toEqual([0, 1]);
  });

  it(`bounds concurrent runs at ${MAX_INFLIGHT}: the loop waits for one settlement before dispatching more`, async () => {
    const w = await world();
    for (let i = 0; i < MAX_INFLIGHT + 1; i++) w.client.message({ body: `m${i}` });
    const ds: Dispatch[] = [];
    for (let i = 0; i < MAX_INFLIGHT; i++) {
      const d = await w.rt.nextDispatch();
      ds.push(d);
      await d.lifecycle.onAdopted();
    }
    await w.settle();
    expect(w.rt.dispatches).toHaveLength(MAX_INFLIGHT);
    expect(w.client.acks).toHaveLength(MAX_INFLIGHT);
    ds[0]!.resolve({ dispatched: true, dispatchResult: { queuedFinal: true, counts: { final: 1 } } });
    const d5 = await w.rt.nextDispatch();
    expect(d5).toBeDefined();
    expect(w.rt.dispatches).toHaveLength(MAX_INFLIGHT + 1);
  });
});

describe("immediate acks after a gate decision", () => {
  it("replay ≤ watermark for the same device → ack, no dispatch", async () => {
    const w = await world({ watermark: { deviceId: DEVICE, adoptedSeq: 3 } });
    w.client.message({ seq: 2 });
    w.client.message({ seq: 3 });
    await w.settle();
    expect(w.client.acks).toEqual([2, 3]);
    expect(w.rt.dispatches).toHaveLength(0);
    w.client.message({ seq: 4 });
    await w.rt.nextDispatch();
    expect(w.rt.dispatches).toHaveLength(1);
  });

  it("self-sent → ack, no dispatch", async () => {
    const w = await world();
    w.client.message({ sender_user_id: AGENT });
    await w.settle();
    expect(w.client.acks).toEqual([0]);
    expect(w.rt.dispatches).toHaveLength(0);
  });

  it("a stranger's DM → dropped and acked (decision 1 + 5)", async () => {
    const w = await world();
    w.client.room("11111111-1111-4111-8111-111111111111", [member(GUEST), member(AGENT, "agent")]);
    w.client.message({ group_id: "11111111-1111-4111-8111-111111111111", sender_user_id: GUEST, body: "psst" });
    await w.settle();
    expect(w.client.acks).toEqual([0]);
    expect(w.rt.dispatches).toHaveLength(0);
    expect(w.logs.some((l) => l.event === "ingress_sender_dropped")).toBe(true);
  });

  it("room manners: the owner is heard unaddressed, a guest only when addressing the agent", async () => {
    const w = await world();
    w.client.message({ group_id: ROOM_GROUP, sender_user_id: OWNER, body: "what do you think?" });
    const d1 = await w.rt.nextDispatch();
    await d1.lifecycle.onAdopted();
    w.client.message({ group_id: ROOM_GROUP, sender_user_id: GUEST, body: "nobody asked you" });
    await w.settle();
    expect(w.client.acks).toEqual([0, 1]);
    expect(w.rt.dispatches).toHaveLength(1);
    expect(w.logs.some((l) => l.event === "ingress_unaddressed_skipped")).toBe(true);
    w.client.message({ group_id: ROOM_GROUP, sender_user_id: GUEST, body: "Iris, what do you think?" });
    const d3 = await w.rt.nextDispatch();
    expect(w.rt.dispatches).toHaveLength(2);
    const ctx = (d3.plan.ctxPayload as { ctx: Record<string, unknown> }).ctx;
    expect((ctx.sender as { name: string }).name).toBe("Jhessy");
    expect((ctx.conversation as { kind: string }).kind).toBe("group");
    expect((ctx.access as { mentions: { wasMentioned: boolean } }).mentions.wasMentioned).toBe(true);
  });

  it("malformed payload with a valid seq → ack; a malformed seq halts", async () => {
    const w = await world();
    w.client.message({ group_id: "not-a-uuid" });
    await w.settle();
    expect(w.client.acks).toEqual([0]);
    const lifetime = w.handle.lifetime.catch((e: Error) => e);
    w.client.message({ seq: -1 as never });
    const err = await lifetime;
    // A frame the daemon must never send is a TERMINAL protocol violation (blocked), not a restart loop.
    expect(err).toBeInstanceOf(IngressProtocolError);
  });

  it("unknown events are logged with event + seq only, never the raw payload", async () => {
    const w = await world();
    w.client.unknown();
    await w.settle();
    const log = w.logs.find((l) => l.event === "event_unknown")!;
    expect(Object.keys(log.fields ?? {}).sort()).toEqual(["event", "seq"]);
    expect(JSON.stringify(log)).not.toContain("secret");
  });
});

describe("the halt rule (§2 R2b rider R3)", () => {
  it("a dispatch that rejects before adoption halts: no ack for N or later, lifetime rejects, ingress unavailable", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    w.client.message({ body: "two" });
    const d1 = await w.rt.nextDispatch();
    const lifetime = w.handle.lifetime.catch((e: Error) => e);
    d1.reject(new Error("session store exploded"));
    const err = await lifetime;
    expect(err).toBeInstanceOf(IngressHaltedError);
    expect(((err as IngressHaltedError).cause as AdoptionFailedError).reason).toBe("dispatch_rejected");
    await w.settle();
    expect(w.client.acks).toEqual([]);
    expect(w.rt.dispatches).toHaveLength(1);
  });

  it("onAbandoned before adoption halts too", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    const d1 = await w.rt.nextDispatch();
    const lifetime = w.handle.lifetime.catch((e: Error) => e);
    d1.lifecycle.onAbandoned();
    expect(await lifetime).toBeInstanceOf(IngressHaltedError);
    expect(w.client.acks).toEqual([]);
  });

  it("an ack that throws (client not seated) halts with the watermark kept", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    const d1 = await w.rt.nextDispatch();
    w.client.seated = false;
    const lifetime = w.handle.lifetime.catch((e: Error) => e);
    await d1.lifecycle.onAdopted();
    expect(await lifetime).toBeInstanceOf(IngressHaltedError);
    expect(w.store.getWatermark("iris")!.adoptedSeq).toBe(0);
    expect(w.client.acks).toEqual([]);
  });

  it("after a halt, late adoption of a closed tracker is refused", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    w.client.message({ body: "two" });
    const d1 = await w.rt.nextDispatch();
    const lifetime = w.handle.lifetime.catch((e: Error) => e);
    d1.reject(new Error("x"));
    await lifetime;
    // the failed tracker is abandoned; any other pending tracker is closed — both refuse to commit
    await expect(d1.lifecycle.onAdopted()).rejects.toBeInstanceOf(AdoptionFailedError);
    expect(w.store.getWatermark("iris")).toBeUndefined();
  });
});

describe("callback-free and deferred completions", () => {
  it("dispatched:false (core declined) → commit + ack", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    const d = await w.rt.nextDispatch();
    d.resolve({ dispatched: false });
    await w.settle();
    expect(w.client.acks).toEqual([0]);
    expect(w.store.getWatermark("iris")!.adoptedSeq).toBe(0);
  });

  it("zero-output completion → at-most-once ack + callback_free_completion log (R10)", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    const d = await w.rt.nextDispatch();
    d.resolve({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {} } });
    await w.settle();
    expect(w.client.acks).toEqual([0]);
    expect(w.logs.some((l) => l.event === "callback_free_completion")).toBe(true);
  });

  it("deferred handoff: the dispatch resolution is ignored, the ack waits for the later adoption", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    const d = await w.rt.nextDispatch();
    d.lifecycle.onDeferred();
    d.resolve({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {}, deferredToActiveRun: "followup" } });
    await w.settle();
    expect(w.client.acks).toEqual([]);
    await d.lifecycle.onAdopted();
    await w.settle();
    expect(w.client.acks).toEqual([0]);
  });
});

describe("projection, commands, typing and shutdown", () => {
  it("projects the Tlon/SMS shape: top-level messageId/timestamp, route with routeSessionKey, reply, command facts for a slash command", async () => {
    const w = await world();
    const ev = w.client.message({ body: "/status" });
    const d = await w.rt.nextDispatch();
    const ctx = (d.plan.ctxPayload as { ctx: Record<string, unknown> }).ctx;
    expect(ctx.messageId).toBe(ev.message_id);
    expect(ctx.timestamp).toBe(ev.created_at_ms);
    expect((ctx.route as { routeSessionKey: string }).routeSessionKey).toBe(`agent:main:ademu:${ROOM_DM}`);
    expect((ctx.reply as { to: string }).to).toBe(`ademu:${ROOM_DM}`);
    expect((ctx.access as { commands: { authorized: boolean } }).commands.authorized).toBe(true);
    expect((ctx.command as { kind: string; authorized: boolean })).toMatchObject({ kind: "text-slash", authorized: true });
    expect(ctx.channelIngress).toBeDefined();
    expect((d.plan.route as { sessionKey: string }).sessionKey).toBe(`agent:main:ademu:${ROOM_DM}`);
    expect((d.plan.delivery as { durable: () => { to: string } }).durable().to).toBe(`ademu:${ROOM_DM}`);
    const pipeline = d.plan.replyPipeline as { typingCallbacks?: { onReplyStart: () => Promise<void> } };
    expect(pipeline.typingCallbacks).toBeDefined();
  });

  it("a guest's slash command is projected as unauthorized", async () => {
    const w = await world();
    w.client.message({ group_id: ROOM_GROUP, sender_user_id: GUEST, body: "/status Iris" });
    const d = await w.rt.nextDispatch();
    const ctx = (d.plan.ctxPayload as { ctx: Record<string, unknown> }).ctx;
    expect((ctx.access as { commands: { authorized: boolean } }).commands.authorized).toBe(false);
  });

  it("delivery sends the reply text into the conversation", async () => {
    const w = await world();
    w.client.message({ body: "hi" });
    const d = await w.rt.nextDispatch();
    const delivery = d.plan.delivery as { deliver: (p: { text?: string }) => Promise<{ visibleReplySent: boolean }> };
    expect(await delivery.deliver({ text: "hello!" })).toEqual({ visibleReplySent: true });
    expect(w.client.sent).toEqual([{ group_id: ROOM_DM, body: "hello!" }]);
    expect(await delivery.deliver({})).toEqual({ visibleReplySent: false });
  });

  it("stop aborts only un-adopted messages and closes the generation; adopted runs keep their signal", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    w.client.message({ body: "two" });
    const d1 = await w.rt.nextDispatch();
    await d1.lifecycle.onAdopted();
    const d2 = await w.rt.nextDispatch();
    w.handle.stop();
    expect(d1.lifecycle.abortSignal.aborted).toBe(false);
    expect(d2.lifecycle.abortSignal.aborted).toBe(true);
    await expect(d2.lifecycle.onAdopted()).rejects.toBeInstanceOf(AdoptionFailedError);
    await w.settle();
    expect(w.client.acks).toEqual([0]);
  });

  it("the reconnect barrier holds the loop until live state is refreshed", async () => {
    const w = await world();
    w.client.emit("retry", { attempt: 1, delayMs: 1 });
    w.client.message({ body: "after reconnect" });
    await w.settle();
    expect(w.rt.dispatches).toHaveLength(0);
    w.client.emit("reconnected");
    await w.rt.nextDispatch();
    expect(w.rt.dispatches).toHaveLength(1);
  });

  it("membership_changed invalidates the room; removed_from_group marks it inactive", async () => {
    const w = await world();
    const calls = w.client.getMembersCalls;
    w.client.live({ event: "membership_changed", group_id: ROOM_GROUP, user_id: GUEST, username: "j", kind: "human", display_name: "J", change: "left" });
    w.client.live({ event: "removed_from_group", group_id: ROOM_DM });
    await w.settle();
    expect(w.session.members.isInactive(ROOM_DM)).toBe(true);
    await w.session.members.get(ROOM_GROUP);
    expect(w.client.getMembersCalls).toBe(calls + 1);
    expect(w.client.acks).toEqual([]); // live events carry no ack
  });
});

describe("Codex branch-review folds", () => {
  it("#2 a deferred turn stays under the guillotine: dispatch resolves → stop → late onAdopted throws, no ack, no watermark", async () => {
    const w = await world();
    w.client.message({ body: "one" });
    const d = await w.rt.nextDispatch();
    d.lifecycle.onDeferred();
    d.resolve({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {}, deferredToActiveRun: "followup" } });
    await w.settle();
    w.handle.stop();
    await expect(d.lifecycle.onAdopted()).rejects.toBeInstanceOf(AdoptionFailedError);
    await w.settle();
    expect(w.client.acks).toEqual([]);
    expect(w.store.getWatermark("iris")).toBeUndefined();
  });

  it("#3 a terminal client error from the iterator passes through unwrapped (blocked), not as IngressHaltedError", async () => {
    const w = await world();
    const lifetime = w.handle.lifetime.catch((e: unknown) => e);
    w.client.failStream(new InvalidTokenError());
    const err = await lifetime;
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err).not.toBeInstanceOf(IngressHaltedError);
  });

  it("#16 the ROUTED agent's own identity counts as a mention (account name ≠ agent identity name)", async () => {
    const w = await world({ agentName: "Bot" });
    w.client.message({ group_id: ROOM_GROUP, sender_user_id: GUEST, body: "Iris, are you there?" });
    const d = await w.rt.nextDispatch(); // dispatched: "Iris" is agents.entries.main.identity.name
    expect(d).toBeDefined();
    const w2 = await world({ agentName: "Bot" });
    w2.client.message({ group_id: ROOM_GROUP, sender_user_id: GUEST, body: "nobody in particular" });
    await w2.settle();
    expect(w2.rt.dispatches).toHaveLength(0);
    expect(w2.client.acks).toEqual([0]);
  });

  it("#21 a future security_notice event reaches the caller with the room id only; nothing from the frame is logged", async () => {
    const notices: Array<string | undefined> = [];
    const w = await world({ onSecurityNotice: (g) => notices.push(g) });
    w.client.unknownEvent("security_notice", { group_id: ROOM_GROUP, reason: "SECRET-DETAIL", raw_blob: "xyz" });
    w.client.unknownEvent("security_notice", { nothing: true });
    await w.settle();
    expect(notices).toEqual([ROOM_GROUP, undefined]);
    expect(JSON.stringify(w.logs)).not.toContain("SECRET-DETAIL");
    expect(w.client.acks).toEqual([]);
  });
});
