// Reply-to-confirm: a quoted "yes"/"no" reply to the plugin's words message is the human's decision on
// channels without buttons. Driven against enrollments the REAL tool created (shared world) on a
// WhatsApp route, with the hook handler called the way the host calls it: (event, ctx).
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import {
  type BeforeDispatchContext,
  type BeforeDispatchEvent,
  findEnrollmentForReply,
  handleEnrollmentReply,
  parseDecision,
  registerEnrollmentReplyHook,
  REPLY_HOOK_PRIORITY,
} from "../src/enrollment-reply.js";
import { cancelByHuman, confirmByHuman } from "../src/tools/enroll.js";
import { NEW_DEVICE, WORDS } from "./fakes/control.js";
import { tick, WORDS_MESSAGE_ID, world } from "./fakes/enroll-world.js";

type World = ReturnType<typeof world>;
const SESSION = "agent:main:webchat:owner";
const WHATSAPP = { deliveryContext: { channel: "whatsapp", to: "+3069" } } as unknown as Partial<OpenClawPluginToolContext>;

function deps(w: World) {
  return {
    registry: w.registry,
    confirm: (a: Parameters<typeof confirmByHuman>[0]) => confirmByHuman(a, w.deps, w.registry),
    cancel: (a: Parameters<typeof cancelByHuman>[0]) => cancelByHuman(a, w.registry),
  };
}

/** A WhatsApp enrollment whose phone has scanned: the words were pushed and the user is deciding. */
async function atWords(w: World = world()) {
  await w.call({ action: "start", agentName: "Iris" }, WHATSAPP);
  w.control.emit({ state: "paired", words: WORDS });
  await tick();
  expect(w.pushes[1]).toMatchObject({ kind: "words", reply: true });
  return w;
}

/** An inbound message as the host presents it to before_dispatch (quoting our words message by default). */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
function inbound(content: string, over: Loose<BeforeDispatchEvent> = {}, ctxOver: Loose<BeforeDispatchContext> = {}): [BeforeDispatchEvent, BeforeDispatchContext] {
  const event = { content, channel: "whatsapp", sessionKey: SESSION, senderId: "owner-1", replyToId: WORDS_MESSAGE_ID, replyToIsQuote: true, ...over } as BeforeDispatchEvent;
  const ctx = { channelId: "whatsapp", conversationId: "+3069", sessionKey: SESSION, senderId: "owner-1", ...ctxOver } as BeforeDispatchContext;
  return [event, ctx];
}

describe("reply-to-confirm: what counts as a decision", () => {
  it("exactly yes / y / no / n, trimmed, case-insensitive, trailing punctuation tolerated — nothing else", () => {
    expect(parseDecision("yes")).toBe("yes");
    expect(parseDecision("  YES!  ")).toBe("yes");
    expect(parseDecision("y")).toBe("yes");
    expect(parseDecision("No.")).toBe("no");
    expect(parseDecision("n")).toBe("no");
    expect(parseDecision("yes please")).toBeUndefined();
    expect(parseDecision("yes, they match")).toBeUndefined();
    expect(parseDecision("")).toBeUndefined();
    expect(parseDecision("ok")).toBeUndefined();
  });
});

