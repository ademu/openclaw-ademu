// The chat-channel lane of the enrollment ceremony: on a media channel (Telegram, WhatsApp, Slack,
// Discord, …) the plugin itself pushes the QR code + exact link into the conversation, later the four
// safety words — with Yes/No buttons where the channel dispatches plugin interactive handlers — and
// finally the outcome. The model is never the courier: it only tells the user to look at what arrived.
//
// Delivery goes through the host's outbound batch sender (`sendDurableMessageBatch`, public
// `channel-outbound` subpath), never through the tool call's `delivery` handle (that one dies when the
// `start` turn closes, and the words arrive minutes later). Its result is a status, not an exception.
//
// Buttons exist only where OpenClaw routes button clicks to plugins: telegram, slack, discord (the only
// channel extensions with an interactive dispatcher in 2026.9.1). Everywhere else the words message
// carries a link to the enrollment page instead, which requires the page to be reachable from the
// user's browser (`channels.ademu.enrollmentPage.baseUrl` or `gateway.publicOrigin`). A channel with
// neither cannot complete an enrollment; `start` refuses before creating anything.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawPluginApi, OpenClawPluginToolContext, ReplyPayload } from "openclaw/plugin-sdk/core";
import { isEnrollmentPageRemotelyReachable } from "./enrollment-page.js";
import { strings } from "./i18n/strings.js";
import type { ActiveEnrollment, EnrollmentRegistry } from "./tools/enroll.js";

/** Channels whose button clicks reach plugin interactive handlers (OpenClaw 2026.9.1). */
export const BUTTON_CAPABLE_CHANNELS: ReadonlySet<string> = new Set(["telegram", "slack", "discord"]);
/**
 * Channels whose INBOUND messages carry the quoted message's platform id (`replyToId`), so a quoted
 * "yes"/"no" reply to the words message can be recognized (src/enrollment-reply.ts). Verified against
 * OpenClaw 2026.9.1 extension sources; fail closed — a channel is added here only after a live check
 * shows the quoted id arriving on inbound. Not (yet) included: imessage, irc, nextcloud-talk, feishu,
 * buzz, tlon, clickclack (quoted id seen on the outbound side only), msteams (quoted id for channel
 * posts only, never direct/group chats). No quote support at all: line, sms, nostr, synology-chat,
 * twitch, zalo, zalouser, a2a, raft.
 */
export const REPLY_CAPABLE_CHANNELS: ReadonlySet<string> = new Set(["whatsapp", "signal", "telegram", "slack", "discord", "matrix", "mattermost", "googlechat"]);
/** Gateway surfaces: the client renders the tool result itself and there is no outbound channel to push into. */
const GATEWAY_SURFACES: ReadonlySet<string> = new Set(["webchat", "tui", "cli", "control-ui", "ui", "gateway"]);
/** Namespace prefix of our callback values (`ademu:yes:<nonce>`); the host splits at the first colon. */
export const INTERACTIVE_NAMESPACE = "ademu";
/** `newNonce()` in the tool: 12 random bytes, lowercase hex. */
const NONCE_RE = /^[a-f0-9]{24}$/;
/** Marker so our own pushes are recognizable in channel data (never decorated or logged). */
export const CHANNEL_DATA_KEY = "ademuEnrollment";

export type EnrollmentRoute = { channel: string; to: string; accountId?: string | undefined; threadId?: string | number | undefined };

/** The conversation the tool call came from, when it is a real outbound channel route. */
export function routeFromContext(ctx: OpenClawPluginToolContext): EnrollmentRoute | undefined {
  const dc = ctx.deliveryContext as { channel?: string; to?: string; accountId?: string; threadId?: string | number } | undefined;
  const channel = (dc?.channel ?? ctx.messageChannel ?? "").trim().toLowerCase();
  if (!channel || !dc?.to) return undefined;
  return { channel, to: dc.to, accountId: dc.accountId, threadId: dc.threadId };
}

