// Who said what in a group call (#874 G2, plan Q5 (b)): the daemon's speaking frames arrive in order
// with the mixed PCM, so each speaker's turn is cut from the mix, from a short pre-roll before their
// start to their stop (the helper's 300 ms hangover is inside it). Overlapping turns each get the
// same mixed audio: the frames say who spoke, not which voice is which inside the mix.

export type Segment = {
  userId: string;
  /** PCM16LE mono at the transport's rate: the pre-roll, then the turn. */
  pcm: Buffer;
};

export type SpeechSegmenterParams = {
  rate: number;
  /** Audio kept from before a start, so a clipped first syllable is still in the segment. */
  preRollMs: number;
  /** A longer turn is cut here and goes on as a new segment. */
  maxMs: number;
  onSegment: (segment: Segment) => void;
};

export class SpeechSegmenter {
  readonly #p: SpeechSegmenterParams;
  readonly #preRollBytes: number;
  readonly #maxBytes: number;
  #ring: Buffer[] = [];
  #ringBytes = 0;
  readonly #open = new Map<string, { parts: Buffer[]; bytes: number }>();

  constructor(params: SpeechSegmenterParams) {
    this.#p = params;
    this.#preRollBytes = Math.round((params.rate * params.preRollMs) / 1000) * 2;
    this.#maxBytes = Math.round((params.rate * params.maxMs) / 1000) * 2;
  }

  /** A speaker started or stopped (the frame applies from the next PCM). */
  speaking(userId: string, active: boolean): void {
    if (active) {
      if (this.#open.has(userId)) return;
      const pre = this.#preRoll();
      this.#open.set(userId, { parts: pre.length > 0 ? [pre] : [], bytes: pre.length });
      return;
    }
    this.#close(userId);
  }

  /** Mixed input audio, in order with the speaking frames. */
  pcm(chunk: Buffer): void {
    for (const [userId, seg] of this.#open) {
      let rest = chunk;
      while (rest.length > 0) {
        const room = this.#maxBytes - seg.bytes;
        const take = rest.subarray(0, Math.min(room, rest.length));
        seg.parts.push(take);
        seg.bytes += take.length;
        rest = rest.subarray(take.length);
        if (seg.bytes >= this.#maxBytes) {
          this.#p.onSegment({ userId, pcm: Buffer.concat(seg.parts) });
          seg.parts = [];
          seg.bytes = 0;
        }
      }
    }
    this.#ring.push(chunk);
    this.#ringBytes += chunk.length;
    while (this.#ring.length > 1 && this.#ringBytes - this.#ring[0]!.length >= this.#preRollBytes) {
      this.#ringBytes -= this.#ring.shift()!.length;
    }
  }

  /** The call ended or the audio was lost: every open turn ends here. */
  flush(): void {
    for (const userId of [...this.#open.keys()]) this.#close(userId);
  }

  #close(userId: string): void {
    const seg = this.#open.get(userId);
    if (!seg) return;
    this.#open.delete(userId);
    if (seg.bytes > 0) this.#p.onSegment({ userId, pcm: Buffer.concat(seg.parts) });
  }

  #preRoll(): Buffer {
    const all = Buffer.concat(this.#ring);
    return all.length > this.#preRollBytes ? Buffer.from(all.subarray(all.length - this.#preRollBytes)) : all;
  }
}
