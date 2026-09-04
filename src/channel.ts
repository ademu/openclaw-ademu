// The full channel plugin object (plan T10): setup base + gateway lifecycle + message/messaging/
// actions/heartbeat + security posture report + the setup wizard (T12). Host runtime pieces are
// pulled lazily from the runtime store so this module can be imported by tests without a gateway.
import { connect as connectSessionReal } from "@ademu/adc-client";
import { connect as connectControlReal } from "@ademu/adc-control";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { ademuMessageActions } from "./actions.js";
import type { ControlLike, EnrollmentLeaseDeps } from "./ceremony.js";
import { CHANNEL_ID, resolveAdemuAccount, type ResolvedAdemuAccount } from "./config.js";
import { clearAccountCredentials } from "./enroll-config.js";
import { startAccount, type StartAccountDeps } from "./monitor/index.js";
import type { RuntimeChannelSurface } from "./monitor/ingress.js";
import { realSessionDeps } from "./monitor/session.js";
import { ademuMessageAdapter, ademuMessaging, getLiveAccount, resolveConversationTarget, resolveOutboundAccountId } from "./outbound.js";
import { createQr } from "./qr.js";
import { getAdemuRuntime, getAdemuStore, getDaemonManager, getPluginSettings, tryGetAdemuRuntime } from "./runtime.js";
import { ademuSetupBase } from "./setup-plugin.js";
import { createAdemuSetupWizard, type WizardDeps } from "./setup-wizard.js";

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
    daemons: getDaemonManager(hostLog),
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
    daemons: getDaemonManager(hostLog),
    connectControl: async (socketPath) => (await connectControlReal({ socketPath })) as unknown as ControlLike,
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

/** The wizard is built lazily so importing this module never touches the daemon or the runtime. */
function lazyWizard(): ReturnType<typeof createAdemuSetupWizard> {
  let built: ReturnType<typeof createAdemuSetupWizard> | undefined;
  const get = () => (built ??= createAdemuSetupWizard(realWizardDeps()));
  return {
    channel: CHANNEL_ID,
    get status() {
      return get().status;
    },
    credentials: [],
    finalize: (params) => get().finalize!(params),
  };
}

export const ademuPlugin: ChannelPlugin<ResolvedAdemuAccount> = createChatChannelPlugin<ResolvedAdemuAccount>({
  base: {
    ...ademuSetupBase,
    setupWizard: lazyWizard(),
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
    heartbeat: {
      sendTyping: async ({ to, accountId }) => {
        const { client } = getLiveAccount(resolveOutboundAccountId(accountId));
        await client.sendTyping({ group_id: resolveConversationTarget(to), active: true });
      },
    },
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
