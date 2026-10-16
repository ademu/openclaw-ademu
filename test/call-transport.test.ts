// The call's audio connection (AdemuMLS #874): the frame codec against every refusal rule of the
// helper (`adc/call/src/audio.rs`), the ok-line handshake, and the transport's promises — writes
// resolve on acceptance and never reject, marks gate barge-in, a drop recovers with a fresh ticket
// below the engine, and only a failed recovery is fatal.
import { PassThrough, Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AudioFrameDecoder,
  AudioFrameError,
  encodeClearOutput,
  encodeMark,
  encodePcm,
  encodePcmFrame,
  KIND_CLEAR_OUTPUT,
  KIND_MARK,
  KIND_PCM,
  MAX_MARK,
  MAX_PAYLOAD,
} from "../src/calls/frames.js";
import { AudioConnectError, CallAudioTransport, CallGoneError, INPUT_CHUNK_FRAMES, openAudioSocket, type AudioSocket } from "../src/calls/transport.js";

const header = (kind: number, len: number) => {
  const b = Buffer.alloc(5);
  b.writeUInt8(kind, 0);
  b.writeUInt32LE(len, 1);
  return b;
};

describe("frame codec", () => {
  it("round-trips every kind, across split reads", () => {
    const pcm = Buffer.alloc(480, 7);
    const wire = Buffer.concat([encodePcmFrame(pcm), encodeMark(Buffer.from("m1")), encodeClearOutput()]);
    const dec = new AudioFrameDecoder();
    const frames = [];
    for (let i = 0; i < wire.length; i += 3) frames.push(...dec.push(wire.subarray(i, i + 3)));
    expect(frames).toEqual([{ kind: "pcm", pcm }, { kind: "mark", id: Buffer.from("m1") }, { kind: "clear_output" }]);
  });

  it("refuses what the helper refuses: unknown kind, oversize, odd pcm, a clear with payload, a long mark", () => {
    const cases: Array<[Buffer, AudioFrameError["reason"]]> = [
      [header(42, 0), "unknown_kind"],
      [header(KIND_PCM, MAX_PAYLOAD + 2), "oversize"],
      [Buffer.concat([header(KIND_PCM, 3), Buffer.from([1, 2, 3])]), "odd_pcm"],
      [Buffer.concat([header(KIND_CLEAR_OUTPUT, 1), Buffer.from([7])]), "clear_payload"],
      [header(KIND_MARK, MAX_MARK + 1), "mark_too_long"],
    ];
    for (const [wire, reason] of cases) {
      let caught: unknown;
      try {
        new AudioFrameDecoder().push(wire);
      } catch (err) {
        caught = err;
      }
      expect(caught, reason).toBeInstanceOf(AudioFrameError);
      expect((caught as AudioFrameError).reason).toBe(reason);
    }
  });

  it("refuses a bad header before its payload arrives", () => {
    expect(() => new AudioFrameDecoder().push(header(KIND_PCM, MAX_PAYLOAD + 2))).toThrow(AudioFrameError);
  });

  it("splits long audio into ≤ 64 KiB pcm frames and drops an odd trailing byte", () => {
    const frames = encodePcm(Buffer.alloc(MAX_PAYLOAD * 2 + 11));
    expect(frames.map((f) => f.readUInt32LE(1))).toEqual([MAX_PAYLOAD, MAX_PAYLOAD, 10]);
    expect(encodePcm(Buffer.alloc(1))).toEqual([]);
  });
});

