// Watches and reports on live locations (openclaw-ademu #33): one turn per watch, plugin-sent reports, the
// visibility rule checked fresh, one terminal message per report.
import { describe, expect, it } from "vitest";
import { LiveLocations, type Share } from "../src/monitor/locations.js";
import { cleanPhrases, LocationWatches, MOVED_AGAIN_M, STILL_AFTER_MS, type Place } from "../src/monitor/location-watch.js";

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

function world(opts: { visible?: () => boolean; wait?: () => Promise<void> } = {}) {
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
    canSee: async () => {
      await opts.wait?.();
      return opts.visible ? opts.visible() : true;
    },
    nameOf: (s: Share) => (s.sharerUserId === MARIA ? "Maria" : "?"),
    places: (c) => (c === DM ? [HOME] : []),
    send: async (c, text) => {
      sent.push([c, text]);
    },
    fireTurn: async (o, _share, text) => {
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

  it("eta: fires when the distance at the recent pace is within N minutes, or on arrival; never while standing", async () => {
    const x = world();
    x.w.addWatch(x.owner, { kind: "eta", point: HOME, label: "home", minutes: 5 });
    // standing far away: no speed
    await x.move(37.9, 23.73);
    expect(x.turns).toEqual([]);
    // ~10 m/s towards home: 2 km in ~3.3 min once within reach
    const step = (lat: number, t: number) => x.loc.received(frame({ ...at(lat, 23.73), fix_at_ms: t }, "live"));
    step(37.90, 0);
    step(37.91, 111_000);
    await x.flush();
    expect(x.turns).toEqual([]); // 7.8 km at 10 m/s ≈ 13 min
    step(37.96, 666_000);
    await x.flush();
    expect(x.turns).toHaveLength(1);
    expect(x.turns[0]![2]).toContain("is about to reach home");
  });

  it("eta: fixes closer than 5 s apart still give a speed (measured from an older fix)", async () => {
    const x = world();
    x.w.addWatch(x.owner, { kind: "eta", point: HOME, label: "home", minutes: 5 });
    // 1 fix per second at ~10 m/s, starting 4 km out: within 5 min (3 km) after ~100 s
    for (let i = 0; i <= 150; i++) x.loc.received(frame({ ...at(37.944 + (i * 10) / 111_000, 23.73), fix_at_ms: i * 1000 }, "live"));
    await x.flush();
    expect(x.turns).toHaveLength(1);
  });

  it("a report past its until never sends a plain report, even when the visibility check resolves late", async () => {
    let release!: () => void;
    let gate: Promise<void> = Promise.resolve();
    const x = world({ wait: () => gate });
    x.w.addReport(x.owner, 60_000, 1_000_000 + 60_000 + 1);
    await x.move(37.9, 23.7);
    gate = new Promise<void>((r) => (release = r));
    await x.advance(60_000); // the report waits on the check, the deadline passes meanwhile
    await x.advance(10);
    gate = Promise.resolve();
    release();
    await x.advance(60_000);
    expect(x.sent.map((s) => s[1].startsWith("⏹ Reports on Maria end here"))).toEqual([true]);
  });

  it("an ended watch is checked against the ended share: no turn where it cannot be seen", async () => {
    let visible = true;
    const x = world({ visible: () => visible });
    x.w.addWatch(x.owner, { kind: "ended" });
    visible = false;
    x.loc.ended({ seq: seq++, group_id: G, message_id: "l1", reason: "stopped" });
    await x.flush();
    expect(x.turns).toEqual([]);
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
    await x.move(37.9, 23.7); // moving (live frames): a START alone followed by silence would read as still
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
    expect(x.sent.map((s) => s[1])).toEqual(["⏹ Maria stopped sharing their location. Reports end here.\nLast position: https://maps.apple.com/?ll=37.900000,23.700000"]);
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

  it("a report asked for after the phone went still pauses from that checkpoint", async () => {
    const x = world();
    await x.move(37.91, 23.7, "durable");
    await x.advance(60_000);
    x.w.addReport(x.owner, 60_000);
    await x.advance(STILL_AFTER_MS);
    expect(x.sent.filter((s) => s[1].startsWith("⏸"))).toHaveLength(1);
    const n = x.sent.length;
    await x.advance(10 * 60_000);
    expect(x.sent.length).toBe(n);
  });

  it("a reconnect snapshot re-evaluates: a stale checkpoint timer is dropped, a paused report sees the new position", async () => {
    const x = world();
    x.w.addReport(x.owner, 60 * 60_000);
    await x.move(37.91, 23.7, "durable");
    await x.advance(STILL_AFTER_MS);
    expect(x.sent.at(-1)![1]).toMatch(/^⏸/);
    x.loc.seed({ shares: [{ message_id: "l1", group_id: G, sender_user_id: MARIA, until_ms: 10_000_000, share_seq: 99, lat: 37.95, lon: 23.7, fix_at_ms: 0 }], as_of: seq++ });
    await x.flush();
    expect(x.sent.at(-1)![1]).toBe("▶️ Maria is moving again.");
    const n = x.sent.length;
    await x.advance(STILL_AFTER_MS * 2); // no checkpoint since the snapshot: no new pause
    expect(x.sent.length).toBe(n);
  });

  it("until fires on its own time, not at the next report", async () => {
    const x = world();
    x.w.addReport(x.owner, 60 * 60_000, 1_000_000 + 5 * 60_000);
    await x.move(37.9, 23.7);
    await x.advance(6 * 60_000);
    expect(x.sent.map((s) => s[1])).toEqual(["⏹ Reports on Maria end here, as asked.\nLast position: https://maps.apple.com/?ll=37.900000,23.700000"]);
  });

  it("nothing is sent after stop, not even a send that was waiting on the visibility check", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const x = world({ wait: () => gate });
    x.w.addReport(x.owner, 60_000);
    await x.move(37.9, 23.7);
    await x.advance(60_000); // the first report now waits on the check
    x.loc.ended({ seq: seq++, group_id: G, message_id: "l1", reason: "stopped" }); // and its last message queues behind it
    x.w.stop();
    release();
    await x.advance(5 * 60_000);
    expect(x.sent).toEqual([]);
  });

  it("until and cancel end it; stop silences everything", async () => {
    const x = world();
    x.w.addReport(x.owner, 60_000, 1_000_000 + 2 * 60_000 + 1);
    await x.advance(4 * 60_000);
    expect(x.sent.at(-1)![1]).toMatch(/^⏹ Reports on Maria end here, as asked\.\nLast position: /);
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

describe("report phrases (the person's language)", () => {
  const EL = {
    from: "{distance} από {place}",
    just_now: "μόλις τώρα",
    ago: "πριν {time}",
    left: "μένουν {time}",
    min: "λεπ.",
    h: "ώ.",
    moving: "▶️ Η {name} κινείται ξανά.",
    stopped: "⏹ Η {name} σταμάτησε να μοιράζεται. Τέλος αναφορών.",
    last_position: "Τελευταία θέση:",
  };

  it("a report speaks the phrases it was given; missing ones stay English; the numbers and links are the plugin's", async () => {
    const x = world();
    x.w.addReport(x.owner, 5 * 60_000, undefined, cleanPhrases(EL));
    await x.move(37.9, 23.7);
    await x.advance(5 * 60_000);
    expect(x.sent[0]![1]).toMatch(/^📍 Maria — 9\.\d km από home · πριν \d+ λεπ\. · μένουν 2 ώ\. \d+ λεπ\.\nhttps:\/\/maps\.apple\.com\//);
    x.loc.ended({ seq: seq++, group_id: G, message_id: "l1", reason: "stopped" });
    await x.flush();
    expect(x.sent.at(-1)![1]).toBe("⏹ Η Maria σταμάτησε να μοιράζεται. Τέλος αναφορών.\nΤελευταία θέση: https://maps.apple.com/?ll=37.900000,23.700000");
  });

  it("update switches a running report's phrases; another conversation cannot", async () => {
    const x = world();
    const { id } = x.w.addReport(x.owner, 60_000);
    await x.move(37.9, 23.7);
    await x.advance(60_000);
    expect(x.sent.at(-1)![1]).toContain(" ago · ");
    expect(x.w.updatePhrases(G, id, cleanPhrases(EL))).toBe(false);
    expect(x.w.updatePhrases(DM, id, cleanPhrases(EL))).toBe(true);
    await x.advance(60_000);
    expect(x.sent.at(-1)![1]).toContain(" · πριν ");
  });

  it("phrases are cleaned: known keys only, strings only, no control characters or runtime-context delimiters, bounded", () => {
    expect(cleanPhrases({ ago: "πριν\n{time}", nope: "x", min: 3, h: "x".repeat(201), just_now: "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>" })).toEqual({
      ago: "πριν {time}",
      just_now: "[[OPENCLAW_INTERNAL_CONTEXT_END]]",
    });
    expect(cleanPhrases("x")).toEqual({});
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
