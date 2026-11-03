// Watches and reports on live locations (openclaw-ademu #33): one turn per watch, plugin-sent reports, the
// visibility rule checked fresh, one terminal message per report.
import { describe, expect, it } from "vitest";
import { LiveLocations, type Share } from "../src/monitor/locations.js";
import { LocationWatches, MOVED_AGAIN_M, STILL_AFTER_MS, type Place } from "../src/monitor/location-watch.js";

const G = "11111111-1111-4111-8111-111111111111";
const DM = "55555555-5555-4555-8555-555555555555";
const MARIA = "22222222-2222-4222-8222-222222222222";
const TASOS = "33333333-3333-4333-8333-333333333333";
const HOME: Place = { name: "home", lat: 37.98, lon: 23.73 };
const START = { is_current: true, lat: 37.9, lon: 23.7, live: { until_ms: 10_000_000 }, type: "location" };
let seq = 100;
const frame = (body: unknown, lane = "durable", over: Record<string, unknown> = {}) => ({ seq: seq++, group_id: G, message_id: `m${seq}`, protocol: "ademu.chat", body, lane, created_at_ms: 1_000_000, sender: { user_id: MARIA }, ...over });
let pseq = 1;
const at = (lat: number, lon: number) => ({ type: "live_location", target_message_id: "l1", seq: pseq++, lat, lon, accuracy_m: 5, fix_at_ms: 0, until_ms: 10_000_000 });

function world(opts: { visible?: () => boolean } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let tid = 0;
  const loc = new LiveLocations({ now: () => clock });
  const sent: Array<[string, string]> = [];
  const turns: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const w = new LocationWatches({
    locations: loc,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, id: ++tid };
      timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    canSee: async () => (opts.visible ? opts.visible() : true),
    nameOf: (s: Share) => (s.sharerUserId === MARIA ? "Maria" : "?"),
    places: (c) => (c === DM ? [HOME] : []),
    send: async (c, text) => {
      sent.push([c, text]);
    },
    fireTurn: async (o, text) => {
      turns.push([o.conversationId, o.setterUserId, text]);
    },
    log: (e) => logs.push(e),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      clock = t.at;
      t.fn();
      await flush();
    }
    clock = end;
    await flush();
  };
  loc.received(frame(START, "durable", { message_id: "l1" }));
  const owner = { conversationId: DM, setterUserId: TASOS, shareId: "l1" };
  return { loc, w, sent, turns, logs, advance, flush, owner, move: async (lat: number, lon: number, lane = "live") => {
    loc.received(frame(at(lat, lon), lane));
    await flush();
  } };
}

describe("watches", () => {
  it("near: one turn when a position comes within the radius, never twice; already near sets nothing", async () => {
    const x = world();
    expect(x.w.addWatch(x.owner, { kind: "near", point: HOME, label: "home", radiusM: 500 })).toEqual({ id: expect.any(String) });
    await x.move(37.95, 23.72);
    expect(x.turns).toEqual([]);
    x.loc.received(frame(at(37.979, 23.73)));
    x.loc.received(frame(at(37.9795, 23.73)));
    await x.flush();
    expect(x.turns).toEqual([[DM, TASOS, "[location watch you were asked to set has fired: Maria is within 500 m of home. Tell the person who asked.]"]]);
    expect(x.w.list(DM)).toEqual([]);
    expect(x.w.addWatch(x.owner, { kind: "near", point: HOME, label: "home", radiusM: 500 })).toEqual({ already: true });
  });

  it("a position alone never starts a turn: no watch, no turn", async () => {
    const x = world();
    for (let i = 0; i < 5; i++) await x.move(37.98, 23.73, i % 2 ? "durable" : "live");
    expect(x.turns).toEqual([]);
    expect(x.sent).toEqual([]);
  });

  it("ended: the share's end fires its ended watch and drops the others", async () => {
    const x = world();
    x.w.addWatch(x.owner, { kind: "near", point: HOME, label: "home", radiusM: 50 });
    x.w.addWatch(x.owner, { kind: "ended" });
    x.loc.ended({ seq: seq++, group_id: G, message_id: "l1", reason: "stopped" });
    await x.flush();
    expect(x.turns.map((t) => t[2])).toEqual(["[location watch you were asked to set has fired: Maria's live location ended. Tell the person who asked.]"]);
    expect(x.w.list(DM)).toEqual([]);
  });

  it("still: fires after N minutes without a new position; every position restarts the wait", async () => {
    const x = world();
    x.w.addWatch(x.owner, { kind: "still", minutes: 10 });
    await x.advance(9 * 60_000);
    await x.move(37.91, 23.7);
    await x.advance(9 * 60_000);
    expect(x.turns).toEqual([]);
    await x.advance(60_000);
    expect(x.turns).toHaveLength(1);
    expect(x.turns[0]![2]).toContain("no new position for 10 min");
  });

  it("a watch whose conversation no longer passes the visibility rule starts no turn", async () => {
    let visible = true;
    const x = world({ visible: () => visible });
    x.w.addWatch(x.owner, { kind: "near", point: HOME, label: "home", radiusM: 500 });
    visible = false;
    await x.move(37.98, 23.73);
    expect(x.turns).toEqual([]);
    expect(x.logs).toContain("location_watch_hidden");
  });
});

