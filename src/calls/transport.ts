// The audio connection (AdemuMLS #874, PROTOCOL.md §Calls "The audio connection") as OpenClaw's
// `MeetingRealtimeAudioTransport`. A SECOND connection to the session socket (the `get_blob`
// pattern): one ticket line, then nothing until the helper's `{"ok":true,"rate":R}` line, then the
// binary frames of `frames.ts` both ways.
//
//   - output: `writeOutput` writes `pcm` frames, then a `mark`, and resolves once the socket took
//     the bytes — NOT at playout: OpenClaw's realtime engine keeps one write in flight and treats
//     more than 2 s of unresolved audio as backpressure (it clears and cancels the response), and its
//     own local transport resolves on acceptance too. The helper buffers up to 60 s. The echoed mark
//     is the playout signal: while a mark is out, the agent is audibly speaking (barge-in gate, stats).
//   - it never rejects: OpenClaw's realtime engine stops itself on the first rejected write, and the
//     agent engine can hand over a clip after it stopped. Loss is reported through `onFatal` only.
//   - input: every inbound `pcm` frame (10 ms, the remote side mixed) goes to the engine.
//   - recovery: a connection that drops while the call goes on (a broken frame, a daemon reattach)
//     is replaced with a fresh ticket through `reopen`, a few attempts within ~10 s; audio written
//     meanwhile is dropped. Only a failed recovery is fatal.
//   - barge-in: a held-RMS speech detector on the input while output plays. An engine that
//     registered `startBargeInMonitor` (the realtime engine) decides and clears itself; otherwise
//     (the agent engine never clears output) the transport clears and calls `bargeIn.onBargeIn`.
//
// Never logs PCM or a ticket; ids and counters only.
import type { MeetingRealtimeAudioTransport } from "openclaw/plugin-sdk/meeting-runtime";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { AudioFrameDecoder, AudioFrameError, encodeClearOutput, encodeMark, encodePcm } from "./frames.js";

/** The longest ok line the helper may send; anything longer is not the helper. */
export const MAX_HANDSHAKE_LINE = 1024;
export const HANDSHAKE_TIMEOUT_MS = 5_000;

export class AudioConnectError extends Error {
  constructor(readonly reason: "refused" | "timeout" | "malformed" | "rate_mismatch" | "connect" | "aborted") {
    super(`audio connection failed: ${reason}`);
    this.name = "AudioConnectError";
  }
}

/** A redeemed audio connection: the socket (paused), the helper's rate, and bytes read past the ok line. */
export type AudioSocket = { socket: Duplex; rate: number; leftover: Buffer };

/**
 * Connects to `path`, redeems `ticket`, and waits for the helper's ok line. Writes nothing after the
 * ticket line until that reply (the daemon closes a connection with bytes behind the ticket). A
 * refusal is a silent close; it consumed the ticket either way.
 */
export function openAudioSocket(params: {
  path: string;
  ticket: string;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  connectFn?: ((path: string) => Duplex) | undefined;
}): Promise<AudioSocket> {
  return new Promise<AudioSocket>((resolve, reject) => {
    if (params.signal?.aborted) return reject(new AudioConnectError("aborted"));
    const socket = (params.connectFn ?? ((p: string) => createConnection(p)))(params.path);
    let buf = Buffer.alloc(0);
    let done = false;
    let connected = false;
    const finish = (err: AudioConnectError | undefined, result?: AudioSocket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("end", onClose);
      socket.off("error", onError);
      socket.off("connect", onConnect);
      params.signal?.removeEventListener("abort", onAbort);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        // Paused until the transport attaches its own listeners: no frame is lost in between.
        socket.pause();
        // A late socket error must not become an unhandled 'error' event before the transport attaches.
        socket.on("error", () => {});
        resolve(result!);
      }
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_HANDSHAKE_LINE) finish(new AudioConnectError("malformed"));
        return;
      }
      if (nl > MAX_HANDSHAKE_LINE) return finish(new AudioConnectError("malformed"));
      let reply: unknown;
      try {
        reply = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      } catch {
        return finish(new AudioConnectError("malformed"));
      }
      const r = reply as { ok?: unknown; rate?: unknown } | null;
      if (!r || r.ok !== true || typeof r.rate !== "number" || !Number.isInteger(r.rate) || r.rate <= 0) {
        return finish(new AudioConnectError("malformed"));
      }
      finish(undefined, { socket, rate: r.rate, leftover: Buffer.from(buf.subarray(nl + 1)) });
    };
    const onClose = () => finish(new AudioConnectError(connected ? "refused" : "connect"));
    const onError = () => finish(new AudioConnectError(connected ? "refused" : "connect"));
    const onConnect = () => {
      connected = true;
    };
    const onAbort = () => finish(new AudioConnectError("aborted"));
    const timer = setTimeout(() => finish(new AudioConnectError("timeout")), params.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("end", onClose);
    socket.on("error", onError);
    socket.on("connect", onConnect);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    // Written once; queued by the socket until it connects.
    socket.write(`${JSON.stringify({ v: 1, audio_ticket: params.ticket })}\n`);
  });
}

