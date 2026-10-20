// #874 group calls, the plugin's half (AdemuMLS `adc/plans/2026-10-16-agent-group-calls.md`, B1/B2):
// who said what from the daemon's speaking frames, when the agent is addressed, and what it is told.
import { describe, expect, it } from "vitest";
import { CallLog } from "../src/calls/call-log.js";
import { NameGate, matchVocative } from "../src/calls/name-gate.js";
import { SpeechSegmenter, type Segment } from "../src/calls/segments.js";

const RATE = 24_000;
/** `ms` of PCM16 at 24 kHz, every sample `v`. */
const pcm = (ms: number, v = 1000) => {
  const b = Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i);
  return b;
};
const msOf = (b: Buffer) => Math.round(((b.length / 2) * 1000) / RATE);

describe("SpeechSegmenter", () => {
  const make = (opts: Partial<{ preRollMs: number; maxMs: number }> = {}) => {
    const out: Segment[] = [];
    const s = new SpeechSegmenter({ rate: RATE, preRollMs: opts.preRollMs ?? 300, maxMs: opts.maxMs ?? 30_000, onSegment: (seg) => out.push(seg) });
    return { s, out };
  };

  it("cuts one segment per turn, with the pre-roll before the speaker's start", () => {
    const { s, out } = make();
    s.pcm(pcm(500, 1)); // silence before: the last 300 ms become the pre-roll
    s.speaking("u1", true);
    s.pcm(pcm(1000, 2));
    s.speaking("u1", false);
    s.pcm(pcm(200, 3));
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("u1");
    expect(msOf(out[0]!.pcm)).toBe(1300);
    expect(out[0]!.pcm.readInt16LE(0)).toBe(1);
    expect(out[0]!.pcm.readInt16LE(out[0]!.pcm.length - 2)).toBe(2);
  });

  it("overlapping speakers each get a segment of the same mixed audio; a repeated start changes nothing", () => {
    const { s, out } = make({ preRollMs: 0 });
    s.speaking("u1", true);
    s.pcm(pcm(400));
    s.speaking("u2", true);
    s.speaking("u2", true);
    s.pcm(pcm(400));
    s.speaking("u1", false);
    s.pcm(pcm(400));
    s.speaking("u2", false);
    expect(out.map((x) => [x.userId, msOf(x.pcm)])).toEqual([
      ["u1", 800],
      ["u2", 800],
    ]);
  });

  it("a turn longer than the cap is cut and goes on; flush ends every open turn", () => {
    const { s, out } = make({ preRollMs: 0, maxMs: 1000 });
    s.speaking("u1", true);
    s.pcm(pcm(1500));
    expect(out.map((x) => msOf(x.pcm))).toEqual([1000]);
    s.flush();
    expect(out.map((x) => msOf(x.pcm))).toEqual([1000, 500]);
    s.speaking("u1", false);
    expect(out).toHaveLength(2);
  });
});

