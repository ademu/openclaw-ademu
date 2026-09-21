// The channel lane: lane selection, the host-side pushes (built on a fake outbound batch sender), and
// the Yes/No button clicks arriving through the plugin interactive handler.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUTTON_CAPABLE_CHANNELS,
  CHANNEL_DATA_KEY,
  REPLY_CAPABLE_CHANNELS,
  createEnrollmentChannel,
  handleEnrollmentClick,
  pngBytesFromDataUrl,
  removeQrFile,
  INTERACTIVE_NAMESPACE,
  laneFor,
  registerEnrollmentButtons,
  routeFromContext,
  type SendBatch,
} from "../src/enrollment-channel.js";
import type { ActiveEnrollment } from "../src/tools/enroll.js";
import { WORDS } from "./fakes/control.js";
import { world } from "./fakes/enroll-world.js";

const cfg = {} as OpenClawConfig;
const REMOTE = { channels: { ademu: { enrollmentPage: { baseUrl: "https://gw.example.com" } } } } as unknown as OpenClawConfig;
const route = { channel: "telegram", to: "chat-1", accountId: "bot", threadId: 7 };
const NONCE = "a".repeat(24);

describe("enrollment channel: lane selection", () => {
  it("no route or a gateway surface → the page; buttons channels → push with buttons; others need a reachable page", () => {
    expect(laneFor(undefined, cfg)).toEqual({ kind: "page" });
    expect(laneFor({ channel: "webchat", to: "x" }, cfg)).toEqual({ kind: "page" });
    for (const channel of BUTTON_CAPABLE_CHANNELS) {
      expect(laneFor({ channel, to: "x" }, cfg)).toMatchObject({ kind: "push", buttons: true, pageReachable: false });
    }
    for (const channel of REPLY_CAPABLE_CHANNELS) {
      expect(laneFor({ channel, to: "x" }, cfg)).toMatchObject({ kind: "push", reply: true, pageReachable: false });
    }
    for (const channel of BUTTON_CAPABLE_CHANNELS) {
      expect(laneFor({ channel, to: "x" }, cfg)).toMatchObject({ kind: "push", buttons: true, reply: true });
    }
    expect(laneFor({ channel: "whatsapp", to: "x" }, cfg)).toMatchObject({ kind: "push", buttons: false, reply: true, pageReachable: false });
    // no buttons, no quoted replies, no reachable page → refused (fail closed, incl. unverified channels)
    for (const channel of ["irc", "sms", "line", "imessage", "msteams", "nostr"]) {
      expect(laneFor({ channel, to: "x" }, cfg)).toMatchObject({ kind: "unsupported", route: { channel } });
    }
    expect(laneFor({ channel: "irc", to: "x" }, REMOTE)).toMatchObject({ kind: "push", buttons: false, reply: false, pageReachable: true });
    expect(laneFor({ channel: "irc", to: "x" }, { gateway: { publicOrigin: "https://gw.example.com" } } as unknown as OpenClawConfig)).toMatchObject({ kind: "push", pageReachable: true });
    expect(BUTTON_CAPABLE_CHANNELS).toEqual(new Set(["telegram", "slack", "discord"]));
    expect(REPLY_CAPABLE_CHANNELS).toEqual(new Set(["whatsapp", "signal", "telegram", "slack", "discord", "matrix", "mattermost", "googlechat"]));
  });

  it("routeFromContext reads the trusted delivery context, lowercases the channel, and needs a recipient", () => {
    expect(routeFromContext({ deliveryContext: { channel: "Telegram", to: "c", accountId: "a", threadId: 3 } } as unknown as OpenClawPluginToolContext)).toEqual({
      channel: "telegram",
      to: "c",
      accountId: "a",
      threadId: 3,
    });
    expect(routeFromContext({ deliveryContext: { channel: "telegram" } } as unknown as OpenClawPluginToolContext)).toBeUndefined();
    expect(routeFromContext({} as OpenClawPluginToolContext)).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function artifactDir() {
  const d = mkdtempSync(join(tmpdir(), "ademu-qr-"));
  dirs.push(d);
  return d;
}
const readdirLength = (d: string) => readdirSync(d).length;
// a real 1x1 PNG, so the file written is a PNG and not a placeholder
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("enrollment channel: pushes", () => {
  function sender(status = "sent", extra: { results?: Array<{ messageId?: string }>; receipt?: { primaryPlatformMessageId?: string } } = {}, dir = artifactDir()) {
    const sent: Array<Parameters<SendBatch>[0]> = [];
    const sendBatch: SendBatch = async (p) => {
      sent.push(p);
      return { status, ...extra };
    };
    return { sent, dir, channel: createEnrollmentChannel(sendBatch, { artifactDir: dir }) };
  }

  it("the QR goes out as a private PNG FILE under the artifact dir (hosts refuse data: URLs), with a localRoots grant, the exact link in the caption, marked as ours", async () => {
    const { sent, dir, channel } = sender();
    const out = await channel.pushQr({ cfg, route, agentName: "Iris", dataUrl: PNG_DATA_URL, link: "ademu://agent-enroll?x=1", pageUrl: undefined });
    expect(out).toMatchObject({ ok: true, imageSent: true, reason: undefined });
    expect(out.filePath).toMatch(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/enroll-[a-f0-9]{16}\.png$`));
    expect(existsSync(out.filePath!)).toBe(true);
    expect(readFileSync(out.filePath!).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ cfg, channel: "telegram", to: "chat-1", accountId: "bot", threadId: 7, mediaAccess: { localRoots: [dir] } });
    const payload = sent[0]!.payloads[0]!;
    expect(payload.mediaUrl).toBe(out.filePath);
    expect(payload.text).toContain("Iris");
    expect(payload.text).toContain("ademu://agent-enroll?x=1");
    expect(payload.text).not.toContain("http");
    expect(payload.text).not.toContain("could not be attached");
    expect(payload.channelData).toEqual({ [CHANNEL_DATA_KEY]: true });
    expect(payload.presentation).toBeUndefined();
    // the ceremony's end removes the file; a second removal is harmless
    await removeQrFile(out.filePath);
    expect(existsSync(out.filePath!)).toBe(false);
    await removeQrFile(out.filePath);
    await removeQrFile(undefined);
  });

  it("when the image is refused, the caption with the link is sent alone, the file is removed, and the refusal is the reason", async () => {
    const dir = artifactDir();
    const sent: Array<Parameters<SendBatch>[0]> = [];
    const sendBatch: SendBatch = async (p) => {
      sent.push(p);
      return p.mediaAccess ? { status: "failed", stage: "platform_send", error: new Error("data: URLs are not supported for media") } : { status: "sent", results: [{ messageId: "t-1" }] };
    };
    const channel = createEnrollmentChannel(sendBatch, { artifactDir: dir });
    const out = await channel.pushQr({ cfg, route, agentName: "Iris", dataUrl: PNG_DATA_URL, link: "ademu://agent-enroll?x=1" });
    expect(out).toMatchObject({ ok: true, imageSent: false, filePath: undefined, messageId: "t-1" });
    expect(out.reason).toContain("data: URLs are not supported");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payloads[0]!.mediaUrl).toBeUndefined();
    expect(sent[1]!.payloads[0]!.text).toContain("ademu://agent-enroll?x=1");
    expect(sent[1]!.payloads[0]!.text).toContain("could not be attached");
    expect(existsSync(join(dir))).toBe(true);
    expect(readdirLength(dir)).toBe(0); // the refused image file was removed
  });

  it("when even the text-only caption fails, the push fails with both reasons", async () => {
    const { channel } = sender("failed", { error: new Error("no such chat") } as never);
    const out = await channel.pushQr({ cfg, route, agentName: "Iris", dataUrl: PNG_DATA_URL, link: "l" });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("no such chat");
    expect(out.reason).toContain("image:");
  });

  it("an unusable data URL means no file: the caption still goes out and says the image is missing", async () => {
    const { sent, channel } = sender("sent");
    const out = await channel.pushQr({ cfg, route, agentName: "Iris", dataUrl: "data:text/plain;base64,QUJD", link: "l" });
    expect(out).toMatchObject({ ok: true, imageSent: false, filePath: undefined });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mediaAccess).toBeUndefined();
    expect(pngBytesFromDataUrl("data:text/plain;base64,QUJD")).toBeUndefined();
    expect(pngBytesFromDataUrl(PNG_DATA_URL)!.subarray(1, 4).toString()).toBe("PNG");
  });

  it("the words carry Yes/No buttons with namespaced callbacks on button channels, a reply invitation on quoting channels, and the page link elsewhere", async () => {
    const { sent, channel } = sender();
    await channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: true, reply: true, pageUrl: undefined });
    const withButtons = sent[0]!.payloads[0]!;
    expect(withButtons.text).toContain(WORDS.join("   "));
    expect(withButtons.text).toContain("tap Yes");
    expect(withButtons.text).toContain("reply to this message with yes or no");
    expect(withButtons.text).not.toContain("http");
    const blocks = (withButtons.presentation as { blocks: Array<{ type: string; buttons: Array<{ label: string; action: { type: string; value: string } }> }> }).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("buttons");
    expect(blocks[0]!.buttons.map((b) => b.action)).toEqual([
      { type: "callback", value: `${INTERACTIVE_NAMESPACE}:yes:${NONCE}` },
      { type: "callback", value: `${INTERACTIVE_NAMESPACE}:no:${NONCE}` },
    ]);
    for (const b of blocks[0]!.buttons) {
      expect(b.label).not.toMatch(/\bpair/i);
      expect(b.action.value.length).toBeLessThanOrEqual(64); // Telegram's callback-data cap
    }

    await channel.pushWords({ cfg, route: { channel: "whatsapp", to: "+1" }, words: WORDS, nonce: NONCE, buttons: false, reply: true, pageUrl: "https://gw.example.com/plugins/ademu/enroll/t" });
    const withLink = sent[1]!.payloads[0]!;
    expect(withLink.presentation).toBeUndefined();
    expect(withLink.text).toContain("reply to this message with yes or no");
    expect(withLink.text).toContain("https://gw.example.com/plugins/ademu/enroll/t");

    await channel.pushWords({ cfg, route: { channel: "whatsapp", to: "+1" }, words: WORDS, nonce: NONCE, buttons: false, reply: true, pageUrl: undefined });
    const replyOnly = sent[2]!.payloads[0]!;
    expect(replyOnly.text).toContain("reply to this message with yes or no");
    expect(replyOnly.text).not.toContain("tap Yes");
    expect(replyOnly.text).not.toContain("http");
  });

  it("pushWords resolves the words message's platform id: the receipt's primary id first, else the first result id", async () => {
    const primary = sender("sent", { results: [{ messageId: "r-1" }, { messageId: "r-2" }], receipt: { primaryPlatformMessageId: "p-1" } });
    expect(await primary.channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).toEqual({ ok: true, messageId: "p-1" });
    const results = sender("sent", { results: [{}, { messageId: "r-2" }] });
    expect(await results.channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).toEqual({ ok: true, messageId: "r-2" });
    const none = sender("sent");
    expect(await none.channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).toEqual({ ok: true, messageId: undefined });
    const failed = sender("failed", { receipt: { primaryPlatformMessageId: "p-1" } });
    expect(await failed.channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).toEqual({ ok: false, messageId: undefined, reason: "status=failed" });
  });

  it("a failed push carries a payload-free reason: the host's status/stage/error, or the thrown error's class", async () => {
    const staged = sender("failed", { stage: "platform_send", error: new TypeError("channel telegram has no outbound adapter") } as never);
    expect((await staged.channel.pushText({ cfg, route, text: "x" })).valueOf()).toBe(false);
    expect((await staged.channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).reason).toBe("status=failed; stage=platform_send; TypeError: channel telegram has no outbound adapter");
    const throwing = createEnrollmentChannel(
      async () => {
        throw new RangeError("bad params");
      },
      { artifactDir: artifactDir() },
    );
    expect((await throwing.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).reason).toBe("status=threw; RangeError: bad params");
    const suppressed = sender("suppressed", { reason: "quiet_hours" } as never);
    expect((await suppressed.channel.pushWords({ cfg, route, words: WORDS, nonce: NONCE, buttons: false, reply: true })).reason).toBe("status=suppressed; reason=quiet_hours");
  });

  it("a non-sent batch status or a throwing sender is reported as not delivered, never thrown", async () => {
    expect(await sender("failed").channel.pushText({ cfg, route, text: "x" })).toBe(false);
    expect(await sender("partial_failed").channel.pushText({ cfg, route, text: "x" })).toBe(false);
    const throwing = createEnrollmentChannel(
      async () => {
        throw new Error("no such channel");
      },
      { artifactDir: artifactDir() },
    );
    expect(await throwing.pushText({ cfg, route, text: "x" })).toBe(false);
  });
});

describe("enrollment channel: button clicks", () => {
  type Click = { payload?: unknown; senderId?: string; authorized?: boolean; slack?: boolean };
  function ctx(c: Click) {
    const replies: string[] = [];
    let cleared = 0;
    const respond = {
      reply: async (t: string) => void replies.push(t),
      ...(c.slack ? { acknowledge: async () => {}, clearComponents: async () => void cleared++ } : { clearButtons: async () => void cleared++ }),
    };
    const raw = {
      ...(c.slack ? { interaction: { payload: c.payload } } : { callback: { payload: c.payload } }),
      senderId: c.senderId,
      auth: { isAuthorizedSender: c.authorized ?? true },
      respond,
    };
    return { raw, replies, cleared: () => cleared };
  }
  async function started() {
    const w = world();
    await w.call({ action: "start", agentName: "Iris" }, { deliveryContext: { channel: "telegram", to: "c" } } as unknown as Partial<OpenClawPluginToolContext>);
    const entry = w.registry.forSession("agent:main:webchat:owner")!;
    const decisions: string[] = [];
    const deps = {
      registry: w.registry,
      confirm: async (a: ActiveEnrollment) => {
        decisions.push(`yes:${a.deviceId}`);
        return { ok: true, state: "done", message: "Enrolled — Iris is on Ademú now." };
      },
      cancel: async (a: ActiveEnrollment) => {
        decisions.push(`no:${a.deviceId}`);
        return { ok: true, state: "cancelled", message: "Enrollment cancelled; nothing was written." };
      },
    };
    return { w, entry, deps, decisions };
  }

  it("a yes from the requester runs the confirm path once, clears the buttons, and replies with the outcome", async () => {
    const { entry, deps, decisions } = await started();
    const c = ctx({ payload: `yes:${entry.nonce}`, senderId: "owner-1" });
    expect(await handleEnrollmentClick(c.raw, deps)).toEqual({ handled: true });
    expect(decisions).toEqual([`yes:${entry.deviceId}`]);
    expect(c.cleared()).toBe(1);
    expect(c.replies).toEqual(["Enrolled — Iris is on Ademú now."]);
  });

  it("a no from the requester runs the cancel path (slack-shaped context)", async () => {
    const { entry, deps, decisions } = await started();
    const c = ctx({ payload: `no:${entry.nonce}`, senderId: "owner-1", slack: true });
    expect(await handleEnrollmentClick(c.raw, deps)).toEqual({ handled: true });
    expect(decisions).toEqual([`no:${entry.deviceId}`]);
    expect(c.cleared()).toBe(1);
    expect(c.replies[0]).toContain("cancelled");
  });

  it("another sender, an unauthorized sender, or a stale nonce decide nothing", async () => {
    const { entry, deps, decisions } = await started();
    const other = ctx({ payload: `yes:${entry.nonce}`, senderId: "someone-else" });
    await handleEnrollmentClick(other.raw, deps);
    expect(other.replies[0]).toContain("Only the person who started");
    const unauthorized = ctx({ payload: `yes:${entry.nonce}`, senderId: "owner-1", authorized: false });
    await handleEnrollmentClick(unauthorized.raw, deps);
    expect(unauthorized.replies[0]).toContain("Only the person who started");
    const stale = ctx({ payload: `yes:${"f".repeat(24)}`, senderId: "owner-1" });
    await handleEnrollmentClick(stale.raw, deps);
    expect(stale.replies[0]).toContain("no longer active");
    expect(decisions).toEqual([]);
  });

  it("payloads that are not ours are left to other handlers", async () => {
    const { deps } = await started();
    expect(await handleEnrollmentClick({ callback: { payload: "model:pick:1" } }, deps)).toEqual({ handled: false });
    expect(await handleEnrollmentClick({ callback: { payload: "yes:not-hex" } }, deps)).toEqual({ handled: false });
    expect(await handleEnrollmentClick({}, deps)).toEqual({ handled: false });
    expect(await handleEnrollmentClick(undefined, deps)).toEqual({ handled: false });
  });

  it("registers one handler per button channel under the ademu namespace", () => {
    const seen: string[] = [];
    const api = { registerInteractiveHandler: (r: { channel: string; namespace: string }) => void seen.push(`${r.channel}:${r.namespace}`) } as unknown as OpenClawPluginApi;
    const { registry } = world();
    registerEnrollmentButtons(api, { registry, confirm: async () => ({ ok: true, state: "done", message: "" }), cancel: async () => ({ ok: true, state: "cancelled", message: "" }) });
    expect(seen).toEqual(["telegram:ademu", "slack:ademu", "discord:ademu"]);
  });
});