export type Lane =
  | { kind: "page" }
  | { kind: "push"; route: EnrollmentRoute; buttons: boolean; reply: boolean; pageReachable: boolean }
  | { kind: "unsupported"; route: EnrollmentRoute };

/** Where the user will see the QR and press yes/no — decided BEFORE any device exists. */
export function laneFor(route: EnrollmentRoute | undefined, cfg: OpenClawConfig): Lane {
  if (!route || GATEWAY_SURFACES.has(route.channel)) return { kind: "page" };
  const buttons = BUTTON_CAPABLE_CHANNELS.has(route.channel);
  const reply = REPLY_CAPABLE_CHANNELS.has(route.channel);
  const pageReachable = isEnrollmentPageRemotelyReachable(cfg);
  if (!buttons && !reply && !pageReachable) return { kind: "unsupported", route };
  return { kind: "push", route, buttons, reply, pageReachable };
}

/** The host's outbound batch sender, narrowed to what the ceremony needs; the result is a status. */
export type SendBatch = (params: {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  accountId?: string | undefined;
  threadId?: string | number | undefined;
  payloads: ReplyPayload[];
}) => Promise<{ status: string; results?: Array<{ messageId?: string }>; receipt?: { primaryPlatformMessageId?: string } }>;

export type EnrollmentChannel = {
  /** The QR (data URL) + exact link, sent by the plugin. Resolves whether the host accepted the batch. */
  pushQr: (p: { cfg: OpenClawConfig; route: EnrollmentRoute; agentName: string; dataUrl: string; link: string; pageUrl?: string | undefined }) => Promise<boolean>;
  /**
   * The daemon's four words — with Yes/No buttons on button-capable channels, an invitation to reply
   * yes/no to this message on reply-capable ones, and the page link where the page is reachable.
   * Resolves the platform id of the sent words message (what a quoted reply will point at).
   */
  pushWords: (p: {
    cfg: OpenClawConfig;
    route: EnrollmentRoute;
    words: readonly [string, string, string, string];
    nonce: string;
    buttons: boolean;
    reply: boolean;
    pageUrl?: string | undefined;
  }) => Promise<{ ok: boolean; messageId: string | undefined }>;
  /** One outcome line (enrolled / mismatch / cancelled / ended). */
  pushText: (p: { cfg: OpenClawConfig; route: EnrollmentRoute; text: string }) => Promise<boolean>;
};

export function createEnrollmentChannel(sendBatch: SendBatch): EnrollmentChannel {
  /** Sends one payload; resolves whether the host accepted it and the primary platform id it got. */
  async function pushWithId(cfg: OpenClawConfig, route: EnrollmentRoute, payload: ReplyPayload): Promise<{ ok: boolean; messageId: string | undefined }> {
    try {
      const result = await sendBatch({
        cfg,
        channel: route.channel,
        to: route.to,
        accountId: route.accountId,
        threadId: route.threadId,
        payloads: [{ ...payload, channelData: { ...(payload.channelData ?? {}), [CHANNEL_DATA_KEY]: true } }],
      });
      if (result.status !== "sent") return { ok: false, messageId: undefined };
      // A channel may split one payload into several platform messages; the primary id is the one a
      // quoted reply points at (the words message is short text: one message in practice).
      const messageId = result.receipt?.primaryPlatformMessageId ?? result.results?.find((r) => typeof r.messageId === "string" && r.messageId)?.messageId;
      return { ok: true, messageId };
    } catch {
      return { ok: false, messageId: undefined };
    }
  }
  const push = async (cfg: OpenClawConfig, route: EnrollmentRoute, payload: ReplyPayload): Promise<boolean> => (await pushWithId(cfg, route, payload)).ok;
  return {
    pushQr: (p) => push(p.cfg, p.route, { text: strings.enroll.pushQrCaption({ agentName: p.agentName, link: p.link, pageUrl: p.pageUrl }), mediaUrl: p.dataUrl }),
    pushWords: (p) =>
      pushWithId(p.cfg, p.route, {
        text: strings.enroll.pushWords(p.words, { buttons: p.buttons, reply: p.reply, pageUrl: p.pageUrl }),
        ...(p.buttons
          ? {
              presentation: {
                blocks: [
                  {
                    type: "buttons",
                    buttons: [
                      { label: strings.enroll.buttonYes, style: "primary", action: { type: "callback", value: `${INTERACTIVE_NAMESPACE}:yes:${p.nonce}` } },
                      { label: strings.enroll.buttonNo, style: "danger", action: { type: "callback", value: `${INTERACTIVE_NAMESPACE}:no:${p.nonce}` } },
                    ],
                  },
                ],
              } as NonNullable<ReplyPayload["presentation"]>,
            }
          : {}),
      }),
    pushText: (p) => push(p.cfg, p.route, { text: p.text }),
  };
}

