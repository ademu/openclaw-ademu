// The `ademu_enroll` tool's test world, shared by the tool tests and the enrollment-page tests: a
// scripted FakeControl, a fake daemon lease/manager, synchronous fake timers, a fake AdcClient, a QR
// stub, a config capture and a browser-open spy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { EnrollmentLeaseDeps } from "../../src/ceremony.js";
import { DaemonAbortedError, type DaemonManager, type Lease } from "../../src/monitor/daemon.js";
import type { EnrollmentChannel } from "../../src/enrollment-channel.js";
import { createEnrollTool, EnrollmentRegistry, type EnrollToolDeps } from "../../src/tools/enroll.js";
import { FakeAdcClient, OWNER } from "./adc.js";
import { FakeControl, NEW_AGENT, NEW_DEVICE } from "./control.js";

export const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));
/** Platform id the fake channel assigns to the pushed words message (what a quoted reply points at). */
export const WORDS_MESSAGE_ID = "m-words-1";

export function world(cfg: OpenClawConfig = {} as OpenClawConfig, acquireError?: unknown, acquireGate?: Promise<void>) {
  const control = new FakeControl();
  let released = 0;
  const daemonLease: Lease = {
    mode: "owned",
    role: "setup",
    identity: { dataDir: "/d" } as never,
    holderId: "h",
    info: { controlSocketPath: "/d/adc.sock", sessionSocketPath: "/d/adc-session.sock" },
    lost: new Promise<never>(() => {}),
    release: async () => void released++,
  };
  const acquires: unknown[] = [];
  const promotions: string[] = [];
  const daemons = {
    acquire: async (p: unknown) => {
      acquires.push(p);
      if (acquireError) throw acquireError;
      const signal = (p as { signal?: AbortSignal }).signal;
      if (acquireGate) {
        await Promise.race([
          acquireGate,
          new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DaemonAbortedError()), { once: true })),
        ]);
      }
      return daemonLease;
    },
    promotePendingPublication: (dataDir: string) => {
      promotions.push(dataDir);
      return true;
    },
  } as unknown as DaemonManager;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const lease: EnrollmentLeaseDeps = {
    daemons,
    connectControl: async () => control,
    now: () => 0,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  };
  const client = new FakeAdcClient({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER });
  const writes: OpenClawConfig[] = [];
  const opens: string[] = [];
  /** Every host-side push the ceremony made into the conversation (media-channel lane). */
  const pushes: Array<Record<string, unknown> & { kind: "qr" | "words" | "text" }> = [];
  const pushOk = { value: true };
  const channel: EnrollmentChannel = {
    pushQr: async (p) => {
      pushes.push({ kind: "qr", route: p.route, agentName: p.agentName, dataUrl: p.dataUrl, link: p.link, pageUrl: p.pageUrl });
      return { ok: pushOk.value, messageId: pushOk.value ? "m-qr-1" : undefined, reason: pushOk.value ? undefined : "status=failed; stage=platform_send; Error: fake refusal", imageSent: pushOk.value, filePath: pushOk.value ? "/tmp/fake-qr.png" : undefined };
    },
    pushWords: async (p) => {
      pushes.push({ kind: "words", route: p.route, words: p.words, nonce: p.nonce, buttons: p.buttons, reply: p.reply, pageUrl: p.pageUrl });
      return { ok: pushOk.value, messageId: pushOk.value ? WORDS_MESSAGE_ID : undefined, reason: pushOk.value ? undefined : "status=failed" };
    },
    pushText: async (p) => {
      pushes.push({ kind: "text", route: p.route, text: p.text });
      return pushOk.value;
    },
  };
  let current = cfg;
  const deps: EnrollToolDeps = {
    lease,
    connectSession: async () => client as never,
    qr: { terminal: async () => "", pngDataUrl: async () => "data:image/png;base64,QUJD" },
    writeConfig: async (mutate) => {
      current = mutate(current);
      writes.push(current);
    },
    openUrl: async (url) => {
      opens.push(url);
      return true;
    },
    channel,
  };
  const registry = new EnrollmentRegistry();
  const ctx = (over: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext => ({
    senderIsOwner: true,
    sessionKey: "agent:main:webchat:owner",
    requesterSenderId: "owner-1",
    agentId: "main",
    runtimeConfig: current,
    ...over,
  });
  const tool = (over: Partial<OpenClawPluginToolContext> = {}) => createEnrollTool(ctx(over), deps, registry)!;
  const signal = new AbortController().signal;
  const call = async (args: Record<string, unknown>, over: Partial<OpenClawPluginToolContext> = {}, sig: AbortSignal | undefined = signal) =>
    tool(over).execute("call-1", args, sig);
  return { control, deps, registry, tool, call, writes, opens, pushes, pushOk, acquires, promotions, released: () => released, timers, current: () => current };
}
