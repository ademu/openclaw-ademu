import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { AdemuStore, SCHEMA_VERSION } from "../src/store.js";

const tmp = mkdtempSync(join(tmpdir(), "ademu-store-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let clock = 1_000_000;
const now = () => clock;

function fresh(path = ":memory:") {
  return AdemuStore.open({ path, now });
}

describe("schema", () => {
  it("creates the file under <stateDir>/ademu/ademu.sqlite with the current schema version", () => {
    const store = AdemuStore.open({ stateDir: join(tmp, "state"), now });
    expect(store.path).toBe(join(tmp, "state", "ademu", "ademu.sqlite"));
    store.close();
    const again = AdemuStore.open({ stateDir: join(tmp, "state"), now });
    expect(again.getWatermark("nobody")).toBeUndefined();
    again.close();
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("watermarks", () => {
  it("commits, is monotonic per device, and resets on device change", () => {
    const s = fresh();
    expect(s.getWatermark("a")).toBeUndefined();
    s.setWatermark("a", "dev1", 5);
    expect(s.getWatermark("a")).toEqual({ deviceId: "dev1", adoptedSeq: 5 });
    s.setWatermark("a", "dev1", 3); // a lower seq never regresses the cursor
    expect(s.getWatermark("a")!.adoptedSeq).toBe(5);
    s.setWatermark("a", "dev1", 9);
    expect(s.getWatermark("a")!.adoptedSeq).toBe(9);
    s.resetWatermark("a", "dev2");
    expect(s.getWatermark("a")).toEqual({ deviceId: "dev2", adoptedSeq: -1 });
    s.setWatermark("a", "dev2", 1);
    expect(s.getWatermark("a")).toEqual({ deviceId: "dev2", adoptedSeq: 1 });
    expect(() => s.setWatermark("a", "dev2", -2)).toThrow(RangeError);
    expect(() => s.setWatermark("a", "dev2", 1.5)).toThrow(RangeError);
    s.deleteWatermark("a");
    expect(s.getWatermark("a")).toBeUndefined();
    s.close();
  });
});

describe("no daemon state (AdemuMLS #712)", () => {
  it("a fresh database has no ownership or holder tables; an old one with them still opens and keeps its watermarks", () => {
    const path = join(tmp, "tables.sqlite");
    const s = AdemuStore.open({ path, now });
    s.setWatermark("a", "dev", 3);
    s.close();
    const raw = new DatabaseSync(path);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables.sort()).toEqual(["schema_version", "watermarks"]);
    // An earlier build's dead tables are harmless: nothing reads them, the file opens as schema 1.
    raw.exec("CREATE TABLE daemon_ownership (data_dir TEXT PRIMARY KEY) STRICT;");
    raw.exec("CREATE TABLE daemon_holders (holder_id TEXT PRIMARY KEY) STRICT;");
    raw.close();
    const again = AdemuStore.open({ path, now });
    expect(again.getWatermark("a")).toEqual({ deviceId: "dev", adoptedSeq: 3 });
    again.close();
  });

  it("two connections to one file see each other's rows (busy_timeout set)", () => {
    const path = join(tmp, "shared.sqlite");
    const a = AdemuStore.open({ path, now });
    const b = AdemuStore.open({ path, now });
    a.setWatermark("shared", "dev", 7);
    expect(b.getWatermark("shared")).toEqual({ deviceId: "dev", adoptedSeq: 7 });
    clock += 1;
    a.close();
    b.close();
  });
});
