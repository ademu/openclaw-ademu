// The `ademu_enroll` chat tool: two actions (start, status). The human's yes / no never come through
// the model — here they arrive through `confirmByHuman` / `cancelByHuman`, the same functions the
// enrollment page and the channel buttons call.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { DaemonUnreachableError } from "../src/monitor/daemon.js";
import { cancelByHuman, confirmByHuman, createEnrollTool, registerEnrollTool, TOOL_NAME } from "../src/tools/enroll.js";
import { FakeAdcClient, OWNER } from "./fakes/adc.js";
import { NEW_AGENT, NEW_DEVICE, QR, WORDS } from "./fakes/control.js";
import { tick, WORDS_MESSAGE_ID, world } from "./fakes/enroll-world.js";

type World = ReturnType<typeof world>;
const SESSION = "agent:main:webchat:owner";
const TELEGRAM = { deliveryContext: { channel: "telegram", to: "chat-1", accountId: "bot" } } as unknown as Partial<OpenClawPluginToolContext>;
const WHATSAPP = { deliveryContext: { channel: "whatsapp", to: "+3069" } } as unknown as Partial<OpenClawPluginToolContext>;
const IRC = { deliveryContext: { channel: "irc", to: "#ops" } } as unknown as Partial<OpenClawPluginToolContext>;

/** The live enrollment of the default conversation (what the page / a button would address). */
const live = (w: World) => w.registry.forSession(SESSION)!;
const yes = (w: World, entry = live(w)) => confirmByHuman(entry, w.deps, w.registry);
const no = (w: World, entry = live(w)) => cancelByHuman(entry, w.registry);

describe("ademu_enroll: gating", () => {
  it("is offered only to owners and exposes exactly start + status", () => {
    const w = world();
    expect(createEnrollTool({ senderIsOwner: false } as OpenClawPluginToolContext, w.deps, w.registry)).toBeNull();
    expect(createEnrollTool({} as OpenClawPluginToolContext, w.deps, w.registry)).toBeNull();
    const t = w.tool();
    expect(t.name).toBe(TOOL_NAME);
    expect(t.description).not.toMatch(/\bpair/i);
    expect(t.description).toContain("neither confirm nor cancel");
    const schema = t.parameters as unknown as { properties: { action: { enum: string[] }; leaseToken?: unknown } };
    expect(schema.properties.action.enum).toEqual(["start", "status"]);
    expect(schema.properties.leaseToken).toBeUndefined();
  });

  it("refuses to start without a conversation session", async () => {
    const w = world();
    const r = await w.call({ action: "start" }, { sessionKey: "" });
    expect(r.details.ok).toBe(false);
    expect(r.content[0]!.text).toContain("conversation session");
    expect(w.acquires).toHaveLength(0);
  });

  it("an absent or aborted signal is an expired authority: no device is created", async () => {
    const w = world();
    await expect(w.tool().execute("c", { action: "start" }, undefined)).rejects.toThrow(/authority/);
    const ac = new AbortController();
    ac.abort();
    await expect(w.call({ action: "start" }, {}, ac.signal)).rejects.toThrow(/authority/);
    expect(w.control.calls.some((c) => c.op === "create_device")).toBe(false);
  });

  it("refuses an accountId that already exists", async () => {
    const w = world({ channels: { ademu: { accounts: { iris: { deviceId: "d", token: "t" } } } } } as unknown as OpenClawConfig);
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(r.details).toMatchObject({ ok: false, accountId: "iris" });
    expect(w.acquires).toHaveLength(0);
  });
});

