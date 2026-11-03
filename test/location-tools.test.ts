// The live-location tools (#33): scoped to the turn's conversation, every share behind the visibility rule.
import { afterEach, describe, expect, it } from "vitest";
import { LiveLocations, type Share } from "../src/monitor/locations.js";
import { LocationWatches, type Place } from "../src/monitor/location-watch.js";
import { registerLiveAccount, resetLiveAccountsForTests } from "../src/outbound.js";
import { createLiveLocationsTool, createPlaceTool, createWatchTool } from "../src/tools/locations.js";

const G = "11111111-1111-4111-8111-111111111111";
const DM = "55555555-5555-4555-8555-555555555555";
const WORK = "66666666-6666-4666-8666-666666666666";
const MARIA = "22222222-2222-4222-8222-222222222222";
const TASOS = "33333333-3333-4333-8333-333333333333";

afterEach(() => resetLiveAccountsForTests());

function setup() {
  const locations = new LiveLocations({ now: () => 1_000_000 });
  locations.received({ seq: 1, group_id: G, message_id: "l1", protocol: "ademu.chat", body: { type: "location", is_current: true, lat: 37.9, lon: 23.7, live: { until_ms: 9_000_000 } }, lane: "durable", created_at_ms: 1_000_000, sender: { user_id: MARIA } });
  const places = new Map<string, Place[]>();
  const sent: string[] = [];
  const watches = new LocationWatches({
    locations,
    now: () => 1_000_000,
    setTimer: () => 0,
    clearTimer: () => {},
    canSee: async (c) => c === DM,
    nameOf: () => "Maria",
    places: (c) => places.get(c) ?? [],
    send: async (_c, t) => {
      sent.push(t);
    },
    fireTurn: async () => {},
    log: () => {},
  });
  registerLiveAccount("iris", {
    client: {} as never,
    liveLocations: {
      locations,
      watches,
      places: {
        list: (c) => places.get(c) ?? [],
        set: (c, p) => places.set(c, [...(places.get(c) ?? []).filter((x) => x.name !== p.name), p]),
        remove: (c, n) => places.delete(c),
      },
      canSee: async (c: string, _s: Share) => c === DM,
      nameOf: () => "Maria",
    },
  });
  const ctx = (conversation: string, extra: Record<string, unknown> = {}) =>
    ({ messageChannel: "ademu", agentAccountId: "iris", deliveryContext: { channel: "ademu", to: `ademu:${conversation}`, accountId: "iris" }, requesterSenderId: TASOS, ...extra }) as never;
  const run = async (tool: { execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }> } | null, args: unknown = {}) =>
    (await tool!.execute("t", args)).content[0]!.text;
  return { ctx, run, watches, places, locations };
}

describe("ademu_live_locations", () => {
  it("lists a share in a conversation that passes the rule, nothing elsewhere; off Ademú it is not offered", async () => {
    const x = setup();
    expect(await x.run(createLiveLocationsTool(x.ctx(DM)))).toMatch(/^share_id=l1\n📍 Maria · just now · 2 h 13 min left\nhttps:\/\/maps\.apple\.com\/\?ll=37\.900000,23\.700000$/);
    expect(await x.run(createLiveLocationsTool(x.ctx(WORK)))).toBe("Nobody shares a live location that can be shown in this conversation.");
    expect(createLiveLocationsTool({ messageChannel: "telegram" } as never)).toBeNull();
  });
});

describe("ademu_place", () => {
  it("saves from coordinates or from a visible share; refuses a share the conversation cannot see and bad input", async () => {
    const x = setup();
    expect(await x.run(createPlaceTool(x.ctx(DM)), { action: "save", name: " Home ", lat: 37.98, lon: 23.73 })).toBe('Saved "Home".');
    expect(await x.run(createPlaceTool(x.ctx(DM)), { action: "save", name: "school", share_id: "l1" })).toBe('Saved "school".');
    expect(x.places.get(DM)).toEqual([{ name: "Home", lat: 37.98, lon: 23.73 }, { name: "school", lat: 37.9, lon: 23.7 }]);
    await expect(x.run(createPlaceTool(x.ctx(WORK)), { action: "save", name: "spy", share_id: "l1" })).rejects.toThrow(/no such live location/);
    await expect(x.run(createPlaceTool(x.ctx(DM)), { action: "save", name: "x", lat: 91, lon: 0 })).rejects.toThrow(/out of range/);
    await expect(x.run(createPlaceTool(x.ctx(DM)), { action: "save", name: "x".repeat(41), lat: 1, lon: 1 })).rejects.toThrow(/out of range/);
    expect(await x.run(createPlaceTool(x.ctx(DM)), { action: "list" })).toBe("Home: 37.98, 23.73\nschool: 37.9, 23.7");
  });
});

