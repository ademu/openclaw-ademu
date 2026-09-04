// The full channel plugin object (plan T10): setup base + gateway lifecycle + message/messaging/
// actions/heartbeat + security posture report. Host runtime pieces are pulled lazily from the runtime
// store so this module can be imported by tests without a gateway.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { ademuMessageActions } from "./actions.js";
import { CHANNEL_ID, resolveAdemuAccount, type ResolvedAdemuAccount } from "./config.js";
import { startAccount, type StartAccountDeps } from "./monitor/index.js";
import type { RuntimeChannelSurface } from "./monitor/ingress.js";
import { realSessionDeps } from "./monitor/session.js";
import { ademuMessageAdapter, ademuMessaging, getLiveAccount, resolveConversationTarget, resolveOutboundAccountId } from "./outbound.js";
import { getAdemuRuntime, getAdemuStore, getDaemonManager, getPluginSettings } from "./runtime.js";
import { ademuSetupBase } from "./setup-plugin.js";

/** Structured, closed-allowlist log line through the host logger (never secrets, never `.detail`). */
export function hostLog(event: string, fields?: Record<string, string | number | boolean>): void {
  const runtime = getAdemuRuntime();
  const logger = runtime.logging.getChildLogger({ plugin: CHANNEL_ID });
  logger.info(event, fields ?? {});
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

export const ademuPlugin: ChannelPlugin<ResolvedAdemuAccount> = createChatChannelPlugin<ResolvedAdemuAccount>({
  base: {
    ...ademuSetupBase,
    gateway: {
      startAccount: async (ctx) => {
        await startAccount(ctx, realStartAccountDeps());
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
