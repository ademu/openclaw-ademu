// The setup-only plugin surface (plan T10/T12): everything the lightweight `setupEntry` needs —
// meta, capabilities, config adapter + schema, secrets, reload prefixes, status — and nothing that
// touches the daemon or a session. `channel.ts` spreads this and adds the runtime surfaces.
import type { ChannelStatusAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import { ademuConfigAdapter, ademuConfigSchema, CHANNEL_ID, type ResolvedAdemuAccount } from "./config.js";
import { strings } from "./i18n/strings.js";
import { channelSecrets } from "./secrets.js";
import { ademuWizardStatus, createAdemuSetupWizard } from "./setup-wizard.js";

/**
 * The enrollment wizard, built lazily: OpenClaw loads the SETUP entry for an unconfigured plugin
 * (`openclaw channels add`), so the wizard must be reachable from here — while the daemon manager,
 * store and host runtime it needs are only touched inside `finalize` (dynamic import keeps the
 * setup entry free of the runtime module graph until then).
 */
export function lazyAdemuSetupWizard(): ChannelSetupWizard {
  let built: ChannelSetupWizard | undefined;
  const get = async () => (built ??= createAdemuSetupWizard((await import("./channel.js")).realWizardDeps()));
  return {
    channel: CHANNEL_ID,
    status: ademuWizardStatus,
    credentials: [],
    finalize: async (params) => (await get()).finalize!(params),
  };
}

export const ademuMeta: ChannelPlugin["meta"] = {
  id: CHANNEL_ID,
  label: strings.channelLabel,
  selectionLabel: "Ademú (end-to-end encrypted)",
  detailLabel: "Ademú agent device",
  docsPath: "/channels/ademu",
  docsLabel: "ademu",
  blurb: strings.channelBlurb,
  order: 95,
};

export const ademuCapabilities: ChannelPlugin["capabilities"] = {
  chatTypes: ["direct", "group"],
  reactions: true,
  media: false,
  threads: false,
  edit: false,
  unsend: false,
  reply: false,
  effects: false,
  blockStreaming: false,
};

export function accountStatusState(account: ResolvedAdemuAccount): "disabled" | "configured" | "unconfigured" | "misconfigured" {
  if (!account.enabled) return "disabled";
  if (account.configError) return "misconfigured";
  return account.configured ? "configured" : "unconfigured";
}

export const ademuStatus: ChannelStatusAdapter<ResolvedAdemuAccount> = {
  defaultRuntime: { accountId: "default", running: false, lastStartAt: null, lastStopAt: null, lastError: null },
  buildAccountSnapshot: ({ account, runtime }) => ({
    ...(runtime ?? {}),
    accountId: account.accountId,
    name: account.agentName,
    enabled: account.enabled,
    configured: account.configured,
    statusState: accountStatusState(account),
    ...(account.configError ? { lastError: account.configError } : {}),
  }),
};

/** Shared base of both entries; the runtime entry extends it. */
export const ademuSetupBase = {
  id: CHANNEL_ID,
  meta: ademuMeta,
  capabilities: ademuCapabilities,
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: ademuConfigAdapter,
  configSchema: ademuConfigSchema,
  secrets: channelSecrets,
  status: ademuStatus,
  setupWizard: lazyAdemuSetupWizard(),
} satisfies Partial<ChannelPlugin<ResolvedAdemuAccount>>;

export const ademuSetupPlugin: ChannelPlugin<ResolvedAdemuAccount> = { ...ademuSetupBase };
