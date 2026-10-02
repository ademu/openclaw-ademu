// The full channel plugin object (plan T10): setup base + gateway lifecycle + message/messaging/
// actions/heartbeat + security posture report + the setup wizard (T12). Host runtime pieces are
// pulled lazily from the runtime store so this module can be imported by tests without a gateway.
import { connect as connectSessionReal } from "@ademu/adc-client";
import { connectEnroll as connectEnrollReal } from "@ademu/adc-control";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { ademuMessageActions } from "./actions.js";
import type { ControlLike, EnrollmentLeaseDeps } from "./ceremony.js";
import { CHANNEL_ID, resolveAdemuAccount, type ResolvedAdemuAccount } from "./config.js";
import { clearAccountCredentials } from "./enroll-config.js";
import { startAccount, type StartAccountDeps } from "./monitor/index.js";
import type { RuntimeChannelSurface } from "./monitor/ingress.js";
import { realSessionDeps } from "./monitor/session.js";
import { ademuMessageAdapter, ademuMessaging } from "./outbound.js";
import { createQr } from "./qr.js";
import { getAdemuRuntime, getAdemuStore, getDaemonAttacher, getPluginSettings, tryGetAdemuRuntime } from "./runtime.js";
import { ademuSetupBase } from "./setup-plugin.js";
import type { WizardDeps } from "./setup-wizard.js";

/** Structured, closed-allowlist log line through the host logger (never secrets, never `.detail`). */
export function hostLog(event: string, fields?: Record<string, string | number | boolean>): void {
  const runtime = tryGetAdemuRuntime();
  if (!runtime) return; // setup-only process (CLI wizard): no host logger, nothing to say
  runtime.logging.getChildLogger({ plugin: CHANNEL_ID }).info(event, fields ?? {});
}

export function realStartAccountDeps(): StartAccountDeps {
  const runtime = getAdemuRuntime();
  return {
    store: getAdemuStore(),
    attacher: getDaemonAttacher(hostLog),
    session: realSessionDeps(hostLog),
    runtime: runtime.channel as unknown as RuntimeChannelSurface,
    settings: getPluginSettings(),
    platform: process.platform,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: hostLog,
  };
}

export function realEnrollmentLeaseDeps(): EnrollmentLeaseDeps {
  return {
    // Lazy: tool discovery / inspect builds nothing (Codex #18).
    get attacher() {
      return getDaemonAttacher(hostLog);
    },
    connectEnroll: async (socketPath) => (await connectEnrollReal({ socketPath })) as unknown as ControlLike,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

export function realWizardDeps(): WizardDeps {
  return {
    lease: realEnrollmentLeaseDeps(),
    connectSession: connectSessionReal,
    qr: createQr(tryGetAdemuRuntime()),
  };
}

export const ademuPlugin: ChannelPlugin<ResolvedAdemuAccount> = createChatChannelPlugin<ResolvedAdemuAccount>({
  base: {
    ...ademuSetupBase,
    gateway: {
      startAccount: async (ctx) => {
        await startAccount(ctx, realStartAccountDeps());
      },
      // R3 Rider B: forget this account's credentials and prune its owner entry (token stays valid
      // daemon-side until `adc token revoke`).
      logoutAccount: async ({ accountId }) => {
        const runtime = getAdemuRuntime();
        await runtime.config.mutateConfigFile({
          base: "runtime",
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            Object.assign(draft, clearAccountCredentials(draft, accountId));
          },
        });
        return { cleared: true, loggedOut: true, note: "The device token stays valid until `adc token revoke`." };
      },
    },
    message: ademuMessageAdapter,
    messaging: ademuMessaging,
    actions: ademuMessageActions,
    // No `heartbeat.sendTyping` (owner decision 2026-09-26, AdemuMLS#621): OpenClaw shows typing at the
    // START of a heartbeat run, before it knows whether the run will say anything, and almost every run
    // ends in NO_REPLY — on Ademú that is a bubble that leads nowhere. Heartbeats stay invisible unless
    // they produce a message; reply typing (the ingress pipeline's keepalive) is unaffected.
  },
  security: {
    // Doctor/status report only (V3): the runtime gate is the ingress resolver with allowFrom=[owner].
    resolveDmPolicy: ({ cfg, accountId }) => {
      const account = resolveAdemuAccount(cfg, accountId);
      return {
        policy: "allowlist",
        allowFrom: account.ownerUserId ? [account.ownerUserId] : [],
        allowFromPath: `channels.${CHANNEL_ID}.accounts.${account.accountId}.ownerUserId`,
        approveHint: "The owner is the Ademú account that enrolled this agent: openclaw channels add --channel ademu",
      };
    },
  },
});
