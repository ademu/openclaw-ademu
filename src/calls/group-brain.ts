// The plugin's half of a group call (#874, AdemuMLS `adc/plans/2026-10-16-agent-group-calls.md` B1/B2,
// economical mode). The transport's tap feeds it the daemon's speaking frames and the mixed audio in
// wire order; it cuts each member's turn, transcribes it with the call's names, keeps the labelled
// call log, and asks the voice engine for a reply only when a person addresses the agent by name.
// Room presence and speaker attribution are server-asserted: they decide who the agent answers and
// who may interrupt it, never what it may do (tools stay read-only in every group call).
import { CallLog, type Speaker } from "./call-log.js";
import { NameGate } from "./name-gate.js";
import type { CallParticipant } from "./protocol.js";
import { SpeechSegmenter } from "./segments.js";

/** A turn longer than this is cut (and goes on as a new turn). */
export const MAX_TURN_MS = 30_000;
/** Audio kept from before a speaker's start, so a clipped first syllable still reaches the transcriber. */
export const PRE_ROLL_MS = 300;

export type GroupCallBrainParams = {
  agentName: string;
  /** The names that address the agent (OpenClaw's activation names). */
  wakeNames: string[];
  ownerUserId: string;
  rate: number;
  preRollMs?: number | undefined;
  /** One turn's audio to text, with the call's names as the vocabulary. Throws on failure. */
  transcribe: (pcm: Buffer, names: string[]) => Promise<string>;
  /** Ask the voice engine to reply, with this message as the user turn. */
  ask: (text: string) => void;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
  now?: (() => number) | undefined;
};

export class GroupCallBrain {
  readonly #p: GroupCallBrainParams;
  readonly #segmenter: SpeechSegmenter;
  readonly #gate: NameGate;
  readonly #log: CallLog;
  readonly #roster = new Map<string, CallParticipant>();
  readonly #speaking = new Set<string>();
  #addressed: string | undefined;
  #tail: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(params: GroupCallBrainParams) {
    this.#p = params;
    this.#gate = new NameGate(params.wakeNames, params.now ? { now: params.now } : {});
    this.#log = new CallLog({ agentName: params.agentName });
    this.#segmenter = new SpeechSegmenter({
      rate: params.rate,
      preRollMs: params.preRollMs ?? PRE_ROLL_MS,
      maxMs: MAX_TURN_MS,
      onSegment: (seg) => this.#onSegment(seg.userId, seg.pcm),
    });
  }

  /** The room roster from `call_changed` (members only, as the daemon resolved it). */
  setRoster(participants: CallParticipant[]): void {
    this.#roster.clear();
    for (const p of participants) this.#roster.set(p.user_id, p);
  }

  onSpeaking(userId: string, active: boolean): void {
    if (active) this.#speaking.add(userId);
    else this.#speaking.delete(userId);
    this.#segmenter.speaking(userId, active);
  }

  onPcm(pcm: Buffer): void {
    this.#segmenter.pcm(pcm);
  }

  /** Barge-in only from the person the agent is answering, while they speak. */
  bargeInGate(): boolean {
    return this.#addressed !== undefined && this.#speaking.has(this.#addressed);
  }

  /** The agent's own reply (its output transcript). */
  onAgentSaid(text: string): void {
    this.#log.said(text);
  }

  /** Every turn handed out so far has been transcribed and decided. */
  settled(): Promise<void> {
    return this.#tail;
  }

  stop(): void {
    this.#stopped = true;
    this.#segmenter.flush();
  }

  #names(): string[] {
    const names = [this.#p.agentName];
    for (const p of this.#roster.values()) if (p.username && !names.includes(p.username)) names.push(p.username);
    return names;
  }

  #speaker(p: CallParticipant): Speaker {
    return { name: p.username || "someone", kind: p.kind, owner: p.user_id === this.#p.ownerUserId };
  }

  #onSegment(userId: string, pcm: Buffer): void {
    const who = this.#roster.get(userId);
    // A speaker the roster does not name is ignored (the daemon's roster is members only).
    if (!who || this.#stopped) return;
    // Transcribed in parallel, applied in turn order, so the log and the gate see the call in order.
    const text = this.#p.transcribe(pcm, this.#names()).catch((err: unknown) => {
      this.#p.log("call_turn_transcribe_failed", { errorClass: err instanceof Error ? err.name : typeof err });
      return undefined;
    });
    this.#tail = this.#tail.then(async () => {
      const heard = await text;
      if (heard === undefined || this.#stopped) return;
      const speaker = this.#speaker(who);
      this.#log.heard(speaker, heard);
      const decision = this.#gate.decide({ userId, kind: who.kind, text: heard });
      this.#p.log("call_turn", { kind: who.kind || "unknown", chars: heard.length, addressed: decision.pass });
      if (!decision.pass) return;
      this.#addressed = userId;
      this.#p.ask(this.#log.request(speaker));
    });
  }
}