// --- button clicks → the human's yes / no --------------------------------------------------------

export type HumanDecision = { ok: boolean; state: string; message: string };

export type EnrollmentButtonDeps = {
  registry: EnrollmentRegistry;
  confirm: (active: ActiveEnrollment) => Promise<HumanDecision>;
  cancel: (active: ActiveEnrollment) => Promise<HumanDecision>;
};

/**
 * The per-channel interactive handler contexts (telegram `callback`, slack/discord `interaction`) read
 * structurally: their typed registrations live on SDK subpaths outside this plugin's import allowlist.
 */
type InteractiveCtx = {
  callback?: { payload?: string };
  interaction?: { payload?: string };
  senderId?: string;
  auth?: { isAuthorizedSender?: boolean };
  respond?: {
    reply?: (text: string) => Promise<unknown>;
    acknowledge?: () => Promise<unknown>;
    editButtons?: (buttons: unknown) => Promise<unknown>;
    clearButtons?: () => Promise<unknown>;
    clearComponents?: () => Promise<unknown>;
  };
};

export async function handleEnrollmentClick(raw: unknown, deps: EnrollmentButtonDeps): Promise<{ handled: boolean }> {
  const ctx = (raw ?? {}) as InteractiveCtx;
  const payload = ctx.callback?.payload ?? ctx.interaction?.payload;
  if (typeof payload !== "string") return { handled: false };
  const m = /^(yes|no):([a-f0-9]{24})$/.exec(payload);
  if (!m || !NONCE_RE.test(m[2]!)) return { handled: false };
  const reply = async (text: string) => {
    try {
      await ctx.respond?.acknowledge?.();
    } catch {
      /* best effort */
    }
    try {
      await ctx.respond?.reply?.(text);
    } catch {
      /* best effort */
    }
  };
  const entry = deps.registry.findByNonce(m[2]!);
  if (!entry) {
    await reply(strings.enroll.buttonStale);
    return { handled: true };
  }
  // Only the person who started the enrollment may decide, and only when the host vouches for them.
  const sameSender = entry.requesterSenderId === undefined || (ctx.senderId !== undefined && ctx.senderId === entry.requesterSenderId);
  if (ctx.auth?.isAuthorizedSender !== true || !sameSender) {
    await reply(strings.enroll.buttonNotYours);
    return { handled: true };
  }
  const result = m[1] === "yes" ? await deps.confirm(entry) : await deps.cancel(entry);
  try {
    await (ctx.respond?.clearButtons?.() ?? ctx.respond?.clearComponents?.() ?? ctx.respond?.editButtons?.([]));
  } catch {
    /* best effort */
  }
  await reply(result.message);
  return { handled: true };
}

/** One interactive handler per button-capable channel, all under the `ademu` namespace. */
export function registerEnrollmentButtons(api: OpenClawPluginApi, deps: EnrollmentButtonDeps): void {
  for (const channel of BUTTON_CAPABLE_CHANNELS) {
    api.registerInteractiveHandler({ channel, namespace: INTERACTIVE_NAMESPACE, handler: (ctx: unknown) => handleEnrollmentClick(ctx, deps) } as never);
  }
}