/** The call is over (or no longer this device's): recovery stops at once. */
export class CallGoneError extends Error {
  constructor() {
    super("the call is no longer active on this device");
    this.name = "CallGoneError";
  }
}

export type BargeInOptions = {
  /** Normalised RMS (0–1) of a 10 ms frame that counts as speech. */
  rmsThreshold: number;
  /** How long speech must hold, while output plays, before it counts as barge-in. */
  holdMs: number;
  /** After a barge-in, how long the detector rests (the engine's own handling has no cooldown). */
  cooldownMs?: number | undefined;
  /** Called after the transport cleared output itself (no engine monitor registered). */
  onBargeIn?: (() => void) | undefined;
};

export const DEFAULT_BARGE_IN_COOLDOWN_MS = 900;

export type ReconnectPolicy = { attempts: number; windowMs: number; delayMs: number };
export const DEFAULT_RECONNECT: ReconnectPolicy = { attempts: 4, windowMs: 10_000, delayMs: 500 };

/**
 * Inbound 10 ms frames handed to the engine together (20 ms, 960 bytes at 24 kHz): the agent engine
 * resamples each chunk on its own for speech-to-text, so fewer chunk edges are cleaner. A multiple of
 * 3 samples keeps its 24 → 8 kHz step exact.
 */
export const INPUT_CHUNK_FRAMES = 2;

/** How long past its expected playout an unechoed mark still counts as "output playing". */
export const MARK_SLACK_MS = 5_000;

export type CallTransportStats = {
  framesIn: number;
  bytesOut: number;
  droppedOutputBytes: number;
  marksPending: number;
  clears: number;
  bargeIns: number;
  reconnects: number;
  markTimeouts: number;
  /** Write → echo of the latest echoed mark (≈ queue + playout time of that write). */
  lastMarkLatencyMs?: number;
};

export type CallTransportParams = {
  /** The redeemed first connection; undefined = it failed (the ticket is spent): recover at once. */
  first: AudioSocket | undefined;
  /** The rate the seat asked for; a connection at another rate is refused. */
  rate: number;
  /** A fresh, redeemed connection for the same call; throws {@link CallGoneError} when the call is over. */
  reopen: (signal: AbortSignal) => Promise<AudioSocket>;
  reconnect?: ReconnectPolicy | undefined;
  /** The speech detector; omitted = no barge-in from this side. */
  bargeIn?: BargeInOptions | undefined;
  /** Recovery failed: the transport is fatal (the controller ends the call). */
  onLost?: (() => void) | undefined;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
};

type PendingMark = { timer: ReturnType<typeof setTimeout>; sentAt: number };