describe("reply-to-confirm: the hook", () => {
  it("a bare yes without a quote is not ours: the model sees it as always", async () => {
    const w = await atWords();
    expect(await handleEnrollmentReply(...inbound("yes", { replyToId: undefined, replyToIsQuote: false }), deps(w))).toEqual({ handled: false });
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);
  });

  it("a quoted sentence that merely contains yes is not a decision", async () => {
    const w = await atWords();
    expect(await handleEnrollmentReply(...inbound("yes they do match"), deps(w))).toEqual({ handled: false });
  });

  it("a quote of some other message is not ours", async () => {
    const w = await atWords();
    expect(await handleEnrollmentReply(...inbound("yes", { replyToId: "m-other", replyToBody: "hello there" }), deps(w))).toEqual({ handled: false });
  });

  it("a quoted yes from the starter confirms with the daemon's words exactly once and answers with the outcome", async () => {
    const w = await atWords();
    const p = handleEnrollmentReply(...inbound("yes"), deps(w));
    await tick(5);
    expect(w.control.calls.filter((c) => c.op === "confirm_words").map((c) => c.params)).toEqual([{ device_id: NEW_DEVICE, words: WORDS }]);
    w.control.finish("enrolled");
    const r = await p;
    expect(r.handled).toBe(true);
    expect(r.text).toContain("Enrolled");
    expect(w.writes).toHaveLength(1);
    expect((await w.call({ action: "status" })).details.state).toBe("done");
  });

  it("a quoted no from the starter cancels: nothing written, the answer says so", async () => {
    const w = await atWords();
    const r = await handleEnrollmentReply(...inbound("no"), deps(w));
    expect(r.handled).toBe(true);
    expect(r.text).toContain("cancelled");
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
    expect(w.writes).toHaveLength(0);
    expect((await w.call({ action: "status" })).details.state).toBe("cancelled");
  });

  it("when the quoted id is unknown, a quoted body carrying all four words still identifies our message", async () => {
    const w = await atWords();
    const body = `Your phone now shows four safety words. They should be: ${WORDS.join("   ")}. Compare them...`;
    const [event, ctx] = inbound("no", { replyToId: "wa-format-differs", replyToBody: body });
    expect(findEnrollmentForReply(w.registry, event, ctx)?.deviceId).toBe(NEW_DEVICE);
    const r = await handleEnrollmentReply(event, ctx, deps(w));
    expect(r).toMatchObject({ handled: true });
    expect((await w.call({ action: "status" })).details.state).toBe("cancelled");
    // a body with only three of the words is not enough
    const w2 = await atWords();
    const partial = `They should be: ${WORDS.slice(0, 3).join(" ")}`;
    expect(findEnrollmentForReply(w2.registry, ...inbound("yes", { replyToId: "x", replyToBody: partial }))).toBeUndefined();
  });

  it("another sender's quoted yes is answered, never acted on", async () => {
    const w = await atWords();
    const r = await handleEnrollmentReply(...inbound("yes", { senderId: "someone-else" }, { senderId: "someone-else" }), deps(w));
    expect(r.handled).toBe(true);
    expect(r.text).toContain("Only the person who started");
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);
    // a missing sender id is refused too (the host always sets it on real channels)
    const r2 = await handleEnrollmentReply(...inbound("yes", { senderId: undefined }, { senderId: undefined }), deps(w));
    expect(r2.text).toContain("Only the person who started");
  });

  it("a quote from another session is answered as not theirs, never acted on", async () => {
    const w = await atWords();
    const r = await handleEnrollmentReply(...inbound("yes", { sessionKey: "agent:main:whatsapp:other" }, { sessionKey: "agent:main:whatsapp:other" }), deps(w));
    expect(r).toMatchObject({ handled: true });
    expect(r.text).toContain("Only the person who started");
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);
  });

  it("a quoted reply after the outcome gets the status, never the model", async () => {
    const w = await atWords();
    await handleEnrollmentReply(...inbound("no"), deps(w));
    const late = await handleEnrollmentReply(...inbound("yes"), deps(w));
    expect(late.handled).toBe(true);
    expect(late.text).toContain("cancelled");
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);
  });

  it("before the phone scanned there is no words message, so nothing is ever claimed", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" }, WHATSAPP);
    expect(w.pushes).toHaveLength(1);
    expect(await handleEnrollmentReply(...inbound("yes"), deps(w))).toEqual({ handled: false });
  });

  it("a page-lane enrollment (TUI / web UI) stores no words message id and is never claimed", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ state: "paired", words: WORDS });
    await tick();
    expect(w.registry.forSession(SESSION)!.wordsMessageId).toBeUndefined();
    expect(await handleEnrollmentReply(...inbound("yes", { channel: "webchat" }), deps(w))).toEqual({ handled: false });
    // even a body carrying the words: the page lane pushes nothing, so no quote can point at it
    const [event, ctx] = inbound("yes", { channel: "webchat", replyToId: "x", replyToBody: WORDS.join(" ") });
    expect(await handleEnrollmentReply(event, ctx, deps(w))).toEqual({ handled: false });
  });

  it("registers the typed before_dispatch hook with a high priority in every registration pass (inert outside the gateway's full registry)", () => {
    const w = world();
    const seen: Array<{ name: string; opts: unknown }> = [];
    const api = (mode: string) =>
      ({
        registrationMode: mode,
        on: (name: string, _handler: unknown, opts: unknown) => void seen.push({ name, opts }),
        registerHook: () => {
          throw new Error("legacy registerHook must not be used for typed hooks");
        },
      }) as unknown as OpenClawPluginApi;
    registerEnrollmentReplyHook(api("full"), deps(w));
    expect(seen).toEqual([{ name: "before_dispatch", opts: { priority: REPLY_HOOK_PRIORITY } }]);
    registerEnrollmentReplyHook(api("tool-discovery"), deps(w));
    expect(seen).toHaveLength(2);
  });

  it("the handler never throws into the host on odd input", async () => {
    const w = world();
    expect(await handleEnrollmentReply({ content: "yes" }, {}, deps(w))).toEqual({ handled: false });
    expect(await handleEnrollmentReply({ content: "" } as BeforeDispatchEvent, {}, deps(w))).toEqual({ handled: false });
  });
});

describe("reply-to-confirm: entries test wiring", () => {
  it("the full entry registers the hook once", async () => {
    const { default: fullEntry } = await import("../index.js");
    const seen: string[] = [];
    const api = {
      registrationMode: "full",
      pluginConfig: {},
      runtime: { logging: { getChildLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }, config: { mutateConfigFile: async () => ({}), current: () => ({}) }, channel: {}, media: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerChannel: () => {},
      registerTool: () => {},
      registerService: () => {},
      registerHttpRoute: () => {},
      registerInteractiveHandler: () => {},
      on: (name: string) => void seen.push(name),
    } as never;
    (fullEntry as { register: (api: unknown) => void }).register(api);
    expect(seen).toEqual(["before_dispatch"]);
  });
});
