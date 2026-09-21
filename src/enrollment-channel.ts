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
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  /** Grants the host read access to local media paths under these directories. */
  mediaAccess?: { localRoots: string[] };
}) => Promise<{ status: string; stage?: string; error?: unknown; reason?: unknown; results?: Array<{ messageId?: string }>; receipt?: { primaryPlatformMessageId?: string } }>;

/** Best-effort removal of a QR file written by `pushQr` (the ceremony ended). */
export async function removeQrFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await rm(filePath, { force: true });
  } catch {
    /* best effort */
  }
}

/** Decodes a `data:image/png;base64,…` URL into bytes; undefined for anything else. */
export function pngBytesFromDataUrl(dataUrl: string): Buffer | undefined {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  return m ? Buffer.from(m[1]!, "base64") : undefined;
}

/** Why a push was not delivered: the host's status/stage or the error's class — never payload text. */
export type PushOutcome = { ok: boolean; messageId: string | undefined; reason: string | undefined };
/** The QR push: `imageSent` false means the image was refused and only the caption with the link went out. */
export type QrPushOutcome = PushOutcome & { imageSent: boolean; filePath: string | undefined };

export type EnrollmentChannel = {
  /**
   * The QR image + exact link, sent by the plugin. The PNG travels as a private file under
   * `artifactDir` (OpenClaw hosts up to at least 2026.8.x refuse `data:` URLs for outbound media) with a
   * `mediaAccess.localRoots` grant for that directory; the caller removes the file when the ceremony
   * ends (`removeQrFile`). If the image is refused, the caption with the link is sent alone.
   */
  pushQr: (p: { cfg: OpenClawConfig; route: EnrollmentRoute; agentName: string; dataUrl: string; link: string; pageUrl?: string | undefined }) => Promise<QrPushOutcome>;
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
  }) => Promise<PushOutcome>;
  /** One outcome line (enrolled / mismatch / cancelled / ended). */
  pushText: (p: { cfg: OpenClawConfig; route: EnrollmentRoute; text: string }) => Promise<boolean>;
};

/** A short, payload-free description of a failed delivery for the tool result (never logged). */
function describeFailure(result: { status: string; stage?: string; error?: unknown; reason?: unknown }): string {
  const err = result.error;
  const errText = err instanceof Error ? `${err.name}${err.message ? `: ${err.message}` : ""}` : typeof err === "string" ? err : err ? JSON.stringify(err) : "";
  const parts = [`status=${result.status}`, result.stage ? `stage=${String(result.stage)}` : "", result.reason ? `reason=${String(result.reason)}` : "", errText].filter(Boolean);
  return parts.join("; ").slice(0, 300);
}

export type EnrollmentChannelOptions = {
  /** Private directory for QR image files (created 0700; files 0600); e.g. `<state dir>/ademu/enrollment-qr`. */
  artifactDir: string;
};

export function createEnrollmentChannel(sendBatch: SendBatch, options: EnrollmentChannelOptions): EnrollmentChannel {
  /** Sends one payload; resolves whether the host accepted it, the primary platform id it got, or why not. */
  async function pushWithId(cfg: OpenClawConfig, route: EnrollmentRoute, payload: ReplyPayload, mediaAccess?: { localRoots: string[] }): Promise<PushOutcome> {
    try {
      const result = await sendBatch({
        cfg,
        channel: route.channel,
        to: route.to,
        accountId: route.accountId,
        threadId: route.threadId,
        payloads: [{ ...payload, channelData: { ...(payload.channelData ?? {}), [CHANNEL_DATA_KEY]: true } }],
        ...(mediaAccess ? { mediaAccess } : {}),
      });
      if (result.status !== "sent") return { ok: false, messageId: undefined, reason: describeFailure(result) };
      // A channel may split one payload into several platform messages; the primary id is the one a
      // quoted reply points at (the words message is short text: one message in practice).
      const messageId = result.receipt?.primaryPlatformMessageId ?? result.results?.find((r) => typeof r.messageId === "string" && r.messageId)?.messageId;
      return { ok: true, messageId, reason: undefined };
    } catch (err) {
      return { ok: false, messageId: undefined, reason: describeFailure({ status: "threw", error: err }) };
    }
  }
  const push = async (cfg: OpenClawConfig, route: EnrollmentRoute, payload: ReplyPayload): Promise<boolean> => (await pushWithId(cfg, route, payload)).ok;
  /** Writes the PNG to a fresh private file; undefined when the bytes or the directory are unusable. */
  async function writeQrFile(dataUrl: string): Promise<string | undefined> {
    const bytes = pngBytesFromDataUrl(dataUrl);
    if (!bytes) return undefined;
    try {
      await mkdir(options.artifactDir, { recursive: true, mode: 0o700 });
      const filePath = join(options.artifactDir, `enroll-${randomBytes(8).toString("hex")}.png`);
      await writeFile(filePath, bytes, { mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => {});
      return filePath;
    } catch {
      return undefined;
    }
  }
  return {
    pushQr: async (p) => {
      const caption = strings.enroll.pushQrCaption({ agentName: p.agentName, link: p.link, pageUrl: p.pageUrl });
      const filePath = await writeQrFile(p.dataUrl);
      let imageReason: string | undefined;
      if (filePath) {
        const withImage = await pushWithId(p.cfg, p.route, { text: caption, mediaUrl: filePath }, { localRoots: [options.artifactDir] });
        if (withImage.ok) return { ...withImage, imageSent: true, filePath };
        imageReason = withImage.reason;
        await removeQrFile(filePath);
      } else {
        imageReason = "qr image file could not be written";
      }
      // The image was refused: the caption with the exact link still lets the phone tap its way in.
      const textOnly = await pushWithId(p.cfg, p.route, { text: `${caption}\n\n${strings.enroll.pushQrImageMissing}` });
      return { ...textOnly, reason: textOnly.ok ? imageReason : `${textOnly.reason ?? "text push failed"} (image: ${imageReason ?? "n/a"})`, imageSent: false, filePath: undefined };
    },
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
