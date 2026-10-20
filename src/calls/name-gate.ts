// When the agent is addressed in a group call (#874, plan Q3): a vocative matcher that finds the
// agent's name at ANY position of a person's turn — "Can you tell me, Callie, what time it is?" or
// "So Callie, what do you think?" — not only at the first or last word. A name counts as an address
// when it is followed by `,` `?` `!` `:` `;` `.` or the end of the turn, so "Callie was helpful" (a
// mention) does not open it — unless a greeting comes right before it: "Hello Callie how are you"
// and "Hey Callie" are addresses with or without the comma, and a greeting with the name is answered
// even when nothing else is said. Hearing is fuzzy (Cali, Cally, Kali), since the transcriber still clips
// or respells a name now and then. Only a person opens it: another agent's speech is context, never
// a trigger. Saying the name alone arms that speaker's next turn for a short while (OpenClaw's Discord
// voice does the same); "Hey, Callie!" is a greeting and is answered instead.

/** How long the name said alone keeps that speaker's next turn armed. */
export const FOLLOW_UP_MS = 8_000;

export type GateInput = { userId: string; kind: string; text: string };
export type GateDecision = { pass: boolean; armed?: boolean };

export type VocativeMatch = {
  /** The configured name that was heard. */
  name: string;
  /** What the transcript actually said, as written. */
  heard: string;
  match: "exact" | "fuzzy";
  /** The turn without the name and its punctuation; "" when the name was said alone. */
  rest: string;
  /** A greeting ("hey", "hello") came right before the name. */
  greeted: boolean;
};

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
    const match = text ? matchVocative(text, this.#names) : undefined;
    if (match) {
      if (!match.rest && !match.greeted) {
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

/** Words that say nothing on their own: "Hey Callie?" is still the name alone. */
const FILLERS = new Set(["hey", "hi", "hello", "ok", "okay", "so", "um", "uh", "erm"]);
/** Words that, said right before the name, make it an address: "Hello Callie how are you". */
const GREETINGS = new Set(["hey", "hi", "hello", "hiya", "heya", "yo", "howdy"]);
/** What may follow the name for it to be an address rather than a mention. */
const VOCATIVE_AFTER = /^\s*(?:[,?!:;.]|$)/;
const WORD = /[\p{L}\p{N}]+/gu;
const MAX_NAME_WORDS = 2;

type Token = { start: number; end: number; compact: string };

/**
 * Find a configured name said as an address anywhere in `text`. The longest window wins, then
 * the earliest; an exact hearing beats a fuzzy one at the same spot.
 */
export function matchVocative(text: string, names: string[]): VocativeMatch | undefined {
  const prepared = names
    .map((name) => ({ name, compact: compact(name) }))
    .filter((n) => n.compact.length > 0)
    .sort((a, b) => b.compact.length - a.compact.length);
  if (prepared.length === 0) return undefined;
  const tokens: Token[] = Array.from(text.matchAll(WORD), (m) => ({
    start: m.index,
    end: m.index + m[0].length,
    compact: compact(m[0]),
  }));
  let best: { score: number; at: number; match: VocativeMatch } | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    for (let width = Math.min(MAX_NAME_WORDS, tokens.length - i); width >= 1; width -= 1) {
      const first = tokens[i];
      const last = tokens[i + width - 1];
      if (!first || !last) continue;
      // The words of a two-word name must be adjacent, not split by punctuation.
      if (width > 1 && !/^[\s'’-]+$/.test(text.slice(first.end, last.start))) continue;
      const before = i > 0 ? tokens[i - 1] : undefined;
      const greeted =
        before !== undefined && GREETINGS.has(before.compact) && /^[\s,]*$/.test(text.slice(before.end, first.start));
      if (!greeted && !VOCATIVE_AFTER.test(text.slice(last.end))) continue;
      const heardCompact = tokens.slice(i, i + width).map((t) => t.compact).join("");
      for (const { name, compact: nameCompact } of prepared) {
        const kind = hearing(heardCompact, nameCompact);
        if (!kind) continue;
        const score = width * 10 + (kind === "exact" ? 1 : 0);
        if (best && (best.score > score || (best.score === score && best.at <= i))) continue;
        best = {
          score,
          at: i,
          match: {
            name,
            heard: text.slice(first.start, last.end),
            match: kind,
            rest: rest(text, tokens, i, width),
            greeted,
          },
        };
      }
    }
  }
  return best?.match;
}

function compact(value: string): string {
  return value.normalize("NFD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** What is left once the name (and any fillers) are taken out. */
function rest(text: string, tokens: Token[], at: number, width: number): string {
  const others = tokens.filter((_, i) => i < at || i >= at + width).filter((t) => !FILLERS.has(t.compact));
  if (others.length === 0) return "";
  const first = others[0];
  const last = others[others.length - 1];
  if (!first || !last) return "";
  return text.slice(first.start, last.end).trim();
}

/** Spellings the transcriber swaps freely; compared on this form, "Kallie" is "callie". */
function phonetic(value: string): string {
  return value.replace(/ph/g, "f").replace(/ck/g, "c").replace(/k/g, "c").replace(/y/g, "i").replace(/(.)\1+/g, "$1");
}

/** Whether `heard` is `name`, exactly or close enough to be a mishearing of it. */
export function hearing(heard: string, name: string): "exact" | "fuzzy" | undefined {
  if (heard === name) return "exact";
  if (!heard || name.length < 4 || heard.length < 3) return undefined;
  const h = phonetic(heard);
  const n = phonetic(name);
  if (h === n) return "fuzzy";
  if (h[0] !== n[0]) return undefined;
  const distance = levenshtein(h, n);
  if (distance <= 1) return "fuzzy";
  if (distance === 2 && n.length >= 5 && h.length >= 3 && commonPrefix(h, n) >= 3) return "fuzzy";
  if (distance === 3 && n.length >= 7 && h.length >= 5 && commonPrefix(h, n) >= 4) return "fuzzy";
  return undefined;
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) if (a[i] !== b[i]) return i;
  return limit;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