describe("NameGate", () => {
  const gate = () => new NameGate(["Callie"], { now: () => clock });
  let clock = 0;
  const human = (text: string, userId = "u1") => ({ userId, kind: "human", text });

  it("passes a human who addresses the agent by name, first or last", () => {
    const g = gate();
    expect(g.decide(human("Callie, what time is dinner?"))).toMatchObject({ pass: true });
    expect(g.decide(human("What do you think about the plan, Callie?"))).toMatchObject({ pass: true });
    expect(g.decide(human("Thanks Callie."))).toMatchObject({ pass: true });
    expect(g.decide(human("Hey Callie, what's the weather?"))).toMatchObject({ pass: true });
  });

  it("passes the name anywhere in the turn, after a filler or in the middle of a sentence", () => {
    const g = gate();
    expect(g.decide(human("So Callie, what do you think?")).pass).toBe(true);
    expect(g.decide(human("Um, Callie, what time is it?")).pass).toBe(true);
    expect(g.decide(human("Yes. Callie, what time is it?")).pass).toBe(true);
    expect(g.decide(human("Can you tell me, Callie, what time it is?")).pass).toBe(true);
    expect(g.decide(human("What time is it Callie, please?")).pass).toBe(true);
    expect(g.decide(human("I don't know. Callie? Do you know?")).pass).toBe(true);
  });

  it("hears the name through the transcriber's respellings, at any position", () => {
    const g = gate();
    expect(g.decide(human("Cali, who is leaving early?"))).toMatchObject({ pass: true });
    expect(g.decide(human("Who is leaving early, Cali?"))).toMatchObject({ pass: true });
    expect(g.decide(human("Who is leaving early, Kali?"))).toMatchObject({ pass: true });
    expect(g.decide(human("Tell me, Cally, who is leaving early?"))).toMatchObject({ pass: true });
    expect(g.decide(human("Tell me, Kallie, who is leaving early?"))).toMatchObject({ pass: true });
  });

  it("blocks side talk, a mention, another name, and any agent", () => {
    const g = gate();
    expect(g.decide(human("Hey Bob, did you book it?")).pass).toBe(false);
    expect(g.decide(human("Callie was really helpful last week, wasn't she?")).pass).toBe(false);
    expect(g.decide(human("I think Callie should answer this one.")).pass).toBe(false);
    expect(g.decide(human("Let's ask Callie later.")).pass).toBe(false);
    expect(g.decide(human("Call me when you land.")).pass).toBe(false);
    expect(g.decide(human("Hey Kelly, what time is it?")).pass).toBe(false);
    expect(g.decide(human("Charlie, what time is it?")).pass).toBe(false);
    expect(g.decide({ userId: "u3", kind: "agent", text: "Callie, can you confirm the booking?" }).pass).toBe(false);
  });

  it("the name alone arms that speaker's next turn, for a short while", () => {
    clock = 0;
    const g = gate();
    expect(g.decide(human("Callie?"))).toMatchObject({ pass: false, armed: true });
    expect(g.decide(human("What's the time?", "u2")).pass).toBe(false);
    clock = 3_000;
    expect(g.decide(human("What's the time?")).pass).toBe(true);
    expect(g.decide(human("And tomorrow?")).pass).toBe(false);
    g.decide(human("Callie?"));
    clock = 3_000 + 20_000;
    expect(g.decide(human("What's the time?")).pass).toBe(false);
    expect(g.decide(human("Callie, no."))).toMatchObject({ pass: true });
  });

  it("a greeting right before the name is an address whatever follows, and a greeting alone is answered", () => {
    const g = gate();
    expect(g.decide(human("Hello Callie."))).toEqual({ pass: true });
    expect(g.decide(human("Hey, Callie!"))).toEqual({ pass: true });
    expect(g.decide(human("Hello Callie how are you doing"))).toEqual({ pass: true });
    expect(g.decide(human("Hi Cali what time is it?"))).toEqual({ pass: true });
    expect(g.decide(human("I said hello to Callie yesterday.")).pass).toBe(false);
    expect(g.decide(human("Hey Kelly how are you?")).pass).toBe(false);
  });

  it("matches a two-word name said as two words or one, and prefers the longer name", () => {
    const g = new NameGate(["Gianni Bot", "Gianni"], { now: () => 0 });
    expect(matchVocative("Gianni Bot, are you there?", ["Gianni Bot", "Gianni"])).toMatchObject({ name: "Gianni Bot", match: "exact" });
    expect(matchVocative("GianniBot, are you there?", ["Gianni Bot"])).toMatchObject({ name: "Gianni Bot", match: "exact" });
    expect(matchVocative("Gianni, are you there?", ["Gianni Bot", "Gianni"])).toMatchObject({ name: "Gianni", match: "exact" });
    expect(g.decide(human("Gianni Bot, are you there?")).pass).toBe(true);
  });

  it("reports what was heard and what is left of the turn", () => {
    expect(matchVocative("So Callie, what do you think?", ["Callie"])).toEqual({
      name: "Callie",
      heard: "Callie",
      match: "exact",
      rest: "what do you think",
      greeted: false,
    });
    expect(matchVocative("Hey Cali!", ["Callie"])).toMatchObject({ heard: "Cali", match: "fuzzy", rest: "", greeted: true });
    expect(matchVocative("Callie was helpful.", ["Callie"])).toBeUndefined();
  });
});

describe("CallLog", () => {
  it("labels every line and hands the agent what was said since it last spoke", () => {
    const log = new CallLog({ agentName: "Callie" });
    log.heard({ name: "Maria", kind: "human", owner: false }, "Hey Bob, did you book it?");
    log.heard({ name: "Bob", kind: "human", owner: false }, "Yes, Luigi's at eight.");
    log.heard({ name: "Iris", kind: "agent", owner: false }, "Added to the calendar.");
    const first = log.request({ name: "Giannis", kind: "human", owner: true });
    expect(first).toContain("Maria (human): Hey Bob, did you book it?");
    expect(first).toContain("Bob (human): Yes, Luigi's at eight.");
    expect(first).toContain("Iris (AI agent): Added to the calendar.");
    expect(first).toContain("Giannis (human, your owner) just addressed you");
    log.said("It's at Luigi's at eight.");
    log.heard({ name: "Bob", kind: "human", owner: false }, "I'll leave around ten.");
    const second = log.request({ name: "Maria", kind: "human", owner: false });
    expect(second).not.toContain("Luigi's at eight");
    expect(second).toContain("Bob (human): I'll leave around ten.");
  });
});

