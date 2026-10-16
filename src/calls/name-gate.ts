// When the agent is addressed in a group call (#874, plan Q3): OpenClaw's own activation-name
// matcher (fuzzy, the name as the first or last word) plus a vocative rule — a leading name must be
// followed by `,` `?` `!` or `:` — so "Callie was helpful" (a mention) does not open it. Only a
// person opens it: another agent's speech is context, never a trigger. Saying the name alone arms
// that speaker's next turn for a short while (OpenClaw's Discord voice does the same).
import { matchRealtimeVoiceActivationName } from "openclaw/plugin-sdk/realtime-voice-activation";

/** How long the name said alone keeps that speaker's next turn armed. */
export const FOLLOW_UP_MS = 8_000;

export type GateInput = { userId: string; kind: string; text: string };
export type GateDecision = { pass: boolean; armed?: boolean };

export class NameGate {
  readonly #names: string[];
  readonly #now: () => number;
  #armed: { userId: string; until: number } | undefined;

  constructor(names: string[], opts: { now?: () => number } = {}) {
    this.#names = names.filter((n) => n.trim().length > 0);
    this.#now = opts.now ?? (() => Date.now());
  }

  decide(input: GateInput): GateDecision {
    if (input.kind === "agent") return { pass: false };
    const text = input.text.trim();
    const match = text ? matchRealtimeVoiceActivationName(text, this.#names) : undefined;
    if (match && isVocative(text, match)) {
      if (!match.text.trim()) {
        this.#armed = { userId: input.userId, until: this.#now() + FOLLOW_UP_MS };
        return { pass: false, armed: true };
      }
      this.#armed = undefined;
      return { pass: true };
    }
    const armed = this.#armed;
    if (armed && armed.userId === input.userId && this.#now() <= armed.until && text) {
      this.#armed = undefined;
      return { pass: true };
    }
    return { pass: false };
  }
}

type Match = NonNullable<ReturnType<typeof matchRealtimeVoiceActivationName>>;

function isVocative(text: string, match: Match): boolean {
  if (match.edge === "trailing") return true;
  const at = text.toLowerCase().indexOf(match.heardName.toLowerCase());
  const after = at >= 0 ? text.slice(at + match.heardName.length) : "";
  return after.trim() === "" || /^\s*[,?!:]/.test(after);
}
