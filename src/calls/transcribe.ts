// One speaker's turn to text (#874, plan Q5 (b)): the plugin transcribes each person's segment
// itself, with the call's names as the vocabulary, because the realtime session's own transcriber
// has no vocabulary and mishears the agent's name (the spike: 7 of 15 addressed turns missed).

export const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";

export type TranscribeParams = {
  pcm: Buffer;
  rate: number;
  apiKey: string;
  model?: string | undefined;
  /** The names in the call (the agent's first), so the transcriber spells them right. */
  names: string[];
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export class TranscribeError extends Error {
  constructor(readonly status: number | undefined) {
    super(`transcription failed${status ? ` (${status})` : ""}`);
    this.name = "TranscribeError";
  }
}

/** PCM16LE mono as a WAV file. */
export function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** The turn's text (trimmed; "" for silence). Throws {@link TranscribeError}. */
export async function transcribeSegment(p: TranscribeParams): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav(p.pcm, p.rate))], { type: "audio/wav" }), "turn.wav");
  form.append("model", p.model ?? DEFAULT_TRANSCRIBE_MODEL);
  const names = p.names.filter((n) => n.trim()).join(", ");
  if (names) form.append("prompt", `Group voice call. Names: ${names}.`);
  form.append("response_format", "json");
  let res: Response;
  try {
    res = await (p.fetchImpl ?? fetch)(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.apiKey}` },
      body: form,
      ...(p.signal ? { signal: p.signal } : {}),
    });
  } catch {
    throw new TranscribeError(undefined);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new TranscribeError(res.status);
  }
  const body = (await res.json().catch(() => undefined)) as { text?: unknown } | undefined;
  if (!body || typeof body.text !== "string") throw new TranscribeError(res.status);
  return body.text.trim();
}
