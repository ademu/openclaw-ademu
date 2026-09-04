import { describe, expect, it } from "vitest";
import { assertIdentity, openSession } from "../src/monitor/session.js";
import { IdentityMismatchError } from "../src/status.js";
import { AGENT, DEVICE, FakeAdcClient, fakeConnect, GUEST, member, OWNER, ROOM_DM, ROOM_GROUP } from "./fakes/adc.js";

const log = () => {};

describe("identity binding (fail closed)", () => {
  const hello = { v: 1, type: "hello" as const, device_id: DEVICE, agent_user_id: AGENT, proto: 1, last_acked_seq: -1, capabilities: [] };
  const self = { user_id: AGENT, device_id: DEVICE, username: "iris", display_name: "Iris", owner_user_id: OWNER };

  it("accepts a matching account (case-insensitively) and owner", () => {
    expect(() => assertIdentity(hello, self, { deviceId: DEVICE.toUpperCase(), agentUserId: AGENT, ownerUserId: OWNER })).not.toThrow();
    expect(() => assertIdentity(hello, self, { deviceId: DEVICE, agentUserId: AGENT })).not.toThrow();
  });

  it("rejects a swapped device, agent, or owner", () => {
    expect(() => assertIdentity(hello, self, { deviceId: GUEST, agentUserId: AGENT })).toThrow(IdentityMismatchError);
    expect(() => assertIdentity(hello, self, { deviceId: DEVICE, agentUserId: GUEST })).toThrow(IdentityMismatchError);
    expect(() => assertIdentity(hello, self, { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: GUEST })).toThrow(IdentityMismatchError);
    expect(() => assertIdentity({ ...hello, device_id: GUEST }, self, { deviceId: DEVICE, agentUserId: AGENT })).toThrow(IdentityMismatchError);
  });
});

describe("openSession", () => {
  it("connects with takeover on the SESSION socket, warms conversations + members, exposes self", async () => {
    const client = new FakeAdcClient();
    client.room(ROOM_DM, [member(OWNER), member(AGENT, "agent")]);
    client.room(ROOM_GROUP, [member(OWNER), member(GUEST), member(AGENT, "agent")]);
    client.room("old", [member(OWNER)], false);
    const { connect, calls } = fakeConnect(client);
    const session = await openSession({
      token: "adc1_t",
      sessionSocketPath: "/tmp/adc-session.sock",
      account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER },
      deps: { connect, now: () => 0, log },
    });
    expect(calls[0]).toMatchObject({ socketPath: "/tmp/adc-session.sock", takeover: true, reconnect: "auto" });
    expect(session.self.owner_user_id).toBe(OWNER);
    expect(session.members.conversations).toHaveLength(3);
    expect(client.getMembersCalls).toBe(2); // active rooms only
    expect(session.members.isInactive("old")).toBe(true);
    expect(await session.members.get(ROOM_DM)).toHaveLength(2);
    expect(client.getMembersCalls).toBe(2); // cached
  });

  it("closes the client and fails closed on identity mismatch", async () => {
    const client = new FakeAdcClient({ ownerUserId: GUEST });
    const { connect } = fakeConnect(client);
    await expect(
      openSession({ token: "t", sessionSocketPath: "/s", account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER }, deps: { connect, now: () => 0, log } }),
    ).rejects.toBeInstanceOf(IdentityMismatchError);
    expect(client.closed).toBe(true);
  });

  it("unknown sender → one members refresh for that room", async () => {
    const client = new FakeAdcClient();
    client.room(ROOM_GROUP, [member(OWNER), member(AGENT, "agent")]);
    const { connect } = fakeConnect(client);
    const session = await openSession({ token: "t", sessionSocketPath: "/s", account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER }, deps: { connect, now: () => 0, log } });
    client.members.set(ROOM_GROUP, [member(OWNER), member(GUEST), member(AGENT, "agent")]);
    const calls = client.getMembersCalls;
    const members = await session.members.getWithSender(ROOM_GROUP, GUEST);
    expect(members.some((m) => m.user_id === GUEST)).toBe(true);
    expect(client.getMembersCalls).toBe(calls + 1);
  });

  it("reconnect barrier: retry marks stale; reconnected refreshes live state before releasing", async () => {
    const client = new FakeAdcClient();
    client.room(ROOM_GROUP, [member(OWNER), member(AGENT, "agent")]);
    const { connect } = fakeConnect(client);
    const retries: number[] = [];
    const session = await openSession({
      token: "t",
      sessionSocketPath: "/s",
      account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER },
      deps: { connect, now: () => 0, log },
      onRetry: (info) => retries.push(info.attempt),
    });
    await session.barrier(); // fresh: immediate
    client.emit("retry", { attempt: 1, delayMs: 100 });
    client.emit("retry", { attempt: 2, delayMs: 200 });
    expect(session.retries()).toBe(2);
    expect(retries).toEqual([1, 2]);
    let released = false;
    const wait = session.barrier().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    // membership changed while disconnected
    client.members.set(ROOM_GROUP, [member(OWNER), member(GUEST), member(AGENT, "agent")]);
    client.emit("reconnected");
    await wait;
    expect(released).toBe(true);
    expect(session.retries()).toBe(0);
    expect((await session.members.get(ROOM_GROUP)).some((m) => m.user_id === GUEST)).toBe(true);
  });

  it("#5 a failed warm-up keeps the barrier CLOSED and closes the client (restart), never ready on a partial cache", async () => {
    const client = new FakeAdcClient();
    client.room(ROOM_GROUP, [member(OWNER), member(AGENT, "agent")]);
    const { connect } = fakeConnect(client);
    let reconnected = 0;
    const session = await openSession({
      token: "t",
      sessionSocketPath: "/s",
      account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER },
      deps: { connect, now: () => 0, log },
      onReconnected: () => reconnected++,
    });
    client.emit("retry", { attempt: 1, delayMs: 1 });
    let released = false;
    void session.barrier().then(() => {
      released = true;
    });
    client.refreshFails = true;
    client.emit("reconnected");
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(false);
    expect(reconnected).toBe(0);
    expect(client.closed).toBe(true);
  });

  it("#5 a superseded warm-up (newer outage) cannot open the barrier; the latest one does", async () => {
    const client = new FakeAdcClient();
    client.room(ROOM_GROUP, [member(OWNER), member(AGENT, "agent")]);
    const { connect } = fakeConnect(client);
    let reconnected = 0;
    const session = await openSession({
      token: "t",
      sessionSocketPath: "/s",
      account: { deviceId: DEVICE, agentUserId: AGENT, ownerUserId: OWNER },
      deps: { connect, now: () => 0, log },
      onReconnected: () => reconnected++,
    });
    // Slow the first warm-up: listConversations blocks until we let it go.
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const original = client.listConversations.bind(client);
    let calls = 0;
    client.listConversations = async () => {
      calls++;
      if (calls === 1) await slow;
      return original();
    };
    client.emit("retry", { attempt: 1, delayMs: 1 });
    client.emit("reconnected"); // generation 1 warm-up starts (slow)
    client.emit("retry", { attempt: 1, delayMs: 1 }); // newer outage → generation 2
    let released = false;
    void session.barrier().then(() => {
      released = true;
    });
    releaseSlow(); // the stale warm-up finishes — must NOT open the barrier
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(false);
    expect(reconnected).toBe(0);
    client.emit("reconnected"); // generation 2 warm-up
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(true);
    expect(reconnected).toBe(1);
  });
});