/** One end of an in-memory socket pair: what the transport writes lands in `fromMind`. */
function pair() {
  const toMind = new PassThrough();
  const fromMind: Buffer[] = [];
  let closed = false;
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      fromMind.push(Buffer.from(chunk));
      cb();
    },
    destroy(err, cb) {
      closed = true;
      cb(err);
    },
  });
  toMind.on("data", (c: Buffer) => socket.push(c));
  toMind.on("end", () => socket.push(null));
  return {
    socket,
    /** Bytes the helper sends. */
    send: (b: Buffer) => toMind.write(b),
    /** The helper closes the connection. */
    end: () => toMind.end(),
    written: () => Buffer.concat(fromMind),
    frames: () => new AudioFrameDecoder().push(Buffer.concat(fromMind)),
    closed: () => closed,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("openAudioSocket", () => {
  it("writes exactly the ticket line, then waits for the ok line; bytes past it are kept", async () => {
    const p = pair();
    const opening = openAudioSocket({ path: "/s", ticket: "adca1_TICKET_TICKET_TICKET", connectFn: () => p.socket });
    await settle();
    expect(p.written().toString()).toBe('{"v":1,"audio_ticket":"adca1_TICKET_TICKET_TICKET"}\n');
    p.send(Buffer.concat([Buffer.from('{"ok":true,"rate":24000}\n'), encodeMark(Buffer.from("x"))]));
    const conn = await opening;
    expect(conn.rate).toBe(24000);
    expect(new AudioFrameDecoder().push(conn.leftover)).toEqual([{ kind: "mark", id: Buffer.from("x") }]);
  });

  it("a silent close is a refusal; a garbage line is malformed; silence times out", async () => {
    const a = pair();
    const refused = openAudioSocket({ path: "/s", ticket: "t", connectFn: () => a.socket });
    a.socket.emit("connect");
    a.end();
    await expect(refused).rejects.toMatchObject({ reason: "refused" });

    const b = pair();
    const bad = openAudioSocket({ path: "/s", ticket: "t", connectFn: () => b.socket });
    b.send(Buffer.from('{"ok":false}\n'));
    await expect(bad).rejects.toMatchObject({ reason: "malformed" });

    const c = pair();
    await expect(openAudioSocket({ path: "/s", ticket: "t", connectFn: () => c.socket, timeoutMs: 10 })).rejects.toBeInstanceOf(AudioConnectError);
    expect(c.closed()).toBe(true);
  });
});

function transportWorld(opts: { reopen?: (signal: AbortSignal) => Promise<AudioSocket>; bargeIn?: boolean } = {}) {
  const first = pair();
  const logs: string[] = [];
  let lost = 0;
  let bargeIns = 0;
  const transport = new CallAudioTransport({
    first: { socket: first.socket, rate: 24000, leftover: Buffer.alloc(0) },
    rate: 24000,
    reopen: opts.reopen ?? (async () => Promise.reject(new CallGoneError())),
    reconnect: { attempts: 3, windowMs: 10_000, delayMs: 1 },
    ...(opts.bargeIn ? { bargeIn: { rmsThreshold: 0.02, holdMs: 30, cooldownMs: 0, onBargeIn: () => bargeIns++ } } : {}),
    onLost: () => lost++,
    log: (e) => logs.push(e),
    sleep: async () => {},
  });
  return { first, transport, logs, lost: () => lost, bargeIns: () => bargeIns };
}

const loud = () => {
  const b = Buffer.alloc(480);
  for (let i = 0; i < 240; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return b;
};

describe("CallAudioTransport", () => {
  it("writeOutput sends pcm then a mark and resolves on acceptance; the echoed mark ends 'playing'", async () => {
    const w = transportWorld();
    const view = w.transport.view();
    await view.writeOutput(Buffer.alloc(960, 1));
    const frames = w.first.frames();
    expect(frames.map((f) => f.kind)).toEqual(["pcm", "mark"]);
    expect(w.transport.stats().marksPending).toBe(1);
    w.first.send(encodeMark((frames[1] as { id: Buffer }).id));
    await settle();
    expect(w.transport.stats().marksPending).toBe(0);
  });

  it("clearOutput sends kind 2 and resolves at once", async () => {
    const w = transportWorld();
    await w.transport.view().clearOutput();
    expect(w.first.frames()).toEqual([{ kind: "clear_output" }]);
  });

  it("inbound pcm reaches the engine in 20 ms chunks; echoed marks never do", async () => {
    const w = transportWorld();
    const got: Buffer[] = [];
    w.transport.view().startInput((a) => got.push(a));
    for (let i = 0; i < INPUT_CHUNK_FRAMES * 2; i++) w.first.send(encodePcmFrame(Buffer.alloc(480, i)));
    w.first.send(encodeMark(Buffer.from("zz")));
    await settle();
    expect(got.map((g) => g.length)).toEqual([960, 960]);
  });

  it("a broken inbound frame drops the connection and recovers with a fresh one; writes meanwhile resolve", async () => {
    const second = pair();
    let reopened = 0;
    const w = transportWorld({
      reopen: async () => {
        reopened++;
        return { socket: second.socket, rate: 24000, leftover: Buffer.alloc(0) };
      },
    });
    const view = w.transport.view();
    w.first.send(header(42, 0));
    await view.writeOutput(Buffer.alloc(480)); // during or after recovery: never rejects
    await settle();
    expect(reopened).toBe(1);
    expect(w.first.closed()).toBe(true);
    expect(w.transport.state).toBe("open");
    await view.writeOutput(Buffer.alloc(480));
    expect(second.frames().map((f) => f.kind)).toEqual(["pcm", "mark"]);
    expect(w.lost()).toBe(0);
  });

  it("recovery that fails is fatal: onFatal fires (late handlers at once), onLost fires, writes still resolve", async () => {
    const w = transportWorld({ reopen: async () => Promise.reject(new Error("nope")) });
    const view = w.transport.view();
    let fatal = 0;
    view.onFatal(() => fatal++);
    w.first.end();
    await settle();
    expect(w.transport.state).toBe("fatal");
    expect(fatal).toBe(1);
    expect(w.lost()).toBe(1);
    view.onFatal(() => fatal++);
    expect(fatal).toBe(2);
    await expect(view.writeOutput(Buffer.alloc(480))).resolves.toBeUndefined();
  });

  it("a call that is gone stops recovery at the first answer", async () => {
    let tries = 0;
    const w = transportWorld({
      reopen: async () => {
        tries++;
        throw new CallGoneError();
      },
    });
    w.first.end();
    await settle();
    expect(tries).toBe(1);
    expect(w.lost()).toBe(1);
  });

  it("barge-in: speech held while output plays clears it once; silence or no output never does", async () => {
    const w = transportWorld({ bargeIn: true });
    const view = w.transport.view();
    // No output in flight: loud input is just input.
    for (let i = 0; i < 5; i++) w.first.send(encodePcmFrame(loud()));
    await settle();
    expect(w.bargeIns()).toBe(0);
    await view.writeOutput(Buffer.alloc(48_000));
    // Silence frames (the helper's filler) never count.
    for (let i = 0; i < 5; i++) w.first.send(encodePcmFrame(Buffer.alloc(480)));
    await settle();
    expect(w.bargeIns()).toBe(0);
    for (let i = 0; i < 3; i++) w.first.send(encodePcmFrame(loud()));
    await settle();
    expect(w.bargeIns()).toBe(1);
    expect(w.first.frames().some((f) => f.kind === "clear_output")).toBe(true);
  });

  it("an engine's own barge-in monitor decides instead (the realtime engine)", async () => {
    const w = transportWorld({ bargeIn: true });
    const view = w.transport.view();
    const heard: number[] = [];
    view.startBargeInMonitor!((a) => {
      heard.push(a.length);
      return true;
    });
    await view.writeOutput(Buffer.alloc(48_000));
    for (let i = 0; i < 3; i++) w.first.send(encodePcmFrame(loud()));
    await settle();
    expect(heard).toEqual([480]);
    expect(w.bargeIns()).toBe(0); // the plugin's hook is for engines without a monitor
    expect(w.first.frames().some((f) => f.kind === "clear_output")).toBe(false);
  });

  it("a stopped view drops late clips and keeps the connection; stop() closes it", async () => {
    const w = transportWorld();
    const a = w.transport.view();
    await a.stop();
    await a.writeOutput(Buffer.alloc(480));
    expect(w.first.frames()).toEqual([]);
    const b = w.transport.view();
    await b.writeOutput(Buffer.alloc(480));
    expect(w.first.frames().map((f) => f.kind)).toEqual(["pcm", "mark"]);
    await w.transport.stop();
    expect(w.first.closed()).toBe(true);
    await expect(b.writeOutput(Buffer.alloc(480))).resolves.toBeUndefined();
  });
});