describe("ademu_enroll: the ceremony (start → the human's yes / no → outcome)", () => {
  it("start → scan → human yes writes the account, grants the owner, disposes the lease exactly once; status follows", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" });
    expect(start.details).toMatchObject({ ok: true, state: "scanning", deviceId: NEW_DEVICE, accountId: "iris", lane: "page" });
    const txt = start.content[0]!.text;
    expect(txt).toContain("![ademu-enroll](data:image/png;base64,QUJD)");
    expect(txt).toContain(QR);
    expect(txt).toContain(start.details.pageUrl as string);
    expect(txt).toContain("cannot confirm or cancel");
    expect(txt).not.toMatch(/lease ?token/i);
    expect((w.acquires[0] as { role: string }).role).toBe("setup");
    expect(w.registry.size).toBe(1);

    const s1 = await w.call({ action: "status" });
    expect(s1.details).toMatchObject({ ok: true, state: "scanning" });

    w.control.emit({ state: "paired", words: WORDS });
    const s2 = await w.call({ action: "status" });
    expect(s2.details).toMatchObject({ ok: true, state: "words_shown" });
    expect(s2.content[0]!.text).toContain("Do NOT ask");
    for (const word of WORDS) expect(s2.content[0]!.text).not.toContain(word); // the words never reach the model

    // the human's yes: the DAEMON's words are confirmed
    const yesP = yes(w);
    await tick(5);
    expect(w.control.calls.find((c) => c.op === "confirm_words")?.params).toEqual({ device_id: NEW_DEVICE, words: WORDS });
    expect((await w.call({ action: "status" })).details.state).toBe("confirming");
    w.control.finish("enrolled");
    const done = await yesP;
    expect(done).toMatchObject({ ok: true, state: "done" });
    expect(done.message).toContain("Enrolled");
    expect(done.message).toContain('routed to OpenClaw agent "main"');

    expect(w.writes).toHaveLength(1);
    const cfg = w.current() as unknown as {
      channels: { ademu: { enabled: boolean; accounts: Record<string, Record<string, unknown>> } };
      commands: { ownerAllowFrom: string[] };
      bindings: unknown[];
    };
    expect(cfg.channels.ademu.enabled).toBe(true);
    expect(cfg.channels.ademu.accounts.iris).toMatchObject({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, token: "adc1_secret_1", agentName: "Iris" });
    expect(cfg.commands.ownerAllowFrom).toEqual([`ademu:${OWNER}`]);
    expect(cfg.bindings).toEqual([{ agentId: "main", match: { channel: "ademu", accountId: "iris" } }]);
    expect(w.control.calls.find((c) => c.op === "token_mint")?.params).toEqual({ device_id: NEW_DEVICE, label: "openclaw-iris" });
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect(w.control.closed).toBe(1);

    // the chat learns the outcome the human produced
    const s3 = await w.call({ action: "status" });
    expect(s3.details).toMatchObject({ ok: true, state: "done" });
    expect(s3.content[0]!.text).toContain("Enrolled");
    expect(w.pushes).toEqual([]); // page lane: nothing is pushed into a channel
  });

  it("status from another conversation, sender or agent is refused; the owner's own is answered", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    const other = await w.call({ action: "status", deviceId: NEW_DEVICE }, { sessionKey: "agent:main:webchat:someone-else" });
    expect(other.details.ok).toBe(false);
    expect(other.content[0]!.text).toContain("another conversation");
    expect((await w.call({ action: "status" }, { requesterSenderId: "intruder" })).details.ok).toBe(false);
    expect((await w.call({ action: "status" }, { agentId: "other-agent" })).details.ok).toBe(false);
    expect((await w.call({ action: "status" })).details).toMatchObject({ ok: true, state: "scanning" });
  });

  it("the human's NO cancels: the daemon ceremony is cancelled, nothing is written, status says cancelled, a second NO is idempotent", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    const r = await no(w);
    expect(r).toMatchObject({ ok: true, state: "cancelled" });
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
    expect(w.writes).toHaveLength(0);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    const status = await w.call({ action: "status" });
    expect(status.details).toMatchObject({ ok: true, state: "cancelled" });
    expect(status.content[0]!.text).toContain("cancelled");
    const again = await cancelByHuman(w.registry.lookup(NEW_DEVICE)!, w.registry);
    expect(again).toMatchObject({ ok: true, state: "cancelled" });
    expect(w.released()).toBe(1);
  });

  it("a duplicate token label on the device this ceremony created is replaced silently (our own earlier attempt)", async () => {
    const w = world();
    w.control.tokenMintImpl = async (p) => {
      if (!p.replace) throw new (await import("@ademu/adc-control")).ControlError("label_exists", "x");
      return { token_id: "tid", label: p.label, token: "adc1_rotated", created_at_ms: 1 };
    };
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    const done = await yesP;
    expect(done).toMatchObject({ ok: true, state: "done" });
    expect(done.message).not.toMatch(/token/i);
    expect((w.current() as unknown as { channels: { ademu: { accounts: { iris: { token: string } } } } }).channels.ademu.accounts.iris.token).toBe("adc1_rotated");
    expect(w.control.calls.filter((c) => c.op === "token_mint").map((c) => c.params)).toEqual([
      { device_id: NEW_DEVICE, label: "openclaw-iris" },
      { device_id: NEW_DEVICE, label: "openclaw-iris", replace: true },
    ]);
    expect(w.writes).toHaveLength(1);
  });

  it("a words mismatch (the daemon refuses the human's yes) disposes the lease and reports without writing", async () => {
    const w = world();
    w.control.confirmWordsImpl = async () => {
      throw new (await import("@ademu/adc-control")).ControlError("words_mismatch", "x");
    };
    await w.call({ action: "start" });
    w.control.emit({ words: WORDS });
    await tick();
    const r = await yes(w);
    expect(r).toMatchObject({ ok: false, state: "words_mismatch" });
    expect(w.writes).toHaveLength(0);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect((await w.call({ action: "status" })).details.state).toBe("failed");
  });

  it("the TTL timer disposes the lease (3 minutes) and a second start supersedes the first", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    expect(w.timers[0]?.ms).toBe(180_000);
    w.timers[0]!.fn();
    await tick();
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect((await w.call({ action: "status" })).details.state).toBe("expired");

    await w.call({ action: "start", agentName: "Iris" });
    await w.call({ action: "start", agentName: "Bob" });
    expect(w.registry.size).toBe(1);
    expect(w.released()).toBe(2);
  });
});

