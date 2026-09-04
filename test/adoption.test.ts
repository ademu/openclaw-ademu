import { describe, expect, it } from "vitest";
import { AdoptionFailedError, AdoptionTracker } from "../src/monitor/adoption.js";

type Timer = { fn: () => void; ms: number; cleared: boolean };
class Timers {
  list: Timer[] = [];
  set = (fn: () => void, ms: number) => {
    const t = { fn, ms, cleared: false };
    this.list.push(t);
    return t;
  };
  clear = (h: unknown) => {
    (h as Timer).cleared = true;
  };
  fireLast() {
    const live = this.list.filter((t) => !t.cleared);
    live.at(-1)?.fn();
  }
}

function tracker(commit = () => {}) {
  const timers = new Timers();
  const t = new AdoptionTracker({ seq: 7, commit, setTimer: timers.set, clearTimer: timers.clear, stallMs: 1000 });
  return { t, timers };
}

describe("AdoptionTracker — onAdopted is the durable commit", () => {
  it("commits inside onAdopted before resolving, then settles adopted", async () => {
    let committed = 0;
    const { t } = tracker(() => {
      committed++;
    });
    expect(t.state).toBe("pending");
    const p = t.lifecycle.onAdopted();
    expect(committed).toBe(1); // synchronous commit
    await p;
    expect(t.state).toBe("adopted");
    await expect(t.settled).resolves.toEqual({ kind: "adopted" });
  });

  it("is idempotent: a second onAdopted returns the same commit promise without a second write", async () => {
    let committed = 0;
    const { t } = tracker(() => {
      committed++;
    });
    await t.lifecycle.onAdopted();
    await t.lifecycle.onAdopted();
    expect(committed).toBe(1);
  });

  it("a failing commit rejects onAdopted (core never starts the run) and settled", async () => {
    const { t } = tracker(() => {
      throw new Error("disk full");
    });
    await expect(t.lifecycle.onAdopted()).rejects.toBeInstanceOf(AdoptionFailedError);
    await expect(t.settled).rejects.toMatchObject({ reason: "commit_failed" });
    expect(t.state).toBe("abandoned");
  });

  it("a late onAdopted after close throws (the guillotine)", async () => {
    let committed = 0;
    const { t } = tracker(() => {
      committed++;
    });
    t.close();
    await expect(t.lifecycle.onAdopted()).rejects.toMatchObject({ reason: "closed" });
    expect(committed).toBe(0);
  });
});

describe("AdoptionTracker — deferred handoff and failures", () => {
  it("after onDeferred the dispatch resolution is ignored; adoption arrives later through onAdopted", async () => {
    let committed = 0;
    const { t } = tracker(() => {
      committed++;
    });
    t.lifecycle.onDeferred();
    expect(t.state).toBe("deferred");
    t.onDispatchSettled({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {}, deferredToActiveRun: "followup" } });
    expect(committed).toBe(0);
    expect(t.state).toBe("deferred");
    await t.lifecycle.onAdopted();
    expect(committed).toBe(1);
    await expect(t.settled).resolves.toEqual({ kind: "adopted" });
  });

  it("a dispatch that resolves as deferred WITHOUT the callback also waits for adoption", async () => {
    const { t } = tracker();
    t.onDispatchSettled({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {}, deferredToActiveRun: "steer" } });
    expect(t.state).toBe("deferred");
  });

  it("onAbandoned, dispatch rejection, own abort and the watchdog each reject settled with their reason", async () => {
    const a = tracker();
    a.t.lifecycle.onAbandoned();
    await expect(a.t.settled).rejects.toMatchObject({ reason: "abandoned" });

    const b = tracker();
    b.t.onDispatchSettled(undefined, new Error("boom"));
    await expect(b.t.settled).rejects.toMatchObject({ reason: "dispatch_rejected" });

    const c = tracker();
    c.t.abort();
    expect(c.t.lifecycle.abortSignal.aborted).toBe(true);
    await expect(c.t.settled).rejects.toMatchObject({ reason: "aborted" });

    const d = tracker();
    d.timers.fireLast();
    await expect(d.t.settled).rejects.toMatchObject({ reason: "watchdog" });
  });

  it("heartbeats re-arm the watchdog; adoption clears it", async () => {
    const { t, timers } = tracker();
    t.lifecycle.onDeferred();
    t.lifecycle.onDeferredHeartbeat?.();
    const before = timers.list.filter((x) => !x.cleared).length;
    expect(before).toBe(1);
    await t.lifecycle.onAdopted();
    expect(timers.list.filter((x) => !x.cleared)).toHaveLength(0);
  });

  it("abort never touches an adopted turn", async () => {
    const { t } = tracker();
    await t.lifecycle.onAdopted();
    t.abort();
    expect(t.lifecycle.abortSignal.aborted).toBe(false);
    expect(t.state).toBe("adopted");
  });
});

describe("AdoptionTracker — callback-free classification (§2 R2b)", () => {
  it("dispatched:false (core declined pre-dispatch) → adopted-equivalent 'declined' with a commit", async () => {
    let committed = 0;
    const { t } = tracker(() => {
      committed++;
    });
    t.onDispatchSettled({ dispatched: false });
    await expect(t.settled).resolves.toEqual({ kind: "adopted-equivalent", reason: "declined" });
    expect(committed).toBe(1);
  });

  it("visible output → 'processed'", async () => {
    const { t } = tracker();
    t.onDispatchSettled({ dispatched: true, dispatchResult: { queuedFinal: true, counts: { final: 1 } } });
    await expect(t.settled).resolves.toEqual({ kind: "adopted-equivalent", reason: "processed" });
  });

  it("a receipt with nothing visible is NOT evidence; observedReplyDelivery is", async () => {
    const a = tracker();
    a.t.onDispatchSettled({
      dispatched: true,
      dispatchResult: { queuedFinal: true, counts: { final: 1 }, settledReceipt: { anyVisibleDelivered: false, counts: {} } },
    });
    await expect(a.t.settled).resolves.toEqual({ kind: "adopted-equivalent", reason: "callback_free_completion" });

    const b = tracker();
    b.t.onDispatchSettled({
      dispatched: true,
      dispatchResult: { queuedFinal: false, counts: {}, observedReplyDelivery: true, settledReceipt: { anyVisibleDelivered: false, counts: {} } },
    });
    await expect(b.t.settled).resolves.toEqual({ kind: "adopted-equivalent", reason: "processed" });
  });

  it("deliberate silence and fallback delivery count as processed", async () => {
    const a = tracker();
    a.t.onDispatchSettled({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {}, deliberateSilentTerminalReply: true } });
    await expect(a.t.settled).resolves.toEqual({ kind: "adopted-equivalent", reason: "processed" });
  });

  it("zero output with no callback → at-most-once 'callback_free_completion' (R10), still committed + settled", async () => {
    let committed = 0;
    const { t } = tracker(() => {
      committed++;
    });
    t.onDispatchSettled({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {} } });
    await expect(t.settled).resolves.toEqual({ kind: "adopted-equivalent", reason: "callback_free_completion" });
    expect(committed).toBe(1);
  });

  it("our own abort before the callback-free resolution fails instead of acking", async () => {
    const { t } = tracker();
    t.lifecycle.abortSignal; // arm
    t.abort();
    t.onDispatchSettled({ dispatched: true, dispatchResult: { queuedFinal: false, counts: {} } });
    await expect(t.settled).rejects.toMatchObject({ reason: "aborted" });
  });
});
