import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AdemuStore, HOLDER_STALE_MS, SCHEMA_VERSION } from "../src/store.js";

const tmp = mkdtempSync(join(tmpdir(), "ademu-store-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let clock = 1_000_000;
const now = () => clock;
const alive = () => true;
const dead = () => false;

function fresh(path = ":memory:") {
  return AdemuStore.open({ path, now });
}

describe("schema", () => {
  it("creates the file under <stateDir>/ademu/ademu.sqlite with the current schema version", () => {
    const store = AdemuStore.open({ stateDir: join(tmp, "state"), now });
    expect(store.path).toBe(join(tmp, "state", "ademu", "ademu.sqlite"));
    store.close();
    const again = AdemuStore.open({ stateDir: join(tmp, "state"), now });
    expect(again.listOwnership()).toEqual([]);
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

describe("ownership rows and generation CAS", () => {
  const dir = "/tmp/x/adc";
  const base = { dataDir: dir, controlSocket: `${dir}/adc.sock`, sessionSocket: `${dir}/adc-session.sock`, ownerPid: 42, ownerPidStartedAt: "t0" };

  it("claim is first-wins; the closed enum and generations fence transitions", () => {
    const s = fresh();
    expect(s.claim(base)).toBe(true);
    expect(s.claim(base)).toBe(false);
    const claimed = s.getOwnership(dir)!;
    expect(claimed).toMatchObject({ state: "claimed", generation: 0, ownerPid: 42 });

    const starting = s.cas({ dataDir: dir, from: ["claimed"], to: "starting", expectedGeneration: 0, bumpGeneration: true, set: { deadlineMs: now() + 20_000 } });
    expect(starting).toMatchObject({ state: "starting", generation: 1 });
    // a stale contender with the old generation loses
    expect(s.cas({ dataDir: dir, from: ["starting"], to: "bound", expectedGeneration: 0 })).toBeUndefined();
    const bound = s.cas({
      dataDir: dir,
      from: ["starting"],
      to: "bound",
      expectedGeneration: 1,
      set: { daemonPid: 4242, daemonPidStartedAt: "t1", daemonStartedAtMs: 123, daemonDataDir: dir, daemonSocketPath: base.controlSocket, daemonSessionSocketPath: base.sessionSocket, adcVersion: "0.2.4", bundledVersion: "0.2.4" },
    });
    expect(bound).toMatchObject({ state: "bound", generation: 1, daemonPid: 4242, adcVersion: "0.2.4" });
    // a transition from the wrong state loses
    expect(s.cas({ dataDir: dir, from: ["claimed"], to: "stale" })).toBeUndefined();
    s.close();
  });

  it("exact-state, exact-generation delete", () => {
    const s = fresh();
    s.claim(base);
    s.cas({ dataDir: dir, from: ["claimed"], to: "starting", bumpGeneration: true });
    expect(s.deleteOwnership({ dataDir: dir, state: "claimed", generation: 1 })).toBe(false);
    expect(s.deleteOwnership({ dataDir: dir, state: "starting", generation: 0 })).toBe(false);
    expect(s.deleteOwnership({ dataDir: dir, state: "starting", generation: 1 })).toBe(true);
    expect(s.getOwnership(dir)).toBeUndefined();
    s.close();
  });
});

describe("holders and the atomic shutdown fence", () => {
  const dir = "/tmp/y/adc";
  const own = { dataDir: dir, controlSocket: `${dir}/adc.sock`, sessionSocket: `${dir}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "t" };
  const holder = (id: string, role: "runtime" | "setup", pid: number) => ({ holderId: id, dataDir: dir, role, pid, pidStartedAt: `p${pid}`, heartbeatMs: now() });

  function boundStore() {
    const s = fresh();
    s.claim(own);
    s.cas({ dataDir: dir, from: ["claimed"], to: "starting", bumpGeneration: true });
    s.cas({ dataDir: dir, from: ["starting"], to: "bound", expectedGeneration: 1 });
    return s;
  }

  it("a runtime lease cannot claim shutdown while another live holder exists (any process, any role)", () => {
    const s = boundStore();
    expect(s.addHolder(holder("gw", "runtime", 100))).toBe(true);
    expect(s.addHolder(holder("cli", "setup", 200))).toBe(true);
    const claimed = s.tryClaimShutdown({ dataDir: dir, holderId: "gw", expectedGeneration: 1, stopperPid: 100, stopperPidStartedAt: "p100", deadlineMs: now() + 10_000, reason: "test", isProcessAlive: alive });
    expect(claimed).toBeUndefined();
    expect(s.getOwnership(dir)!.state).toBe("bound");
    s.close();
  });

  it("stale holders (old heartbeat or dead pid) are swept inside the fence, then shutdown is claimed", () => {
    const s = boundStore();
    s.addHolder(holder("gw", "runtime", 100));
    s.addHolder({ ...holder("old-cli", "setup", 200), heartbeatMs: now() - HOLDER_STALE_MS - 1 });
    s.addHolder(holder("dead-cli", "setup", 300));
    const claimed = s.tryClaimShutdown({
      dataDir: dir,
      holderId: "gw",
      expectedGeneration: 1,
      stopperPid: 100,
      stopperPidStartedAt: "p100",
      deadlineMs: now() + 10_000,
      reason: "last account stopped",
      isProcessAlive: (pid) => pid !== 300,
    });
    expect(claimed).toMatchObject({ state: "stopping", generation: 2, ownerPid: 100, reason: "last account stopped" });
    expect(s.listHolders(dir).map((h) => h.holderId)).toEqual(["gw"]);
    s.close();
  });

  it("no acquisition can slip in while stopping; heartbeat of a swept holder fails closed", () => {
    const s = boundStore();
    s.addHolder(holder("gw", "runtime", 100));
    s.tryClaimShutdown({ dataDir: dir, holderId: "gw", expectedGeneration: 1, stopperPid: 100, stopperPidStartedAt: "p100", deadlineMs: now() + 10_000, reason: "r", isProcessAlive: alive });
    expect(s.addHolder(holder("late", "setup", 400))).toBe(false);
    expect(s.listHolders(dir).some((h) => h.holderId === "late")).toBe(false);
    // clean exit → stopped → a later acquire may register again
    s.cas({ dataDir: dir, from: ["stopping"], to: "stopped", expectedGeneration: 2 });
    expect(s.addHolder(holder("late", "setup", 400))).toBe(true);
    // a swept holder's heartbeat returns false
    s.sweepStaleHolders(dir, dead);
    expect(s.heartbeat("late")).toBe(false);
    s.close();
  });

  it("the fence loses when the generation moved", () => {
    const s = boundStore();
    s.addHolder(holder("gw", "runtime", 100));
    const r = s.tryClaimShutdown({ dataDir: dir, holderId: "gw", expectedGeneration: 0, stopperPid: 100, stopperPidStartedAt: "p", deadlineMs: 1, reason: "r", isProcessAlive: alive });
    expect(r).toBeUndefined();
    s.close();
  });

  it("two connections to one file see each other's rows (busy_timeout set)", () => {
    const path = join(tmp, "shared.sqlite");
    const a = AdemuStore.open({ path, now });
    const b = AdemuStore.open({ path, now });
    a.claim(own);
    expect(b.getOwnership(dir)?.state).toBe("claimed");
    b.addHolder(holder("from-b", "setup", 7));
    expect(a.listHolders(dir).map((h) => h.holderId)).toEqual(["from-b"]);
    clock += 1;
    a.close();
    b.close();
  });
});
