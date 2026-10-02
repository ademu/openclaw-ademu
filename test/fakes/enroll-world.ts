// The `ademu_enroll` tool's test world, shared by the tool tests and the enrollment-page tests: a
// scripted FakeControl, a fake daemon attachment/attacher, synchronous fake timers, a fake AdcClient, a QR
// stub, a config capture and a browser-open spy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { EnrollmentLeaseDeps } from "../../src/ceremony.js";
import { DaemonAbortedError, type Attacher, type Attachment } from "../../src/monitor/attach.js";
import { createEnrollTool, EnrollmentRegistry, type EnrollToolDeps } from "../../src/tools/enroll.js";
import { FakeAdcClient, OWNER } from "./adc.js";
import { FakeControl, NEW_AGENT, NEW_DEVICE } from "./control.js";

export const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));

export function world(cfg: OpenClawConfig = {} as OpenClawConfig, acquireError?: unknown, acquireGate?: Promise<void>) {
  const control = new FakeControl();
  let released = 0;
  const attachment: Attachment = {
    role: "setup",
    identity: {
      dataDir: "/d",
      raw: { dataDir: "/d", controlSocket: "/d/adc.sock", sessionSocket: "/d/adc-session.sock", enrollSocket: "/d/adc-enroll.sock" },
      explicit: { dataDir: true, socketPath: false, enrollSocketPath: false },
      scope: "user",
    } as never,
    info: { enrollSocketPath: "/d/adc-enroll.sock", sessionSocketPath: "/d/adc-session.sock" },
    release: async () => void released++,
  };
  const acquires: unknown[] = [];
  const attacher = {
    attach: async (p: unknown) => {
      acquires.push(p);
      if (acquireError) throw acquireError;
      const signal = (p as { signal?: AbortSignal }).signal;
      if (acquireGate) {
        await Promise.race([
          acquireGate,
          new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DaemonAbortedError()), { once: true })),
        ]);
      }
      return attachment;
    },
    resolveSessionSocket: async () => attachment.info.sessionSocketPath,
  } satisfies Attacher;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const lease: EnrollmentLeaseDeps = {
    attacher,
    connectEnroll: async () => control,
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
    pageListening: async () => true,
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
  return { control, deps, registry, tool, call, writes, opens, acquires, released: () => released, timers, current: () => current };
}
