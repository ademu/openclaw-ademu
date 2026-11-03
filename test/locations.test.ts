// Live location state (openclaw-ademu #33, AdemuMLS #941): silent per-share positions, never a turn.
// Bodies from AdemuMLS adc/adc-proto/tests/fixtures/ipc_v2.ndjson lines 157–163 (#957).
import { describe, expect, it } from "vitest";
import { distanceMeters, LiveLocations } from "../src/monitor/locations.js";

const G = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const START = { accuracy_m: 6.5, is_current: true, lat: 37.9416, live: { comment: "On my way", until_ms: 7_600_000 }, lon: 23.7392, type: "location" };
const pos = (seq: number, over: Record<string, unknown> = {}) => ({ accuracy_m: 5.5, fix_at_ms: 7_000_000 + seq, lat: 37.96, lon: 23.75, seq, target_message_id: "l2", type: "live_location", until_ms: 7_600_000, ...over });
const frame = (seq: number, body: unknown, over: Record<string, unknown> = {}) => ({ seq, group_id: G, message_id: `m${seq}`, protocol: "ademu.chat", body, lane: "durable", created_at_ms: 7001, sender: { user_id: ALICE, username: "alice" }, ...over });

function world(now = 7_100_000) {
  let clock = now;
  const loc = new LiveLocations({ now: () => clock });
  return { loc, tick: (ms: number) => (clock += ms) };
}

describe("LiveLocations", () => {
  it("a START opens a share at seq 0 with its own pin; positions above it move it, on either lane", () => {
    const { loc } = world();
    loc.received(frame(68, START, { message_id: "l2" }));
    expect(loc.shares().map((s) => [s.id, s.seq, s.lat, s.lon])).toEqual([["l2", 0, 37.9416, 23.7392]]);
    loc.received(frame(69, pos(3), { lane: "live" }));
    loc.received(frame(70, pos(4, { lat: 37.97 }), { lane: "durable" }));
    const [s] = loc.shares();
    expect([s!.seq, s!.lat, s!.lastLane, s!.fixAtMs, s!.untilMs, s!.sharerUserId, s!.groupId]).toEqual([4, 37.97, "durable", 7_000_004, 7_600_000, ALICE, G]);
  });

  it("drops a position at or below the known seq, for an unknown START, from another user or another group", () => {
    const { loc } = world();
    loc.received(frame(68, START, { message_id: "l2" }));
    loc.received(frame(69, pos(4)));
    for (const f of [
      frame(70, pos(4, { lat: 1 })),
      frame(71, pos(3, { lat: 1 })),
      frame(72, pos(9, { lat: 1, target_message_id: "nope" })),
      frame(73, pos(9, { lat: 1 }), { sender: { user_id: BOB } }),
      frame(74, pos(9, { lat: 1 }), { group_id: "44444444-4444-4444-8444-444444444444" }),
      frame(75, pos(9, { lat: 91 })),
    ]) {
      loc.received(f);
    }
    expect(loc.shares()[0]!.lat).toBe(37.96);
  });

  it("a pin without live, a non-chat frame or a malformed START opens nothing", () => {
    const { loc } = world();
    loc.received(frame(1, { type: "location", lat: 1, lon: 2, is_current: true }));
    loc.received(frame(2, START, { protocol: "example.cursor" }));
    loc.received(frame(3, { ...START, live: { until_ms: "soon" } }));
    expect(loc.shares()).toEqual([]);
  });

  it("location_ended, a delete of the START and leaving the group end it; an expired share is gone", () => {
    const { loc, tick } = world();
    loc.received(frame(68, START, { message_id: "l2" }));
    expect(loc.ended({ seq: 71, group_id: G, message_id: "l2", reason: "stopped" })?.id).toBe("l2");
    expect(loc.shares()).toEqual([]);
    loc.received(frame(80, START, { message_id: "l3" }));
    loc.received(frame(81, { type: "delete", target_message_id: "l3" }));
    expect(loc.shares()).toEqual([]);
    loc.received(frame(82, START, { message_id: "l4" }));
    loc.leftGroup(G);
    expect(loc.shares()).toEqual([]);
    loc.received(frame(83, START, { message_id: "l5" }));
    tick(600_000);
    expect(loc.shares()).toEqual([]);
  });

  it("seeding replaces the state and ignores every event at or below as_of", () => {
    const { loc } = world();
    loc.received(frame(10, START, { message_id: "old" }));
    loc.seed({ shares: [{ message_id: "l2", group_id: G, sender_user_id: ALICE, until_ms: 7_600_000, comment: "On my way", share_seq: 4, lat: 37.96, lon: 23.75, accuracy_m: 5.5, fix_at_ms: 7_220_000 }], as_of: 70 });
    expect(loc.shares().map((s) => [s.id, s.seq])).toEqual([["l2", 4]]);
    loc.received(frame(70, pos(5, { lat: 1 })));
    expect(loc.ended({ seq: 69, group_id: G, message_id: "l2", reason: "stopped" })).toBeUndefined();
    expect(loc.shares()[0]!.lat).toBe(37.96);
    loc.received(frame(71, pos(5, { lat: 37.99 })));
    expect(loc.shares()[0]!.lat).toBe(37.99);
  });

  it("a seeded share never counts as a checkpoint, and a share gone from the snapshot ended while away", () => {
    const { loc } = world();
    const ends: Array<[string, string | undefined]> = [];
    loc.onChange((c) => c.kind === "ended" && ends.push([c.share.id, c.reason]));
    loc.received(frame(10, START, { message_id: "gone" }));
    loc.seed({ shares: [{ message_id: "l2", group_id: G, sender_user_id: ALICE, until_ms: 7_600_000, share_seq: 4, lat: 1, lon: 2, fix_at_ms: 7_000_000 }], as_of: 70 });
    expect(loc.get("l2")!.lastLane).toBe("seeded");
    expect(ends).toEqual([["gone", "ended_while_away"]]);
  });

  it("seedFrom: the daemon's answer, nothing from a daemon without the query, nothing after a failed one", async () => {
    const { loc } = world();
    const snap = { shares: [{ message_id: "l2", group_id: G, sender_user_id: ALICE, until_ms: 7_600_000, share_seq: 4, lat: 1, lon: 2, fix_at_ms: 7_000_000 }], as_of: 70 };
    const client = (services: string[], answer: () => Promise<unknown>) => ({ hello: { services }, request: <R>() => answer() as Promise<R> });
    expect(await loc.seedFrom(client(["get_live_locations"], async () => snap))).toBe("seeded");
    expect(loc.shares()).toHaveLength(1);
    expect(await loc.seedFrom(client(["get_live_locations"], async () => Promise.reject(new Error("x"))))).toBe("failed");
    expect(loc.shares()).toEqual([]);
    await loc.seedFrom(client(["get_live_locations"], async () => snap));
    expect(await loc.seedFrom(client([], async () => snap))).toBe("unsupported");
    expect(loc.shares()).toEqual([]);
  });

  it("measures distance on the sphere", () => {
    expect(distanceMeters({ lat: 37.9416, lon: 23.7392 }, { lat: 37.9416, lon: 23.7392 })).toBe(0);
    const d = distanceMeters({ lat: 37.9838, lon: 23.7275 }, { lat: 37.9715, lon: 23.7257 }); // Syntagma → Acropolis
    expect(d).toBeGreaterThan(1300);
    expect(d).toBeLessThan(1450);
  });
});
