import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import { resolveAdemuAccount } from "../src/config.js";
import { DEFAULT_HISTORY_LIMIT, forgetRoomHistory, peekRoomHistory, recordSkipped, resolveHistoryLimit, type RoomHistory } from "../src/monitor/history.js";

const ROOM = "5f0c9a1e-8d2b-4c3a-9e1f-0a1b2c3d4e5f";
const OTHER = "9b2b6d1e-3c1a-4f8e-9a1b-2c3d4e5f6a7b";
const entry = (body: string) => ({ sender: "Jhessy", body, timestamp: 1, messageId: `m-${body}` });

describe("room history buffer", () => {
  it("keeps skipped messages per conversation, oldest first, keyed case-insensitively", () => {
    const h: RoomHistory = new Map();
    recordSkipped(h, ROOM, entry("a"), 10);
    recordSkipped(h, ROOM.toUpperCase(), entry("b"), 10);
    recordSkipped(h, OTHER, entry("x"), 10);
    expect(peekRoomHistory(h, ROOM)!.entries.map((e) => e.body)).toEqual(["a", "b"]);
    expect(peekRoomHistory(h, OTHER)!.entries.map((e) => e.body)).toEqual(["x"]);
  });

  it("drops the oldest past the limit; 0 keeps nothing; a missing limit is the default", () => {
    const h: RoomHistory = new Map();
    for (const b of ["a", "b", "c"]) recordSkipped(h, ROOM, entry(b), 2);
    expect(peekRoomHistory(h, ROOM)!.entries.map((e) => e.body)).toEqual(["b", "c"]);

    const off: RoomHistory = new Map();
    recordSkipped(off, ROOM, entry("a"), 0);
    expect(peekRoomHistory(off, ROOM)).toBeUndefined();

    const dflt: RoomHistory = new Map();
    for (let i = 0; i < DEFAULT_HISTORY_LIMIT + 5; i++) recordSkipped(dflt, ROOM, entry(String(i)));
    expect(peekRoomHistory(dflt, ROOM)!.entries).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(peekRoomHistory(dflt, ROOM)!.entries[0]!.body).toBe("5");
  });

  it("peek does not clear; consume removes only what was read (a message kept meanwhile survives)", () => {
    const h: RoomHistory = new Map();
    recordSkipped(h, ROOM, entry("a"), 10);
    const read = peekRoomHistory(h, ROOM)!;
    expect(peekRoomHistory(h, ROOM)!.entries).toHaveLength(1);
    recordSkipped(h, ROOM, entry("late"), 10);
    read.consume();
    expect(peekRoomHistory(h, ROOM)!.entries.map((e) => e.body)).toEqual(["late"]);
    peekRoomHistory(h, ROOM)!.consume();
    expect(h.size).toBe(0);
  });

  it("forget drops one conversation's history, matched case-insensitively", () => {
    const h: RoomHistory = new Map();
    recordSkipped(h, ROOM, entry("a"), 10);
    recordSkipped(h, OTHER, entry("x"), 10);
    forgetRoomHistory(h, ROOM.toUpperCase());
    expect(peekRoomHistory(h, ROOM)).toBeUndefined();
    expect(peekRoomHistory(h, OTHER)!.entries).toHaveLength(1);
    expect(() => forgetRoomHistory(undefined, ROOM)).not.toThrow();
  });

  it("nothing kept → nothing to peek; no map → nothing recorded", () => {
    expect(peekRoomHistory(new Map(), ROOM)).toBeUndefined();
    expect(peekRoomHistory(undefined, ROOM)).toBeUndefined();
    expect(() => recordSkipped(undefined, ROOM, entry("a"), 10)).not.toThrow();
  });
});

describe("resolveHistoryLimit", () => {
  const account = (cfg: unknown) => resolveAdemuAccount(cfg as OpenClawConfig, "iris", { HOME: "/home/t" }, () => false);
  const base = { deviceId: "d", token: "t" };

  it("account over channel over messages.groupChat over 50", () => {
    const both = { channels: { ademu: { historyLimit: 7, accounts: { iris: { ...base, historyLimit: 3 } } } }, messages: { groupChat: { historyLimit: 9 } } };
    expect(resolveHistoryLimit(both as never, account(both))).toBe(3);
    const channel = { channels: { ademu: { historyLimit: 7, accounts: { iris: base } } }, messages: { groupChat: { historyLimit: 9 } } };
    expect(resolveHistoryLimit(channel as never, account(channel))).toBe(7);
    const global = { channels: { ademu: { accounts: { iris: base } } }, messages: { groupChat: { historyLimit: 9 } } };
    expect(resolveHistoryLimit(global as never, account(global))).toBe(9);
    const none = { channels: { ademu: { accounts: { iris: base } } } };
    expect(resolveHistoryLimit(none as never, account(none))).toBe(DEFAULT_HISTORY_LIMIT);
  });

  it("0 at the account turns it off even when the channel sets one", () => {
    const off = { channels: { ademu: { historyLimit: 7, accounts: { iris: { ...base, historyLimit: 0 } } } } };
    expect(resolveHistoryLimit(off as never, account(off))).toBe(0);
  });

  it("a negative global value clamps to 0", () => {
    expect(resolveHistoryLimit({ messages: { groupChat: { historyLimit: -4 } } } as never, {})).toBe(0);
  });
});
