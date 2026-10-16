// The audio connection's binary framing (AdemuMLS #874, `adc/call/src/audio.rs`): after the helper's
// ok line, both directions are `u8 kind | u32 little-endian length | payload`, payload ≤ 64 KiB.
//   kind 1 `pcm`          both ways      PCM16LE mono at the seat's rate; even length
//   kind 2 `clear_output` mind → helper  empty (barge-in)
//   kind 3 `mark`         both ways      opaque id ≤ 256 bytes; the helper echoes it at playout
// A frame that breaks these rules closes the connection on the helper's side; the decoder below
// applies the same rules to what the helper sends, so a broken stream is never half-read.

export const KIND_PCM = 1;
export const KIND_CLEAR_OUTPUT = 2;
export const KIND_MARK = 3;

export const HEADER_BYTES = 5;
export const MAX_PAYLOAD = 65_536;
export const MAX_MARK = 256;

export type AudioFrame = { kind: "pcm"; pcm: Buffer } | { kind: "clear_output" } | { kind: "mark"; id: Buffer };

export class AudioFrameError extends Error {
  constructor(readonly reason: "unknown_kind" | "oversize" | "odd_pcm" | "clear_payload" | "mark_too_long") {
    super(`audio frame refused: ${reason}`);
    this.name = "AudioFrameError";
  }
}

function frame(kind: number, payload: Buffer | undefined): Buffer {
  const len = payload?.length ?? 0;
  const out = Buffer.allocUnsafe(HEADER_BYTES + len);
  out.writeUInt8(kind, 0);
  out.writeUInt32LE(len, 1);
  if (payload && len > 0) payload.copy(out, HEADER_BYTES);
  return out;
}

/** One `pcm` frame; the caller keeps it within {@link MAX_PAYLOAD} and even (see {@link encodePcm}). */
export function encodePcmFrame(pcm: Buffer): Buffer {
  if (pcm.length > MAX_PAYLOAD) throw new AudioFrameError("oversize");
  if (pcm.length % 2 !== 0) throw new AudioFrameError("odd_pcm");
  return frame(KIND_PCM, pcm);
}

/** Audio of any length as `pcm` frames of at most {@link MAX_PAYLOAD} bytes. An odd trailing byte is dropped. */
export function encodePcm(audio: Buffer): Buffer[] {
  const usable = audio.length - (audio.length % 2);
  const out: Buffer[] = [];
  for (let at = 0; at < usable; at += MAX_PAYLOAD) out.push(frame(KIND_PCM, audio.subarray(at, Math.min(at + MAX_PAYLOAD, usable))));
  return out;
}

export function encodeClearOutput(): Buffer {
  return frame(KIND_CLEAR_OUTPUT, undefined);
}

export function encodeMark(id: Buffer): Buffer {
  if (id.length > MAX_MARK) throw new AudioFrameError("mark_too_long");
  return frame(KIND_MARK, id);
}

/**
 * Incremental decoder: feed it whatever the socket delivers, get whole frames back. Throws
 * {@link AudioFrameError} on the first frame that breaks the framing (the caller drops the connection).
 */
export class AudioFrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): AudioFrame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const frames: AudioFrame[] = [];
    let at = 0;
    while (this.#buf.length - at >= HEADER_BYTES) {
      const kind = this.#buf.readUInt8(at);
      const len = this.#buf.readUInt32LE(at + 1);
      // Header checks first: a bad header is refused before its payload arrives.
      if (kind !== KIND_PCM && kind !== KIND_CLEAR_OUTPUT && kind !== KIND_MARK) throw new AudioFrameError("unknown_kind");
      if (len > MAX_PAYLOAD) throw new AudioFrameError("oversize");
      if (kind === KIND_PCM && len % 2 !== 0) throw new AudioFrameError("odd_pcm");
      if (kind === KIND_CLEAR_OUTPUT && len !== 0) throw new AudioFrameError("clear_payload");
      if (kind === KIND_MARK && len > MAX_MARK) throw new AudioFrameError("mark_too_long");
      if (this.#buf.length - at - HEADER_BYTES < len) break;
      // Copied out: the payload outlives the decoder's buffer.
      const payload = Buffer.from(this.#buf.subarray(at + HEADER_BYTES, at + HEADER_BYTES + len));
      at += HEADER_BYTES + len;
      frames.push(kind === KIND_PCM ? { kind: "pcm", pcm: payload } : kind === KIND_MARK ? { kind: "mark", id: payload } : { kind: "clear_output" });
    }
    this.#buf = at === 0 ? this.#buf : Buffer.from(this.#buf.subarray(at));
    return frames;
  }
}