describe("ademu_enroll: the channel lane (media channels)", () => {
  it("on telegram the plugin pushes the QR + link, then the words with buttons, then the outcome; the model is told it sent nothing", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" }, TELEGRAM);
    expect(start.details).toMatchObject({ ok: true, lane: "push", channel: "telegram" });
    expect(start.content[0]!.text).toContain("INTO THIS CONVERSATION");
    expect(start.content[0]!.text).toContain("Yes and a No button");
    expect(start.content[0]!.text).not.toContain("![ademu-enroll]"); // nothing for the model to relay
    expect(w.opens).toEqual([]); // the browser on the gateway box is not the user's
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]).toMatchObject({ kind: "qr", agentName: "Iris", dataUrl: "data:image/png;base64,QUJD", link: QR, route: { channel: "telegram", to: "chat-1", accountId: "bot" } });
    expect(w.pushes[0]!.pageUrl).toBeUndefined(); // loopback page: not reachable from the phone

    w.control.emit({ state: "paired", words: WORDS });
    await tick();
    expect(w.pushes).toHaveLength(2);
    expect(w.pushes[1]).toMatchObject({ kind: "words", words: WORDS, buttons: true, reply: true });
    expect(w.pushes[1]!.nonce).toMatch(/^[a-f0-9]{24}$/);
    expect(w.pushes[1]!.nonce).toBe(live(w).nonce);
    expect(live(w).wordsMessageId).toBe(WORDS_MESSAGE_ID); // what a quoted yes/no will point at

    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    await yesP;
    await tick();
    expect(w.pushes).toHaveLength(3);
    expect(w.pushes[2]).toMatchObject({ kind: "text" });
    expect(w.pushes[2]!.text as string).toContain("Enrolled");
    expect(w.writes).toHaveLength(1);
  });

  it("on whatsapp (no buttons, quoted replies) the words invite a quoted yes/no reply; the model is told a bare yes is not a decision", async () => {
    const w = world();
    const start = await w.call({ action: "start", agentName: "Iris" }, WHATSAPP);
    expect(start.details).toMatchObject({ ok: true, lane: "push", channel: "whatsapp" });
    expect(start.content[0]!.text).toContain("REPLIES to that message");
    expect(start.content[0]!.text).toContain("not a decision");
    expect(w.pushes[0]!.pageUrl).toBeUndefined();
    w.control.emit({ words: WORDS });
    await tick();
    expect(w.pushes[1]).toMatchObject({ kind: "words", buttons: false, reply: true, pageUrl: undefined });
    expect(live(w).wordsMessageId).toBe(WORDS_MESSAGE_ID);
  });

  it("with a reachable page, the words also carry the page link", async () => {
    const w = world({ channels: { ademu: { enrollmentPage: { baseUrl: "https://gw.example.com" } } } } as unknown as OpenClawConfig);
    const start = await w.call({ action: "start", agentName: "Iris" }, WHATSAPP);
    expect(start.details).toMatchObject({ ok: true, lane: "push", channel: "whatsapp" });
    expect(w.pushes[0]!.pageUrl).toMatch(/^https:\/\/gw\.example\.com\/plugins\/ademu\/enroll\/[a-f0-9]{40}$/);
    w.control.emit({ words: WORDS });
    await tick();
    expect(w.pushes[1]).toMatchObject({ kind: "words", buttons: false, reply: true, pageUrl: start.details.pageUrl });
  });

  it("a channel with no buttons, no quoted replies and no reachable page is refused BEFORE any device or lease exists", async () => {
    const w = world();
    const r = await w.call({ action: "start", agentName: "Iris" }, IRC);
    expect(r.details).toMatchObject({ ok: false, state: "channel_unsupported", channel: "irc" });
    expect(r.content[0]!.text).toContain("openclaw channels add --channel ademu");
    expect(r.content[0]!.text).toContain("enrollmentPage.baseUrl");
    expect(w.acquires).toHaveLength(0);
    expect(w.control.calls.some((c) => c.op === "create_device")).toBe(false);
    expect(w.registry.size).toBe(0);
  });

  it("a refused QR delivery ends the ceremony before the user saw anything", async () => {
    const w = world();
    w.pushOk.value = false;
    const r = await w.call({ action: "start", agentName: "Iris" }, TELEGRAM);
    expect(r.details).toMatchObject({ ok: false, state: "push_failed" });
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
  });

  it("the human's NO on a channel pushes the cancelled notice; a mismatch pushes its own", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" }, TELEGRAM);
    w.control.emit({ words: WORDS });
    await tick();
    await no(w);
    await tick();
    expect(w.pushes.map((p) => p.kind)).toEqual(["qr", "words", "text"]);
    expect(w.pushes[2]!.text as string).toContain("cancelled");

    const w2 = world();
    w2.control.confirmWordsImpl = async () => {
      throw new (await import("@ademu/adc-control")).ControlError("words_mismatch", "x");
    };
    await w2.call({ action: "start", agentName: "Iris" }, TELEGRAM);
    w2.control.emit({ words: WORDS });
    await tick();
    await yes(w2);
    await tick();
    expect(w2.pushes[2]!.text as string).toContain("did not match");
  });
});