function rmsOf(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The audio connection of one call. It outlives the engines that use it: each engine gets a
 * {@link CallAudioTransport.view}, whose stop/dispose detach that engine only (an engine stops its
 * transport when it stops, and the agent engine is restarted on barge-in). `stop()` here closes the
 * connection; ending the call is the controller's job.
 */
export class CallAudioTransport {
  readonly #params: CallTransportParams;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #abort = new AbortController();
  readonly #pending = new Map<string, PendingMark>();
  readonly #fatalHandlers: Array<() => void> = [];
  readonly #writeWaiters = new Set<() => void>();
  #state: "open" | "reconnecting" | "fatal" | "stopped" = "open";
  #socket: Duplex | undefined;
  #onAudio: ((audio: Buffer) => void) | undefined;
  #engineBargeIn: ((audio: Buffer) => boolean) | undefined;
  #markSeq = 0;
  /** When the audio written so far is expected to finish playing (for the mark deadline). */
  #playoutEnd = 0;
  #loudMs = 0;
  #restUntil = 0;
  #inChunk: Buffer[] = [];
  /** The last output event: a write, an echoed mark, a clear (for "has the agent finished speaking"). */
  #lastOutputAt = 0;
  #lastWriteAt = 0;
  readonly #stats: CallTransportStats = { framesIn: 0, bytesOut: 0, droppedOutputBytes: 0, marksPending: 0, clears: 0, bargeIns: 0, reconnects: 0, markTimeouts: 0 };

  constructor(params: CallTransportParams) {
    this.#params = params;
    this.#now = params.now ?? (() => Date.now());
    this.#sleep = params.sleep ?? defaultSleep;
    if (!params.first || !this.#attach(params.first)) {
      // The first connection is already unusable: recover as from any drop.
      void this.#recover();
    }
  }

  get state(): "open" | "reconnecting" | "fatal" | "stopped" {
    return this.#state;
  }

  /** When audio was last written (0 = never). */
  get lastWriteAt(): number {
    return this.#lastWriteAt;
  }

  /** How long nothing has been playing: 0 while written audio is still out (an unechoed mark). */
  idleMs(): number {
    if (this.#pending.size > 0) return 0;
    return Math.max(0, this.#now() - this.#lastOutputAt);
  }

  stats(): CallTransportStats {
    return { ...this.#stats, marksPending: this.#pending.size };
  }

  /**
   * A transport for one engine: everything delegates here; its stop/dispose detach only that engine.
   * `onDetached` runs once, when the engine stops its transport (by itself, or because it was told to).
   */
  view(onDetached?: () => void): MeetingRealtimeAudioTransport {
    let detached = false;
    let input: ((audio: Buffer) => void) | undefined;
    let monitor: ((audio: Buffer) => boolean) | undefined;
    const fatalHandlers: Array<() => void> = [];
    const detach = async () => {
      if (detached) return;
      detached = true;
      if (input && this.#onAudio === input) this.#onAudio = undefined;
      if (monitor && this.#engineBargeIn === monitor) this.#engineBargeIn = undefined;
      // A detached engine's fatal hooks go with it (a long call restarts engines many times).
      for (const h of fatalHandlers) {
        const i = this.#fatalHandlers.indexOf(h);
        if (i >= 0) this.#fatalHandlers.splice(i, 1);
      }
      try {
        onDetached?.();
      } catch {
        // The controller's hook must not fail an engine's stop.
      }
    };
    return {
      onFatal: (handler) => {
        const h = () => {
          if (!detached) handler();
        };
        if (this.#state !== "fatal") fatalHandlers.push(h);
        this.onFatal(h);
      },
      startInput: (onAudio) => {
        if (detached) return;
        input = onAudio;
        this.startInput(onAudio);
      },
      beginOutput: () => {},
      startBargeInMonitor: (onBargeIn) => {
        if (detached) return;
        monitor = onBargeIn;
        this.startBargeInMonitor(onBargeIn);
      },
      // A detached engine's late clip (the agent engine can finish a TTS job after it stopped) is dropped.
      writeOutput: (audio) => (detached ? Promise.resolve() : this.writeOutput(audio)),
      clearOutput: () => (detached ? Promise.resolve() : this.clearOutput()),
      stop: detach,
      dispose: detach,
    };
  }

  // --- the transport surface (through views) -----------------------------------------------------

  onFatal(handler: () => void): void {
    if (this.#state === "fatal") handler();
    else this.#fatalHandlers.push(handler);
  }

  startInput(onAudio: (audio: Buffer) => void): void {
    this.#onAudio = onAudio;
  }

  beginOutput(): void {}

  startBargeInMonitor(onBargeIn: (audio: Buffer) => boolean): void {
    this.#engineBargeIn = onBargeIn;
  }

  writeOutput(audio: Buffer): Promise<void> {
    if (this.#state !== "open" || !this.#socket) {
      if (this.#state === "reconnecting") this.#stats.droppedOutputBytes += audio.length;
      return Promise.resolve();
    }
    const frames = encodePcm(audio);
    if (frames.length === 0) return Promise.resolve();
    const socket = this.#socket;
    for (const f of frames) socket.write(f);
    const id = `m${++this.#markSeq}`;
    this.#stats.bytesOut += audio.length;

    const now = this.#now();
    this.#lastOutputAt = now;
    this.#lastWriteAt = now;
    const durationMs = ((audio.length >> 1) / this.#params.rate) * 1000;
    this.#playoutEnd = Math.max(now, this.#playoutEnd) + durationMs;
    // The helper always echoes; a mark that never comes back must not keep "playing" forever.
    const timer = setTimeout(() => {
      if (this.#pending.delete(id)) this.#stats.markTimeouts++;
    }, this.#playoutEnd - now + MARK_SLACK_MS);
    this.#pending.set(id, { timer, sentAt: now });
    return new Promise<void>((resolve) => {
      // Resolves when the socket took the bytes, or when the connection is dropped (recovery's business).
      const done = () => {
        if (this.#writeWaiters.delete(done)) resolve();
      };
      this.#writeWaiters.add(done);
      socket.write(encodeMark(Buffer.from(id, "latin1")), done);
    });
  }

  clearOutput(): Promise<void> {
    if (this.#state === "open" && this.#socket) {
      this.#socket.write(encodeClearOutput());
      this.#stats.clears++;
    }
    this.#playoutEnd = this.#now();
    this.#lastOutputAt = this.#playoutEnd;
    this.#loudMs = 0;
    // The helper echoes every pending mark at once on a clear.
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#abort.abort();
    this.#onAudio = undefined;
    this.#engineBargeIn = undefined;
    this.#forgetPending();
    this.#dropSocket();
  }

  dispose(): Promise<void> {
    return this.stop();
  }

  // --- controller hooks ---------------------------------------------------------------------------

  /**
   * Replace the connection with a fresh one now (the seat reattached: the helper switches to the new
   * connection). No-op while a recovery is already running, or once stopped/fatal.
   */
  replace(): void {
    if (this.#state !== "open") return;
    this.#dropSocket();
    void this.#recover();
  }

  // --- internals ----------------------------------------------------------------------------------

  /** Takes over a redeemed connection; false = unusable (wrong rate, or a broken leftover frame). */
  #attach(conn: AudioSocket): boolean {
    if (conn.rate !== this.#params.rate) {
      this.#params.log("call_audio_rate_mismatch", { rate: conn.rate });
      conn.socket.destroy();
      return false;
    }
    const socket = conn.socket;
    const decoder = new AudioFrameDecoder();
    this.#socket = socket;
    const onData = (chunk: Buffer) => {
      if (this.#socket !== socket) return;
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.#params.log("call_audio_frame_refused", { reason: err instanceof AudioFrameError ? err.reason : "decode" });
        this.#lost(socket);
        return;
      }
      for (const f of frames) {
        if (this.#socket !== socket) return;
        if (f.kind === "pcm") this.#input(f.pcm);
        else if (f.kind === "mark") this.#markEchoed(f.id.toString("latin1"));
        // A clear_output from the helper is not in the protocol; ignored.
      }
    };
    const onEnd = () => this.#lost(socket);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onEnd);
    socket.on("error", onEnd);
    if (conn.leftover.length > 0) onData(conn.leftover);
    if (this.#socket !== socket) return true; // the leftover already broke it; recovery is running
    socket.resume();
    return true;
  }

  #input(pcm: Buffer): void {
    this.#stats.framesIn++;
    const detector = this.#params.bargeIn;
    if (detector && this.#pending.size > 0 && this.#now() >= this.#restUntil) {
      const frameMs = ((pcm.length >> 1) / this.#params.rate) * 1000;
      this.#loudMs = rmsOf(pcm) >= detector.rmsThreshold ? this.#loudMs + frameMs : 0;
      if (this.#loudMs >= detector.holdMs) {
        this.#loudMs = 0;
        this.#bargeIn(pcm, detector);
      }
    } else {
      this.#loudMs = 0;
    }
    this.#inChunk.push(pcm);
    if (this.#inChunk.length >= INPUT_CHUNK_FRAMES) {
      const chunk = Buffer.concat(this.#inChunk);
      this.#inChunk = [];
      try {
        this.#onAudio?.(chunk);
      } catch (err) {
        // Thrown inside a socket 'data' handler it would take the gateway down; the frame is dropped.
        this.#params.log("call_audio_input_failed", { errorClass: err instanceof Error ? err.name : typeof err });
      }
    }
  }

  #bargeIn(pcm: Buffer, detector: BargeInOptions): void {
    this.#restUntil = this.#now() + (detector.cooldownMs ?? DEFAULT_BARGE_IN_COOLDOWN_MS);
    try {
      if (this.#engineBargeIn) {
        // The engine decides (it cancels its response and clears output through clearOutput()).
        if (this.#engineBargeIn(pcm)) this.#stats.bargeIns++;
        return;
      }
      this.#stats.bargeIns++;
      void this.clearOutput();
      detector.onBargeIn?.();
    } catch {
      // An engine's hook must not break the input path.
    }
  }

  #markEchoed(id: string): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    this.#lastOutputAt = this.#now();
    this.#stats.lastMarkLatencyMs = Math.max(0, this.#now() - p.sentAt);
    if (this.#pending.size === 0) this.#loudMs = 0;
  }

  /** The written audio is gone with the connection (or the transport stopped): nothing is playing. */
  #forgetPending(): void {
    for (const [, p] of this.#pending) clearTimeout(p.timer);
    this.#pending.clear();
    this.#playoutEnd = this.#now();
  }

  #dropSocket(): void {
    const s = this.#socket;
    this.#socket = undefined;
    this.#inChunk = [];
    s?.destroy();
    for (const done of [...this.#writeWaiters]) done();
  }

  /** The current connection ended under us. */
  #lost(socket: Duplex): void {
    if (this.#socket !== socket || this.#state !== "open") return;
    this.#dropSocket();
    void this.#recover();
  }

  async #recover(): Promise<void> {
    if (this.#state !== "open") return;
    this.#state = "reconnecting";
    this.#stats.reconnects++;
    this.#forgetPending();
    const policy = this.#params.reconnect ?? DEFAULT_RECONNECT;
    const giveUpAt = this.#now() + policy.windowMs;
    const signal = this.#abort.signal;
    for (let attempt = 1; attempt <= policy.attempts; attempt++) {
      if (attempt > 1) await this.#sleep(policy.delayMs, signal);
      if (signal.aborted || this.#state !== "reconnecting") return;
      if (this.#now() >= giveUpAt) break;
      this.#params.log("call_audio_reconnecting", { attempt });
      let conn: AudioSocket;
      try {
        conn = await this.#params.reopen(signal);
      } catch (err) {
        if (signal.aborted || this.#state !== "reconnecting") return;
        const gone = err instanceof CallGoneError;
        this.#params.log("call_audio_reconnect_failed", { attempt, errorClass: err instanceof Error ? err.name : typeof err, gone });
        if (gone) break;
        continue;
      }
      if (signal.aborted || this.#state !== "reconnecting") {
        conn.socket.destroy();
        return;
      }
      this.#state = "open";
      if (this.#attach(conn)) {
        this.#params.log("call_audio_reconnected", { attempt });
        return;
      }
      this.#state = "reconnecting";
    }
    if (this.#state !== "reconnecting") return;
    this.#state = "fatal";
    this.#params.log("call_audio_lost", {});
    for (const h of this.#fatalHandlers.splice(0)) {
      try {
        h();
      } catch {
        // An engine's fatal hook must not stop the others.
      }
    }
    this.#params.onLost?.();
  }
}
