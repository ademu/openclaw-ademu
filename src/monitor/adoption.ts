// AdoptionTracker (design entry §2 R2b, plan T7): one per inbound `message_received`. It owns the
// lifecycle object handed to core through `bindIngressLifecycleToReplyOptions` and the ONE durable
// commit (`commitAdoption` — the SQLite watermark write) that makes the cumulative ack truthful.
//
//   pending → adopting → adopted            core called onAdopted (the commit runs INSIDE it — core
//                                            awaits the callback before any model work)
//   pending → deferred → adopting → adopted  core queued a follow-up; the original dispatch promise
//                                            resolves at deferral and is IGNORED from then on
//   pending → adopted (adopted-equivalent)   the dispatch promise resolved with no callback at all:
//                                            classified by `dispatched`/own-abort/output evidence
//   pending|deferred → abandoned             onAbandoned, own abort, dispatch rejection, watchdog
//   closed                                   the account halted/shut down: a late onAdopted THROWS
//                                            (the drain's guillotine) so core cannot run a turn we
//                                            can no longer ack.
import { hasVisibleInboundReplyDispatch } from "openclaw/plugin-sdk/channel-inbound";

/** Structural view of core's ChannelTurnResult (`channels/turn/types.ts:460-476`; not exported by name). */
export type TurnResultLike = { dispatched: boolean; dispatchResult?: unknown };
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_INGRESS_ADOPTION_STALL_MS } from "openclaw/plugin-sdk/channel-outbound";

export type AdoptionState = "pending" | "deferred" | "adopting" | "adopted" | "abandoned" | "closed";

export type AdoptionOutcome =
  | { kind: "adopted" }
  | { kind: "adopted-equivalent"; reason: "declined" | "processed" | "callback_free_completion" };

export class AdoptionFailedError extends Error {
  constructor(
    readonly reason: "abandoned" | "aborted" | "dispatch_rejected" | "watchdog" | "commit_failed" | "closed",
    readonly cause?: unknown,
  ) {
    super(`adoption failed: ${reason}`);
    this.name = "AdoptionFailedError";
  }
}

export type AdoptionTrackerParams = {
  seq: number;
  /** The synchronous durable commit (SQLite watermark). Throws on failure. */
  commit: () => void;
  stallMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class AdoptionTracker {
  readonly seq: number;
  readonly lifecycle: ChannelIngressMonitorLifecycle;
  readonly settled: Promise<AdoptionOutcome>;
  #state: AdoptionState = "pending";
  #resolve!: (o: AdoptionOutcome) => void;
  #reject!: (e: AdoptionFailedError) => void;
  #commitPromise: Promise<void> | undefined;
  readonly #commit: () => void;
  readonly #abort = new AbortController();
  readonly #stallMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #timer: unknown;

  constructor(params: AdoptionTrackerParams) {
    this.seq = params.seq;
    this.#commit = params.commit;
    this.#stallMs = params.stallMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS;
    this.#setTimer = params.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = params.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.settled = new Promise<AdoptionOutcome>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.settled.catch(() => {});
    this.#armWatchdog();
    this.lifecycle = {
      admission: "exclusive",
      abortSignal: this.#abort.signal,
      onAdopted: () => this.commitAdoption(),
      onDeferred: () => {
        if (this.#state === "pending") this.#state = "deferred";
        this.#armWatchdog();
      },
      onDeferredHeartbeat: () => this.#armWatchdog(),
      onAdoptionFinalizing: () => {},
      onAbandoned: () => this.#fail("abandoned"),
      onFailed: (error) => this.#fail("dispatch_rejected", error),
      onCancelled: () => this.#fail("aborted"),
    };
  }

  get state(): AdoptionState {
    return this.#state;
  }

  /** Our per-message abort (shutdown before adoption). Never fired for adopted turns. */
  abort(): void {
    if (this.#state === "adopted" || this.#state === "adopting") return;
    this.#abort.abort();
    this.#fail("aborted");
  }

  /** Generation close (halt/shutdown): a late `onAdopted` throws instead of committing. */
  close(): void {
    if (this.#state === "adopted") return;
    this.#clear();
    if (this.#state !== "abandoned") {
      this.#state = "closed";
      this.#reject(new AdoptionFailedError("closed"));
    }
  }

  /**
   * THE commit — memoized, once. Called by core through `onAdopted` (awaited before model work) and
   * by every adopted-equivalent branch. Throws when the tracker is closed.
   */
  commitAdoption(outcome: AdoptionOutcome = { kind: "adopted" }): Promise<void> {
    if (this.#commitPromise) return this.#commitPromise;
    if (this.#state === "closed" || this.#state === "abandoned") {
      const err = new AdoptionFailedError(this.#state === "closed" ? "closed" : "abandoned");
      this.#commitPromise = Promise.reject(err);
      this.#commitPromise.catch(() => {});
      return this.#commitPromise;
    }
    this.#state = "adopting";
    this.#clear();
    try {
      this.#commit();
      this.#state = "adopted";
      this.#resolve(outcome);
      this.#commitPromise = Promise.resolve();
    } catch (cause) {
      const err = new AdoptionFailedError("commit_failed", cause);
      this.#state = "abandoned";
      this.#reject(err);
      this.#commitPromise = Promise.reject(err);
      this.#commitPromise.catch(() => {});
    }
    return this.#commitPromise;
  }

  /**
   * The dispatch promise settled. After a deferral this is IGNORED (adoption arrives later through
   * `onAdopted`). Otherwise a rejection is a pre-adoption failure and a resolution without any
   * callback is classified (§2 R2b): declined by core → adopted-equivalent; our own abort → fail;
   * visible output → processed; zero output → callback_free_completion (at-most-once, R10).
   */
  onDispatchSettled(result: TurnResultLike | undefined, error?: unknown): void {
    if (this.#state !== "pending") return;
    if (error !== undefined) {
      this.#fail("dispatch_rejected", error);
      return;
    }
    if (this.#abort.signal.aborted) {
      this.#fail("aborted");
      return;
    }
    if (!result || result.dispatched === false) {
      void this.commitAdoption({ kind: "adopted-equivalent", reason: "declined" });
      return;
    }
    const dispatchResult = result.dispatchResult as {
      deliberateSilentTerminalReply?: true;
      noVisibleReplyFallbackDelivered?: boolean;
      deferredToActiveRun?: string;
    };
    if (dispatchResult.deferredToActiveRun) {
      // Deferred without the callback having fired yet: wait for onAdopted / onAbandoned / watchdog.
      this.#state = "deferred";
      this.#armWatchdog();
      return;
    }
    const processed =
      hasVisibleInboundReplyDispatch(result.dispatchResult as Parameters<typeof hasVisibleInboundReplyDispatch>[0]) ||
      dispatchResult.deliberateSilentTerminalReply === true ||
      dispatchResult.noVisibleReplyFallbackDelivered === true;
    void this.commitAdoption({ kind: "adopted-equivalent", reason: processed ? "processed" : "callback_free_completion" });
  }

  #fail(reason: AdoptionFailedError["reason"], cause?: unknown): void {
    if (this.#state === "adopted" || this.#state === "adopting" || this.#state === "closed" || this.#state === "abandoned") return;
    this.#state = "abandoned";
    this.#clear();
    this.#reject(new AdoptionFailedError(reason, cause));
  }

  #armWatchdog(): void {
    this.#clear();
    this.#timer = this.#setTimer(() => this.#fail("watchdog"), this.#stallMs);
    (this.#timer as { unref?: () => void })?.unref?.();
  }

  #clear(): void {
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }
}