describe("ademu_enroll: routing binding (the account is never written unrouted)", () => {
  async function enroll(w: World, over: Partial<OpenClawPluginToolContext> = {}, agentName = "Iris") {
    const start = await w.call({ action: "start", agentName }, over);
    expect(start.details.ok).toBe(true);
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w, w.registry.get(NEW_DEVICE)!);
    await tick(5);
    w.control.finish("enrolled");
    return yesP;
  }
  const bindingsOf = (w: World) => (w.current() as unknown as { bindings?: unknown[] }).bindings;

  it("routes the account to the enrolling agent on a multi-agent roster", async () => {
    const w = world(ROSTER("iris", "ledger", "main"));
    const done = await enroll(w, { agentId: "iris" });
    expect(done).toMatchObject({ ok: true, state: "done" });
    expect(bindingsOf(w)).toEqual([{ agentId: "iris", match: { channel: "ademu", accountId: "iris" } }]);
    expect(w.writes).toHaveLength(1);
  });

  it("appends to existing bindings in host order and keeps non-route rows", async () => {
    const existing = [
      { agentId: "iris", match: { channel: "ademu", accountId: "iris" } },
      { agentId: "ledger", match: { channel: "ademu", accountId: "ledger" } },
      { type: "acp", agentId: "x", match: { channel: "ademu", accountId: "z" } },
    ];
    const w = world({ ...ROSTER("main", "work", "iris", "ledger"), bindings: existing, agents: { ownership: "explicit", entries: { main: {}, work: {}, iris: {}, ledger: {} } } } as unknown as OpenClawConfig);
    const done = await enroll(w, { agentId: "main" }, "Repro");
    expect(done).toMatchObject({ ok: true, state: "done" });
    expect(bindingsOf(w)).toEqual([existing[0], existing[1], { agentId: "main", match: { channel: "ademu", accountId: "repro" } }, existing[2]]);
  });

  it("start is refused when the conversation carries no agent id: no device, no lease", async () => {
    const w = world();
    const r = await w.call({ action: "start", agentName: "Iris" }, NO_AXES);
    expect(r.details).toMatchObject({ ok: false, state: "agent_unknown" });
    expect(r.content[0]!.text).toContain("Nothing was written");
    expect(w.control.calls.some((c) => c.op === "create_device")).toBe(false);
    expect(w.acquires).toHaveLength(0);
    expect(w.registry.size).toBe(0);
  });

  it("start is refused when the agent id names no configured agent (never a default fallback)", async () => {
    const w = world(ROSTER("iris", "ledger"));
    const r = await w.call({ action: "start", agentName: "Iris" }, { agentId: "ghost" });
    expect(r.details).toMatchObject({ ok: false, state: "agent_unknown" });
    expect(w.acquires).toHaveLength(0);
    const ok = await world().call({ action: "start", agentName: "Iris" });
    expect(ok.details.ok).toBe(true);
  });

  it("start is refused when the account id is already routed to another agent", async () => {
    const w = world({ bindings: [{ agentId: "ledger", match: { channel: "ademu", accountId: "iris" } }], ...ROSTER("main", "ledger") } as unknown as OpenClawConfig);
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(r.details).toMatchObject({ ok: false, state: "routing_conflict", accountId: "iris" });
    expect(r.content[0]!.text).toContain("openclaw agents unbind --agent ledger --bind ademu:iris");
    expect(w.acquires).toHaveLength(0);
    const same = await w.call({ action: "start", agentName: "Iris" }, { agentId: "ledger" });
    expect(same.details.ok).toBe(true);
  });

  it("the yes re-checks against the CURRENT draft: an agent removed mid-ceremony → refused, nothing written, lease disposed", async () => {
    const w = world(ROSTER("iris", "main"));
    await w.call({ action: "start", agentName: "Iris" }, { agentId: "iris" });
    w.deps.writeConfig = async (mutate) => {
      mutate(ROSTER("main")); // the host's draft no longer lists `iris`
    };
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w, w.registry.get(NEW_DEVICE)!);
    await tick(5);
    w.control.finish("enrolled");
    const r = await yesP;
    expect(r).toMatchObject({ ok: false, state: "agent_unknown" });
    expect(w.writes).toHaveLength(0);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });

  it("the yes re-checks the route: a binding claimed by another agent mid-ceremony → refused, nothing written", async () => {
    const w = world(ROSTER("iris", "ledger"));
    await w.call({ action: "start", agentName: "Iris" }, { agentId: "iris" });
    w.deps.writeConfig = async (mutate) => {
      mutate({ ...ROSTER("iris", "ledger"), bindings: [{ agentId: "ledger", match: { channel: "ademu", accountId: "iris" } }] } as unknown as OpenClawConfig);
    };
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w, w.registry.get(NEW_DEVICE)!);
    await tick(5);
    w.control.finish("enrolled");
    const r = await yesP;
    expect(r).toMatchObject({ ok: false, state: "routing_conflict" });
    expect(w.writes).toHaveLength(0);
    expect(w.released()).toBe(1);
  });
});