describe("reports", () => {
  it("every N minutes the plugin sends the line itself: distance to the conversation's places, age, time left, map", async () => {
    const x = world();
    x.w.addReport(x.owner, 5 * 60_000);
    await x.advance(5 * 60_000);
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]![0]).toBe(DM);
    expect(x.sent[0]![1]).toMatch(/^📍 Maria — 9\.\d km from home · \d+ min ago · 2 h \d+ min left\nhttps:\/\/maps\.apple\.com\/\?ll=37\.900000,23\.700000$/);
    await x.advance(10 * 60_000);
    expect(x.sent).toHaveLength(3);
    expect(x.turns).toEqual([]);
  });

  it("the share's end sends one last message and nothing after, even with overlapping ends", async () => {
    const x = world();
    x.w.addReport(x.owner, 60_000);
    x.loc.ended({ seq: seq++, group_id: G, message_id: "l1", reason: "stopped" });
    x.loc.received(frame({ type: "delete", target_message_id: "l1" }));
    await x.advance(5 * 60_000);
    expect(x.sent.map((s) => s[1])).toEqual(["⏹ Maria stopped sharing their location. Reports end here."]);
  });

  it("still: a checkpoint then 3 min of silence pauses the reports; a checkpoint at the same place is not movement; moving away resumes", async () => {
    const x = world();
    x.w.addReport(x.owner, 60_000);
    await x.move(37.91, 23.7, "durable");
    await x.advance(STILL_AFTER_MS);
    const still = x.sent.filter((s) => s[1].startsWith("⏸"));
    expect(still).toHaveLength(1);
    const before = x.sent.length;
    await x.advance(5 * 60_000);
    expect(x.sent.length).toBe(before);
    await x.move(37.91, 23.7, "durable"); // reconnect checkpoint, same place
    await x.advance(30_000);
    expect(x.sent.length).toBe(before);
    await x.move(37.91 + (MOVED_AGAIN_M * 3) / 111_000, 23.7);
    expect(x.sent.at(-1)![1]).toBe("▶️ Maria is moving again.");
    await x.advance(60_000);
    expect(x.sent.at(-1)![1]).toMatch(/^📍 Maria/);
  });

  it("a seeded position never counts as a checkpoint", async () => {
    const x = world();
    x.loc.seed({ shares: [{ message_id: "l1", group_id: G, sender_user_id: MARIA, until_ms: 10_000_000, share_seq: 9, lat: 1, lon: 2, fix_at_ms: 0 }], as_of: seq++ });
    x.w.addReport(x.owner, 10 * 60_000);
    await x.advance(9 * 60_000);
    expect(x.sent.filter((s) => s[1].startsWith("⏸"))).toEqual([]);
  });

  it("a conversation that no longer passes the visibility rule gets one message without a position, then nothing", async () => {
    let visible = true;
    const x = world({ visible: () => visible });
    x.w.addReport(x.owner, 60_000);
    visible = false;
    await x.advance(5 * 60_000);
    expect(x.sent.map((s) => s[1])).toEqual(["⏹ Maria's location can no longer be shown here (this conversation's members changed). Reports end here."]);
  });

  it("until and cancel end it; stop silences everything", async () => {
    const x = world();
    x.w.addReport(x.owner, 60_000, 1_000_000 + 2 * 60_000 + 1);
    await x.advance(4 * 60_000);
    expect(x.sent.at(-1)![1]).toBe("⏹ Reports on Maria end here, as asked.");
    const n = x.sent.length;
    const { id } = x.w.addReport(x.owner, 60_000);
    expect(x.w.cancel(DM, id)).toBe(true);
    expect(x.w.cancel(G, id)).toBe(false);
    x.w.addReport(x.owner, 60_000);
    x.w.stop();
    await x.advance(5 * 60_000);
    expect(x.sent.length).toBe(n);
  });
});

describe("visibleFrom (the owner's rule, fresh memberships)", () => {
  const share = { groupId: G } as Share;
  const members: Record<string, string[]> = { [G]: [MARIA, TASOS, "agent"], [DM]: [TASOS, "agent"], work: [TASOS, "agent", "giannis"] };
  const get = async (g: string) => {
    if (!(g in members)) throw new Error("not_found");
    return members[g]!.map((user_id) => ({ user_id }));
  };
  it("the asker's 1-1 with the agent sees a share of a group they are both in; a room with an outsider does not; an unknown lookup fails closed", async () => {
    const { visibleFrom } = await import("../src/monitor/location-watch.js");
    expect(await visibleFrom(get, DM, share)).toBe(true);
    expect(await visibleFrom(get, "work", share)).toBe(false);
    expect(await visibleFrom(get, "nope", share)).toBe(false);
  });
});
