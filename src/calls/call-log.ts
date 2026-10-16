// What the agent is told in a group call (#874, economical mode): every line of the call, labelled
// with who said it, and — when a person addresses it — the lines since it last spoke, ending with
// who is asking. The voice model hears the audio too; the labels are what it cannot hear.

export type Speaker = { name: string; kind: string; owner: boolean };

type Line = { speaker: Speaker | "self"; text: string };

export class CallLog {
  readonly #agentName: string;
  readonly #lines: Line[] = [];
  #told = 0;

  constructor(params: { agentName: string }) {
    this.#agentName = params.agentName;
  }

  /** A transcribed turn of someone in the call. */
  heard(speaker: Speaker, text: string): void {
    const t = text.trim();
    if (t) this.#lines.push({ speaker, text: t });
  }

  /** What the agent itself said (its reply's transcript). */
  said(text: string): void {
    const t = text.trim();
    if (t) this.#lines.push({ speaker: "self", text: t });
    this.#told = this.#lines.length;
  }

  /** The message that asks for a reply: the call since the agent last spoke, then who addressed it. */
  request(asker: Speaker): string {
    const since = this.#lines.slice(this.#told).filter((l) => l.speaker !== "self");
    this.#told = this.#lines.length;
    const body = since.map((l) => `${label(l.speaker as Speaker)}: ${l.text}`).join("\n");
    return [
      "[Call transcript since you last spoke]",
      body || "(nothing new)",
      `[${label(asker)} just addressed you, ${this.#agentName}. Answer them now, briefly.]`,
    ].join("\n");
  }
}

function label(s: Speaker): string {
  const kind = s.kind === "agent" ? "AI agent" : "human";
  return `${s.name} (${kind}${s.owner ? ", your owner" : ""})`;
}