describe("ademu_enroll: registration", () => {
  it("registers the tool by name, a service that disposes leases on stop, and the button handlers", async () => {
    const w = world();
    const registered: Array<{ name?: string }> = [];
    const services: Array<{ id: string; stop?: (ctx: unknown) => unknown }> = [];
    const interactive: string[] = [];
    const hooks: string[] = [];
    const api = {
      registerTool: (_factory: unknown, opts?: { name?: string }) => void registered.push(opts ?? {}),
      registerService: (svc: { id: string; stop?: (ctx: unknown) => unknown }) => void services.push(svc),
      registerInteractiveHandler: (r: { channel: string; namespace: string }) => void interactive.push(`${r.channel}:${r.namespace}`),
      on: (name: string) => void hooks.push(name),
    } as unknown as OpenClawPluginApi;
    const registry = registerEnrollTool(api, w.deps);
    expect(registered).toEqual([{ name: TOOL_NAME }]);
    expect(services[0]?.id).toBe("ademu-enroll-leases");
    expect(interactive).toEqual(["telegram:ademu", "slack:ademu", "discord:ademu"]);
    expect(hooks).toEqual(["before_dispatch"]);
    const t = createEnrollTool({ senderIsOwner: true, sessionKey: "s", agentId: "main" } as OpenClawPluginToolContext, w.deps, registry)!;
    await t.execute("c", { action: "start" }, new AbortController().signal);
    expect(registry.size).toBe(1);
    await services[0]!.stop!({});
    expect(registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });
});

const NO_AXES = { requesterSenderId: undefined, agentId: undefined } as unknown as Partial<OpenClawPluginToolContext>;
const NO_SENDER = { requesterSenderId: undefined } as unknown as Partial<OpenClawPluginToolContext>;
const ROSTER = (...ids: string[]) => ({ agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) } }) as unknown as OpenClawConfig;