describe("transcribeSegment", () => {
  it("posts the turn as a WAV with the model and the call's names, and returns the text", async () => {
    const { transcribeSegment } = await import("../src/calls/transcribe.js");
    let seen: { url: string; auth: string | null; form: FormData } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), form: init.body as FormData };
      return new Response(JSON.stringify({ text: " Callie, what time is it? " }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await transcribeSegment({ pcm: pcm(200), rate: RATE, apiKey: "sk-test", names: ["Callie", "Maria"], fetchImpl });
    expect(text).toBe("Callie, what time is it?");
    expect(seen!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen!.auth).toBe("Bearer sk-test");
    expect(seen!.form.get("model")).toBe("gpt-4o-transcribe");
    expect(seen!.form.get("prompt")).toBe("Group voice call. Names: Callie, Maria.");
    const file = seen!.form.get("file") as Blob;
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");
  });

  it("a failed request is a TranscribeError, never an empty turn", async () => {
    const { transcribeSegment, TranscribeError } = await import("../src/calls/transcribe.js");
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(transcribeSegment({ pcm: pcm(100), rate: RATE, apiKey: "k", names: [], fetchImpl })).rejects.toBeInstanceOf(TranscribeError);
  });
});

describe("GroupCallBrain", () => {
  const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const MARIA = "2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";
  const IRIS = "3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c";
  const STRANGER = "4a5b6c7d-8e9f-4a0b-9c1d-3e4f5a6b7c8d";

  async function world(script: Record<string, string>) {
    const { GroupCallBrain } = await import("../src/calls/group-brain.js");
    const asked: string[] = [];
    const transcribed: string[] = [];
    let turn = 0;
    const brain = new GroupCallBrain({
      agentName: "Callie",
      wakeNames: ["Callie"],
      ownerUserId: OWNER,
      rate: RATE,
      preRollMs: 0,
      transcribe: async (seg, names) => {
        transcribed.push(`${names.join("/")}`);
        // The test marks each turn's audio with its index in the first sample.
        return script[String(seg.readInt16LE(0))] ?? "";
      },
      ask: (text) => asked.push(text),
      log: () => {},
    });
    brain.setRoster([
      { user_id: OWNER, username: "giannis", kind: "human" },
      { user_id: MARIA, username: "maria", kind: "human" },
      { user_id: IRIS, username: "iris", kind: "agent" },
    ]);
    const say = (userId: string) => {
      turn++;
      brain.onSpeaking(userId, true);
      brain.onPcm(pcm(200, turn));
      brain.onSpeaking(userId, false);
    };
    return { brain, asked, transcribed, say };
  }

  it("transcribes each member's turn with the call's names, logs it, and asks only when a person names the agent", async () => {
    const w = await world({
      "1": "Hey Bob, did you book Luigi's?",
      "2": "Callie, confirm the booking.",
      "3": "Callie, what time is dinner?",
    });
    w.say(MARIA);
    w.say(IRIS);
    w.say(OWNER);
    await w.brain.settled();
    expect(w.transcribed[0]).toBe("Callie/giannis/maria/iris");
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]).toContain("maria (human): Hey Bob, did you book Luigi's?");
    expect(w.asked[0]).toContain("iris (AI agent): Callie, confirm the booking.");
    expect(w.asked[0]).toContain("giannis (human, your owner) just addressed you");
  });

  it("ignores speech credited to someone outside the roster", async () => {
    const w = await world({ "1": "Callie, what's the wifi password?" });
    w.say(STRANGER);
    await w.brain.settled();
    expect(w.transcribed).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  it("only the person the agent is answering may barge in, and only while they speak", async () => {
    const w = await world({ "1": "Callie, tell me a story." });
    expect(w.brain.bargeInGate()).toBe(false);
    w.say(OWNER);
    await w.brain.settled();
    w.brain.onSpeaking(MARIA, true);
    expect(w.brain.bargeInGate()).toBe(false);
    w.brain.onSpeaking(OWNER, true);
    expect(w.brain.bargeInGate()).toBe(true);
    w.brain.onSpeaking(OWNER, false);
    expect(w.brain.bargeInGate()).toBe(false);
  });

  it("what the agent said is part of the log, and is not repeated to it", async () => {
    const w = await world({ "1": "Callie, what time?", "2": "Callie, and where?" });
    w.say(OWNER);
    await w.brain.settled();
    w.brain.onAgentSaid("Eight o'clock.");
    w.say(OWNER);
    await w.brain.settled();
    expect(w.asked).toHaveLength(2);
    expect(w.asked[1]).not.toContain("what time?");
    expect(w.asked[1]).toContain("giannis (human, your owner): Callie, and where?");
  });
});