describe("ademu_location_watch", () => {
  it("sets a near watch on a saved place, a still watch and a report; lists and cancels them in their conversation only", async () => {
    const x = setup();
    x.places.set(DM, [{ name: "Home", lat: 37.98, lon: 23.73 }]);
    const tool = () => createWatchTool(x.ctx(DM));
    expect(await x.run(tool(), { action: "set", share_id: "l1", kind: "near", place: "home", radius_m: 500 })).toMatch(/^Watch w\d+ set \(near\)/);
    expect(await x.run(tool(), { action: "set", share_id: "l1", kind: "still" })).toMatch(/^Watch w\d+ set \(still\)/);
    expect(await x.run(tool(), { action: "set", share_id: "l1", kind: "eta", place: "Home", minutes: 5 })).toMatch(/^Watch w\d+ set \(eta\)/);
    expect(await x.run(tool(), { action: "set", share_id: "l1", kind: "report", minutes: 5, phrases: { ago: "πριν {time}" } })).toMatch(/^Report r\d+ set: every 5 min/);
    const rid = x.watches.list(DM).find((i) => i.kind === "report")!.id;
    expect(await x.run(tool(), { action: "update", id: rid, phrases: { ago: "{time} ago" } })).toBe(`Report ${rid} now uses these phrases.`);
    expect(await x.run(createWatchTool(x.ctx(WORK)), { action: "update", id: rid, phrases: {} })).toMatch(/^No report/);
    expect((await x.run(tool(), { action: "list" })).split("\n")).toHaveLength(4);
    expect(await x.run(createWatchTool(x.ctx(WORK)), { action: "list" })).toBe("No watches or reports in this conversation.");
    const id = x.watches.list(DM)[0]!.id;
    expect(await x.run(createWatchTool(x.ctx(WORK)), { action: "cancel", id })).toMatch(/^No watch or report/);
    expect(await x.run(tool(), { action: "cancel", id })).toBe(`Cancelled ${id}.`);
  });

  it("refuses: a share this conversation cannot see, a report under a minute, an unknown place, no requester", async () => {
    const x = setup();
    await expect(x.run(createWatchTool(x.ctx(WORK)), { action: "set", share_id: "l1", kind: "ended" })).rejects.toThrow(/no such live location/);
    await expect(x.run(createWatchTool(x.ctx(DM)), { action: "set", share_id: "l1", kind: "report", minutes: 0.5 })).rejects.toThrow(/out of range/);
    await expect(x.run(createWatchTool(x.ctx(DM)), { action: "set", share_id: "l1", kind: "near", place: "mars" })).rejects.toThrow(/No place named "mars"/);
    await expect(x.run(createWatchTool(x.ctx(DM)), { action: "set", share_id: "l1", kind: "eta", lat: 1, lon: 1 })).rejects.toThrow(/out of range/);
    await expect(x.run(createWatchTool(x.ctx(DM, { requesterSenderId: undefined })), { action: "set", share_id: "l1", kind: "ended" })).rejects.toThrow(/only be read while answering/);
    expect(x.watches.list(DM)).toEqual([]);
  });

  it("a near watch already true sets nothing", async () => {
    const x = setup();
    expect(await x.run(createWatchTool(x.ctx(DM)), { action: "set", share_id: "l1", kind: "near", lat: 37.9, lon: 23.7, radius_m: 100 })).toMatch(/already true/);
    expect(x.watches.list(DM)).toEqual([]);
  });
});