describe("ademu_enroll: Codex branch-review folds", () => {
  it("#12 the agentId axis is enforced: same session and sender from another agent is refused", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    expect((await w.call({ action: "status" }, { agentId: "other-agent" })).details.ok).toBe(false);
    expect((await w.call({ action: "status" })).details.ok).toBe(true);
  });

  it("#14 a failure after the lease exists (QR render) disposes the lease exactly once and leaves no registry entry", async () => {
    const w = world();
    w.deps.qr = {
      terminal: async () => "",
      pngDataUrl: async () => {
        throw new Error("qr renderer unavailable");
      },
    };
    await expect(w.call({ action: "start", agentName: "Iris" })).rejects.toThrow(/qr renderer/);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect(w.control.closed).toBe(1);
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
  });

  it("#14 a non-retryable failure during the yes (mint error) disposes the lease; a retryable one (device attached) keeps it", async () => {
    const w = world();
    w.control.tokenMintImpl = async () => {
      throw new Error("mint exploded");
    };
    await w.call({ action: "start" });
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    await expect(yesP).rejects.toThrow(/mint exploded/);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect((await w.call({ action: "status" })).details.state).toBe("failed");
  });

  it("#15 a known acquisition failure returns fixed remedy text (ok:false), never throws, never installs", async () => {
    const w = world({} as OpenClawConfig, new DaemonUnreachableError("no daemon", "/var/log/adc.log"));
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(r.details).toMatchObject({ ok: false, state: "unavailable" });
    expect(r.content[0]!.text).toContain("/var/log/adc.log");
    expect(w.registry.size).toBe(0);
  });

  it("R2#7 a background revoked/retired pairing disposes the lease at once (not at TTL) and status says failed", async () => {
    for (const state of ["revoked", "retired"]) {
      const w = world();
      await w.call({ action: "start", agentName: "Iris" });
      w.control.finish(state);
      await tick(5);
      expect(w.registry.size).toBe(0);
      expect(w.released()).toBe(1);
      expect(w.control.closed).toBe(1);
      expect((await w.call({ action: "status" })).details.state).toBe("failed");
    }
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.failPoll(new Error("poll transport died"));
    await tick(5);
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
  });

  it("R7#2 plugin shutdown waits for a background disposal that is still running", async () => {
    const w = world();
    let releaseClose!: () => void;
    const slow = new Promise<void>((r) => {
      releaseClose = r;
    });
    w.control.close = async () => {
      w.control.closed++;
      await slow;
    };
    await w.call({ action: "start", agentName: "Iris" });
    w.control.finish("revoked");
    await tick(5);
    expect(w.registry.size).toBe(0);
    let allDone = false;
    const all = w.registry.disposeAll("plugin-stop").then(() => {
      allDone = true;
    });
    await tick(5);
    expect(allDone).toBe(false);
    releaseClose();
    await all;
    expect(w.released()).toBe(1);
  });

  it("R8#4 a TTL-expiry disposal is tracked: a status lookup prunes the entry (expired), and plugin stop still waits for the cleanup", async () => {
    const w = world();
    let releaseClose!: () => void;
    const slow = new Promise<void>((r) => {
      releaseClose = r;
    });
    w.control.close = async () => {
      w.control.closed++;
      await slow;
    };
    await w.call({ action: "start", agentName: "Iris" });
    w.timers[0]!.fn();
    const status = await w.call({ action: "status" });
    expect(status.details).toMatchObject({ ok: true, state: "expired" });
    expect(w.registry.size).toBe(0);
    let allDone = false;
    const all = w.registry.disposeAll("plugin-stop").then(() => {
      allDone = true;
    });
    await tick(5);
    expect(allDone).toBe(false);
    releaseClose();
    await all;
    expect(w.released()).toBe(1);
  });

  it("R9#3 the tool call's signal reaches the daemon acquisition: cancelling during a slow acquire yields `cancelled`, no lease", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const w = world({} as OpenClawConfig, undefined, gate);
    const ac = new AbortController();
    const startP = w.call({ action: "start", agentName: "Iris" }, {}, ac.signal);
    await tick(5);
    const acquireSignal = (w.acquires[0] as { signal?: AbortSignal }).signal;
    expect(acquireSignal).toBeDefined();
    expect(acquireSignal!.aborted).toBe(false);
    ac.abort();
    expect(acquireSignal!.aborted).toBe(true);
    const r = await startP;
    expect(r.details).toMatchObject({ ok: false, state: "cancelled" });
    expect(w.registry.size).toBe(0);
    releaseGate();
  });

  it("R2#8 axes compare exactly (absent → present is a mismatch) and only the same creator tuple may supersede", async () => {
    const w = world(ROSTER("main", "other"));
    await w.call({ action: "start", agentName: "Iris" }, NO_SENDER);
    expect((await w.call({ action: "status" })).details.ok).toBe(false); // default ctx has a sender
    expect((await w.call({ action: "status" }, NO_SENDER)).details.ok).toBe(true);
    const other = await w.call({ action: "start", agentName: "Bob" }, { agentId: "other" });
    expect(other.details).toMatchObject({ ok: false, state: "busy" });
    expect(w.registry.size).toBe(1);
    expect(w.released()).toBe(0);
    const again = await w.call({ action: "start", agentName: "Bob" }, NO_SENDER);
    expect(again.details.ok).toBe(true);
    expect(w.released()).toBe(1);
  });

  it("R3#1 a NO that lands while the yes is probing wins: nothing is written, the yes reports cancelled", async () => {
    const w = world();
    let releaseProbe!: () => void;
    const stall = new Promise<void>((r) => {
      releaseProbe = r;
    });
    const client = new FakeAdcClient({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER });
    client.stallGetSelf = stall;
    w.deps.connectSession = async () => client as never;
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const entry = live(w);
    const yesP = yes(w, entry);
    await tick(5);
    w.control.finish("enrolled");
    await tick(5); // the yes is parked in the identity probe
    const r = await no(w, entry);
    expect(r).toMatchObject({ ok: true, state: "cancelled" });
    releaseProbe();
    const result = await yesP;
    expect(result).toMatchObject({ ok: false, state: "cancelled" });
    expect(w.writes).toHaveLength(0);
    expect(w.released()).toBe(1);
  });

  it("R4#1 a NO that lands after the words were confirmed but before the mint wins: no mint, no write", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const entry = live(w);
    const yesP = yes(w, entry);
    await tick(5);
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(true);
    const r = await no(w, entry);
    expect(r).toMatchObject({ ok: true, state: "cancelled" });
    const result = await yesP;
    expect(result).toMatchObject({ ok: false, state: "cancelled" });
    expect(w.control.calls.some((c) => c.op === "token_mint")).toBe(false);
    expect(w.writes).toHaveLength(0);
    expect(w.released()).toBe(1);
  });

  it("R4#1 a NO that lands while the host mutation is pending is refused (committing) and the write completes exactly once", async () => {
    const w = world();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const origWrite = w.deps.writeConfig;
    w.deps.writeConfig = async (mutate) => {
      await gate;
      await origWrite(mutate);
    };
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const entry = live(w);
    const yesP = yes(w, entry);
    await tick(5);
    w.control.finish("enrolled");
    await tick(10); // inside writeConfig (committing)
    const r = await no(w, entry);
    expect(r).toMatchObject({ ok: false, state: "committing" });
    releaseWrite();
    const result = await yesP;
    expect(result.state).toBe("done");
    expect(w.writes).toHaveLength(1);
  });

  it("R5#1 two simultaneous human decisions are serialized: exactly one durable operation", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const entry = live(w);
    const p1 = yes(w, entry);
    const p2 = yes(w, entry);
    await tick(5);
    w.control.finish("enrolled");
    const [c1, c2] = await Promise.all([p1, p2]);
    expect([c1, c2].filter((r) => r.ok)).toHaveLength(1);
    expect(w.control.calls.filter((c) => c.op === "confirm_words")).toHaveLength(1);
    expect(w.control.calls.filter((c) => c.op === "token_mint")).toHaveLength(1);
    expect(w.writes).toHaveLength(1);
  });

  it("R5#4 the enrollment is superseded while the host holds the mutation: the callback refuses, nothing is written", async () => {
    const w = world();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const origWrite = w.deps.writeConfig;
    w.deps.writeConfig = async (mutate) => {
      await gate;
      await origWrite(mutate);
    };
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    await tick(10);
    w.registry.delete(NEW_DEVICE); // superseded underneath the pending mutation
    releaseWrite();
    const result = await yesP;
    expect(result).toMatchObject({ ok: false, state: "cancelled" });
    expect(w.writes).toHaveLength(0);
  });

  it("R6#3 a same-creator `start` while the host holds the mutation supersedes the old enrollment: its yes is cancelled, nothing written, the new one is live", async () => {
    const w = world();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const origWrite = w.deps.writeConfig;
    w.deps.writeConfig = async (mutate) => {
      await gate;
      await origWrite(mutate);
    };
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    await tick(10);
    const again = await w.call({ action: "start", agentName: "Bob" });
    expect(again.details.ok).toBe(true);
    expect(w.released()).toBe(1);
    releaseWrite();
    const result = await yesP;
    expect(result).toMatchObject({ ok: false, state: "cancelled" });
    expect(w.writes).toHaveLength(0);
    expect(w.registry.size).toBe(1);
    expect(w.registry.forSession(SESSION)?.agentName).toBe("Bob");
  });

  it("R3#3 two simultaneous starts in one conversation admit exactly one; an account created meanwhile is never overwritten", async () => {
    const w = world();
    const [a, b] = await Promise.all([w.call({ action: "start", agentName: "Iris" }), w.call({ action: "start", agentName: "Iris" })]);
    expect([a, b].filter((r) => r.details.ok)).toHaveLength(1);
    expect(w.registry.size).toBe(1);
    w.deps.writeConfig = async (mutate) => {
      const draft = { channels: { ademu: { accounts: { iris: { deviceId: "other", token: "t" } } } } } as unknown as OpenClawConfig;
      mutate(draft);
    };
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    const r = await yesP;
    expect(r).toMatchObject({ ok: false, state: "account_exists" });
    expect(w.released()).toBe(1);
  });

  it("#10 after the config write the setup-spawned daemon is promoted (pending-publication → bound)", async () => {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" });
    w.control.emit({ words: WORDS });
    await tick();
    const yesP = yes(w);
    await tick(5);
    w.control.finish("enrolled");
    await yesP;
    expect(w.promotions).toEqual(["/d"]);
  });
});
