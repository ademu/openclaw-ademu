// Outbound (plan T8): the `message` adapter (durable-final text, ack policy `after_agent_dispatch`)
// and the `messaging` block (target grammar). Replies go through the account's LIVE session client
// — the one `startAccount` opened — via a small registry keyed by accountId; there is no second
// connection for outbound (a device has one seat). Long texts are split at TEXT_CHUNK_LIMIT (V7: no
// daemon body cap exists; 1 MiB line ceiling; 4000 chars is the conservative default), every chunk
// is one `send_text` reported through `onDeliveryResult`, and a failure after the first accepted
// chunk throws `createChannelPartialDeliveryError` so core never re-sends delivered chunks.
//
// Media (#27): a reply's files go out as ONE `send_media` album through the client's composed send,
// which declares, pushes the bytes and waits for the daemon's outcome (`awaitOutcome`, clients 0.7.0).
// What the client leaves to us is small: URL → local file (the host's loader), photo vs file, the
// hello's `media_send` advert, and turning a refusal into a short line the chat and the agent see.
import { basename } from "node:path";
import {
  BlobWriteError,
  DetachedError,
  RequestError,
  RequestTimeoutError,
  type AdcClient,
  type MediaItemInput,
  type MediaSendSettled,
  type SendTextResult,
} from "@ademu/adc-client";
import { MediaDecodeError, MediaTooLargeError, UnsupportedMediaError, prepareFile, preparePhoto } from "@ademu/adc-client/media";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { buildChannelOutboundSessionRoute, type ChannelOutboundSessionRouteParams } from "openclaw/plugin-sdk/channel-core";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendMediaContext,
  type ChannelMessageSendResult,
  type ChannelMessageSendTextContext,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { extractOriginalFilename, getAgentScopedMediaLocalRoots, resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { CHANNEL_ID } from "./config.js";
import { looksLikeId, normalizeTarget, type ConversationKind } from "./grammar.js";
import { strings } from "./i18n/strings.js";
import { sanitizeFilename } from "./monitor/content.js";

/** Conservative per-message ceiling (V7). Not a config knob in v1. */
export const TEXT_CHUNK_LIMIT = 4000;

export class AccountNotRunningError extends Error {
  constructor(readonly accountId: string) {
    super(`Ademú account "${accountId}" is not running; start the channel before sending.`);
    this.name = "AccountNotRunningError";
  }
}

/** The subset of the session client outbound needs (the fake in tests implements it too). */
export type OutboundClient = Pick<AdcClient, "sendText" | "sendReaction" | "sendTyping" | "sendMedia" | "waitForMediaSend" | "hello">;

/** The read side the `ademu_get_media` tool needs (AdemuMLS #440); the session client is the full AdcClient. */
export type MediaClient = Pick<AdcClient, "getMessage" | "getBlob" | "fetchMedia" | "capabilities">;

export type LiveAccount = {
  client: OutboundClient;
  /** Reads a received file's state and bytes (the media tool). */
  media?: MediaClient;
  /** Conversation kind lookup from the session's members cache (undefined = unknown). */
  conversationKind?: (groupId: string) => ConversationKind | undefined;
  /** Files that did not go out, per conversation, until the agent's next turn there (shared with ingress). */
  refusalNotes?: RefusalNotes;
  /** The account's structural log (media sends from the agent's own tool calls log through it). */
  log?: MediaSendLog;
};

/**
 * OpenClaw registers the plugin again in the same gateway process for tool discovery, and the media
 * tool runs in that pass; it must see the accounts the startup pass registered, so the map lives on
 * `globalThis` (as the enrollment registry does, `src/tools/enroll.ts`).
 */
const LIVE_ACCOUNTS_KEY = Symbol.for("ademu.openclaw.liveAccounts");
const live: Map<string, LiveAccount> = ((globalThis as { [LIVE_ACCOUNTS_KEY]?: Map<string, LiveAccount> })[LIVE_ACCOUNTS_KEY] ??= new Map<
  string,
  LiveAccount
>());

export function registerLiveAccount(accountId: string, account: LiveAccount): void {
  live.set(accountId, account);
}

/** Removes the registration only if it is still the same object (a successor may have replaced it). */
export function unregisterLiveAccount(accountId: string, account: LiveAccount): void {
  if (live.get(accountId) === account) live.delete(accountId);
}

export function getLiveAccount(accountId: string): LiveAccount {
  const entry = live.get(accountId);
  if (!entry) throw new AccountNotRunningError(accountId);
  return entry;
}

export function resetLiveAccountsForTests(): void {
  live.clear();
}

/** The account an outbound call targets: explicit accountId, else the only running one. */
export function resolveOutboundAccountId(accountId: string | null | undefined): string {
  if (accountId) return accountId;
  if (live.size === 1) return [...live.keys()][0]!;
  throw new AccountNotRunningError(accountId ?? "default");
}

export type SentChunk = { group_id: string; result: SendTextResult };

export function createAdemuReceipt(chunks: readonly SentChunk[], sentAt: number = Date.now(), kind: "text" | "media" = "text"): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    results: chunks.map((chunk) => ({
      channel: CHANNEL_ID,
      messageId: chunk.result.message_id,
      conversationId: chunk.group_id,
      chatId: chunk.group_id,
      meta: { status: chunk.result.status },
    })),
    kind,
    sentAt,
  });
}

function sendResultFor(chunks: readonly SentChunk[], kind: "text" | "media" = "text"): ChannelMessageSendResult {
  const receipt = createAdemuReceipt(chunks, Date.now(), kind);
  const first = chunks[0];
  return {
    receipt,
    ...(first ? { messageId: first.result.message_id, target: { kind: "conversation", id: first.group_id } } : {}),
  };
}

/**
 * Sends `text` into `groupId` as one or more `send_text` calls. A failure after ≥1 accepted chunk
 * is surfaced as a partial-delivery error carrying the accepted receipts (SMS precedent).
 */
export async function sendAdemuText(params: {
  client: OutboundClient;
  groupId: string;
  text: string;
  signal?: AbortSignal | undefined;
  onDeliveryResult?: ((result: ChannelMessageSendResult) => Promise<void> | void) | undefined;
}): Promise<SentChunk[]> {
  const pieces = chunkTextForOutbound(params.text, TEXT_CHUNK_LIMIT).filter((piece) => piece.trim().length > 0);
  if (pieces.length === 0) throw new Error("Ademú send requires non-empty text.");
  const sent: SentChunk[] = [];
  try {
    for (const body of pieces) {
      params.signal?.throwIfAborted();
      const result = await params.client.sendText({ group_id: params.groupId, body });
      const chunk = { group_id: params.groupId, result };
      sent.push(chunk);
      await params.onDeliveryResult?.(sendResultFor([chunk]));
    }
  } catch (error) {
    if (sent.length === 0) throw error;
    throw createChannelPartialDeliveryError(error, {
      messageIds: sent.map((chunk) => chunk.result.message_id),
      receipt: createAdemuReceipt(sent),
      visibleReplySent: true,
    });
  }
  return sent;
}

/** Resolves an outbound `to` into a conversation id (UUID) or throws a clear error. */
export function resolveConversationTarget(to: string): string {
  const id = normalizeTarget(to);
  // Never reflect the raw target into the error (host code may log channel errors): shape only.
  if (!id) throw new Error(`Ademú targets are conversation ids (UUID), optionally prefixed "ademu:"; got a ${to.trim().length}-character value that is not one.`);
  return id;
}

/**
 * Runs `work` unless the turn is already aborted, and stops waiting for it the moment the turn is. The
 * client takes no signal, so abandoned work still finishes on its connection.
 */
export function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  signal?.throwIfAborted();
  const running = work();
  if (!signal) return running;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    running.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// ----- media (#27) -----------------------------------------------------------------------------

/** How long a send waits for the daemon's outcome before it counts as sent-but-pending. */
export const MEDIA_SEND_WAIT_MS = 120_000;
/** Notes kept per conversation until the agent's next turn there; oldest dropped first. */
const MAX_NOTES_PER_CONVERSATION = 20;

/** Why a file did not go out: one closed list for the wording, the log `code` and the tests. */
const REFUSAL_REASONS = [
  // before the send
  "load_failed",
  "too_many",
  // the daemon refused the declaration (RequestError.code)
  "not_a_member",
  "invalid_items",
  "unsupported_type",
  "unsupported_encoding",
  "too_large",
  "too_many_tickets",
  // the send's final outcome
  "upload_failed",
  "store_failed",
  "transfer_interrupted",
  "media_unavailable",
  "send_failed",
  "cancelled",
  // the session under the push
  "disconnected",
  "other",
] as const;
export type MediaRefusalReason = (typeof REFUSAL_REASONS)[number];
export type MediaRefusal = { name: string; reason: MediaRefusalReason };

/** Per conversation (normalized id): files that did not go out and the agent has not been told about. */
export type RefusalNotes = Map<string, MediaRefusal[]>;

const WHY: Record<MediaRefusalReason, keyof typeof strings.media.send.why> = {
  load_failed: "unreadable",
  too_many: "tooMany",
  not_a_member: "notMember",
  invalid_items: "unsupported",
  unsupported_type: "unsupported",
  unsupported_encoding: "unsupported",
  too_large: "tooLarge",
  too_many_tickets: "tooMany",
  upload_failed: "uploadFailed",
  store_failed: "uploadFailed",
  transfer_interrupted: "uploadFailed",
  media_unavailable: "uploadFailed",
  send_failed: "uploadFailed",
  cancelled: "cancelled",
  disconnected: "disconnected",
  other: "other",
};

const knownReason = (code: unknown): MediaRefusalReason =>
  (REFUSAL_REASONS as readonly unknown[]).includes(code) ? (code as MediaRefusalReason) : "other";

function reasonForError(err: unknown): MediaRefusalReason {
  if (err instanceof RequestError) return knownReason(err.code);
  if (err instanceof BlobWriteError) return "transfer_interrupted";
  if (err instanceof DetachedError || err instanceof RequestTimeoutError) return "disconnected";
  return "other";
}

const reasonForOutcome = (o: MediaSendSettled): MediaRefusalReason => (o.status === "cancelled" ? "cancelled" : knownReason(o.code));

/** One bracketed line per reason, naming its files (sanitized: they reach the model). */
function linesFor(refused: readonly MediaRefusal[], line: (names: string, why: string) => string): string {
  const byWhy = new Map<string, string[]>();
  for (const r of refused) {
    const why = strings.media.send.why[WHY[r.reason]];
    byWhy.set(why, [...(byWhy.get(why) ?? []), sanitizeFilename(r.name) || strings.media.tool.unnamed]);
  }
  return [...byWhy].map(([why, names]) => line(names.join(", "), why)).join("\n");
}

/** The chat line for files that did not go out. */
export const refusalLine = (refused: readonly MediaRefusal[]): string => linesFor(refused, strings.media.send.refused);

/**
 * The agent's note for a conversation: the lines its next turn starts with. Reading it does not clear
 * it; `consume` does, once the turn is adopted, and removes only what was read (a late failure may
 * have added more meanwhile).
 */
export function peekRefusalNote(notes: RefusalNotes | undefined, groupId: string): { text: string; consume: () => void } | undefined {
  const id = normalizeTarget(groupId) ?? groupId;
  const read = notes?.get(id);
  if (!notes || !read?.length) return undefined;
  const taken = [...read];
  return {
    text: linesFor(taken, strings.media.send.agentNote),
    consume: () => {
      const left = (notes.get(id) ?? []).filter((r) => !taken.includes(r));
      if (left.length > 0) notes.set(id, left);
      else notes.delete(id);
    },
  };
}

/**
 * Tells the chat and the agent that files did not go out: the line in the conversation, and a note
 * for the agent's next turn there (ingress drops the agent's own messages, so it never sees the line).
 */
export async function reportRefusals(params: { client: OutboundClient; groupId: string; refused: readonly MediaRefusal[]; notes?: RefusalNotes | undefined }): Promise<void> {
  if (params.refused.length === 0) return;
  if (params.notes) {
    const id = normalizeTarget(params.groupId) ?? params.groupId;
    params.notes.set(id, [...(params.notes.get(id) ?? []), ...params.refused].slice(-MAX_NOTES_PER_CONVERSATION));
  }
  await sendAdemuText({ client: params.client, groupId: params.groupId, text: refusalLine(params.refused) });
}

/** A URL (or path) → a local file the client can read; the host's loader, a seam for tests. */
export type MediaLoader = (url: string, maxBytes: number) => Promise<{ path: string; contentType?: string }>;

/** The host's loader (`resolveOutboundAttachmentFromUrl`); a seam so tests can see what reaches it. */
export type AttachmentResolver = typeof resolveOutboundAttachmentFromUrl;

export function hostMediaLoader(
  opts: {
    mediaAccess?: ChannelMessageSendMediaContext["mediaAccess"];
    mediaLocalRoots?: readonly string[] | undefined;
    mediaReadFile?: ((filePath: string) => Promise<Buffer>) | undefined;
  },
  resolve: AttachmentResolver = resolveOutboundAttachmentFromUrl,
): MediaLoader {
  // The raw fields go straight through (the helper builds its own load options, keeping workspaceDir).
  return (url, maxBytes) =>
    resolve(url, maxBytes, {
      ...(opts.mediaAccess ? { mediaAccess: opts.mediaAccess } : {}),
      ...(opts.mediaLocalRoots ? { localRoots: opts.mediaLocalRoots } : {}),
      ...(opts.mediaReadFile ? { readFile: opts.mediaReadFile } : {}),
    });
}

function nameFromUrl(url: string): string {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    // A plain path, or a malformed URL: its own basename.
  }
  return basename(path) || strings.media.tool.unnamed;
}

/** JPEG/PNG go as photos (the client prepares them); anything else, or a photo it cannot read, as a file. */
async function prepareItem(path: string, contentType: string | undefined, filename: string): Promise<MediaItemInput> {
  if (contentType === "image/jpeg" || contentType === "image/png") {
    try {
      return await preparePhoto(path, { filename });
    } catch (err) {
      if (!(err instanceof UnsupportedMediaError || err instanceof MediaTooLargeError || err instanceof MediaDecodeError)) throw err;
    }
  }
  return prepareFile(path, { filename, ...(contentType ? { mime: contentType } : {}) });
}

export type MediaSendResult = {
  /** The album, once declared: `queued`, or `pending` (the daemon still holds it past the wait). */
  album?: { messageId: string; status: "queued" | "pending" };
  /** Text messages this send posted: a reply text too long for a caption, or the caption resent after a failed album. */
  text: SentChunk[];
  refused: MediaRefusal[];
};

/** Structural fields only (privacy audit): statuses, counts, reason codes, error class names. */
export type MediaSendLog = (event: string, fields?: Record<string, string | number | boolean>) => void;

const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * Sends a reply's files (and its text) into `groupId` as one album. The reply text is never lost: it
 * is the caption when it fits, else (or when every file was refused, or the album failed) it goes as
 * text. A file refused before the send (load, advert) is left out and the rest still go; the album
 * itself is all-or-nothing. A send still pending after the wait counts as sent, and a later failure is
 * reported then (the caption resent, the line, the agent's note).
 *
 * Logs one `media_send_result {status, items, refused, urls, code?}`: `items` = files declared in the
 * album, `refused` = files that did not go out, `urls` = files in the reply; `status` is the album's
 * outcome, or `refused` when nothing was declared; `code` is the album's failure reason, else the first
 * refusal's.
 */
export async function sendAdemuMedia(params: {
  client: OutboundClient;
  groupId: string;
  text?: string | undefined;
  urls: readonly string[];
  load: MediaLoader;
  signal?: AbortSignal | undefined;
  notes?: RefusalNotes | undefined;
  /** How long to wait for the daemon's outcome before the send counts as sent-but-pending. */
  waitMs?: number | undefined;
  log?: MediaSendLog | undefined;
}): Promise<MediaSendResult> {
  const { client, groupId, signal } = params;
  // Nothing is in production: a daemon without the advert is a version mismatch, not a fallback case.
  const advert = client.hello.media_send;
  if (!advert) {
    params.log?.("media_send_result", { status: "refused", items: 0, refused: params.urls.length, urls: params.urls.length, code: "other" });
    throw new Error(strings.media.send.noAdvert);
  }

  const refused: MediaRefusal[] = [];
  const items: MediaItemInput[] = [];
  for (const [index, url] of params.urls.entries()) {
    // The cap counts the reply's files before any load, so no more than max_items are ever fetched.
    if (index >= advert.max_items) {
      refused.push({ name: nameFromUrl(url), reason: "too_many" });
      continue;
    }
    signal?.throwIfAborted();
    let item: MediaItemInput;
    try {
      const loaded = await params.load(url, advert.max_bytes);
      // The name the recipient sees is the original one, not the store's `name---<uuid>.ext`.
      item = await prepareItem(loaded.path, loaded.contentType, extractOriginalFilename(loaded.path));
    } catch (err) {
      if (signal?.aborted) throw err;
      refused.push({ name: nameFromUrl(url), reason: "load_failed" });
      continue;
    }
    const accepted = advert.types[item.type];
    if (!accepted || !(accepted.includes("*") || accepted.includes(item.mime))) refused.push({ name: item.filename, reason: "unsupported_type" });
    else if (item.size > advert.max_bytes) refused.push({ name: item.filename, reason: "too_large" });
    else items.push(item);
  }

  const sentText: SentChunk[] = [];
  const sendText = async (text: string) => {
    sentText.push(...(await sendAdemuText({ client, groupId, text, signal })));
  };
  const text = params.text?.trim() ? params.text : undefined;
  const caption = text !== undefined && items.length > 0 && text.length <= TEXT_CHUNK_LIMIT ? text : undefined;
  if (text !== undefined && caption === undefined) await sendText(text);

  let album: MediaSendResult["album"];
  let failed: { status: "failed" | "cancelled"; reason: MediaRefusalReason } | undefined;
  if (items.length > 0) {
    try {
      const outcome = await untilAborted(
        () =>
          client.sendMedia(
            { group_id: groupId, ...(caption !== undefined ? { caption } : {}), items },
            { awaitOutcome: { timeoutMs: params.waitMs ?? MEDIA_SEND_WAIT_MS } },
          ),
        signal,
      );
      if (outcome.status === "queued" || outcome.status === "pending") {
        album = { messageId: outcome.message_id, status: outcome.status };
        if (outcome.status === "pending") watchPendingSend(params, outcome.message_id, items, caption);
      } else {
        failed = { status: outcome.status, reason: reasonForOutcome(outcome) };
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      failed = { status: "failed", reason: reasonForError(err) };
    }
    if (failed !== undefined) {
      const reason = failed.reason;
      refused.push(...items.map((item) => ({ name: item.filename, reason })));
      // Best effort: the refusals are reported whether or not the caption makes it out.
      if (caption !== undefined) {
        await sendText(caption).catch((err: unknown) => params.log?.("media_send_caption_resend_failed", { errorClass: errorClass(err) }));
      }
    }
  }

  const code = failed?.reason ?? refused[0]?.reason;
  params.log?.("media_send_result", {
    status: album?.status ?? failed?.status ?? "refused",
    items: items.length,
    refused: refused.length,
    urls: params.urls.length,
    ...(code ? { code } : {}),
  });
  return { ...(album ? { album } : {}), text: sentText, refused };
}

/** A send still pending after the wait: keep watching, and report a late failure as a failure in time. */
function watchPendingSend(
  params: Parameters<typeof sendAdemuMedia>[0],
  messageId: string,
  items: readonly MediaItemInput[],
  caption: string | undefined,
): void {
  const { client, groupId, log } = params;
  log?.("media_send_pending", { items: items.length });
  const report = async (outcome: MediaSendSettled) => {
    if (outcome.status === "queued" || outcome.status === "pending") return;
    const reason = reasonForOutcome(outcome);
    log?.("media_send_late_failure", { status: outcome.status, code: reason, items: items.length });
    if (caption !== undefined) {
      await sendAdemuText({ client, groupId, text: caption }).catch((err: unknown) => log?.("media_send_caption_resend_failed", { errorClass: errorClass(err) }));
    }
    await reportRefusals({ client, groupId, refused: items.map((item) => ({ name: item.filename, reason })), notes: params.notes }).catch((err: unknown) =>
      log?.("media_send_report_failed", { errorClass: errorClass(err) }),
    );
  };
  // Only the wait itself ending without an outcome (restart, end of session) is a lost wait.
  void client.waitForMediaSend({ message_id: messageId }).then(report, (err: unknown) => log?.("media_send_wait_lost", { errorClass: errorClass(err) }));
}

/** How long a reply waits for the outcome: shorter than a tool send, since a reply holds an ingress slot. */
export const REPLY_MEDIA_WAIT_MS = 30_000;

/**
 * The reply path's sender (ingress `deliver`): the agent's workspace as a local root, the files sent,
 * and anything refused reported (the chat line and the agent's note). True = something visible went out.
 */
export function createReplyMediaSender(deps: {
  client: OutboundClient;
  cfg: OpenClawConfig;
  notes: RefusalNotes;
  log?: MediaSendLog | undefined;
  resolve?: AttachmentResolver | undefined;
}): (groupId: string, text: string | undefined, urls: readonly string[], agentId: string) => Promise<boolean> {
  return async (groupId, text, urls, agentId) => {
    const { client, notes, log } = deps;
    const load = hostMediaLoader({ mediaLocalRoots: getAgentScopedMediaLocalRoots(deps.cfg, agentId) }, deps.resolve);
    const result = await sendAdemuMedia({ client, groupId, text, urls, load, notes, log, waitMs: REPLY_MEDIA_WAIT_MS });
    await reportRefusals({ client, groupId, refused: result.refused, notes });
    return result.album !== undefined || result.text.length > 0 || result.refused.length > 0;
  };
}

async function sendText(ctx: ChannelMessageSendTextContext<OpenClawConfig>): Promise<ChannelMessageSendResult> {
  const accountId = resolveOutboundAccountId(ctx.accountId);
  const { client } = getLiveAccount(accountId);
  const groupId = resolveConversationTarget(ctx.to);
  const chunks = await sendAdemuText({
    client,
    groupId,
    text: ctx.text,
    signal: ctx.signal,
    onDeliveryResult: ctx.onDeliveryResult,
  });
  return sendResultFor(chunks);
}

/**
 * The agent's own file send. A refused file throws the refusal line, so the agent's tool call sees it;
 * after text already went out it is a partial delivery (core never re-sends what was delivered).
 */
async function sendMedia(ctx: ChannelMessageSendMediaContext<OpenClawConfig>): Promise<ChannelMessageSendResult> {
  const accountId = resolveOutboundAccountId(ctx.accountId);
  const { client, refusalNotes, log } = getLiveAccount(accountId);
  const groupId = resolveConversationTarget(ctx.to);
  const result = await sendAdemuMedia({ client, groupId, text: ctx.text, urls: [ctx.mediaUrl], load: hostMediaLoader(ctx), signal: ctx.signal, notes: refusalNotes, log });
  if (result.refused.length > 0) {
    const error = new Error(refusalLine(result.refused));
    if (result.text.length === 0) throw error;
    throw createChannelPartialDeliveryError(error, {
      messageIds: result.text.map((chunk) => chunk.result.message_id),
      receipt: createAdemuReceipt(result.text),
      visibleReplySent: true,
    });
  }
  const album: SentChunk[] = result.album ? [{ group_id: groupId, result: { message_id: result.album.messageId, status: result.album.status } }] : [];
  return sendResultFor([...result.text, ...album], "media");
}

export const ademuMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  // Final replies come through ingress `deliver` (no messageSendingHooks declared), which sends media too.
  durableFinal: { capabilities: { text: true, media: true } },
  send: { text: sendText, media: sendMedia },
  receive: {
    // Rider R4: "After the agent run is dispatched" — core's `onAdopted` is our ack point (§2 R2b).
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_agent_dispatch"],
  },
});

/** Direct vs group for an explicit target: from the running account's members cache, else group. */
export function inferConversationKind(to: string, accountId?: string | null): ConversationKind | undefined {
  const id = normalizeTarget(to);
  if (!id) return undefined;
  const entries = accountId ? [live.get(accountId)] : [...live.values()];
  for (const entry of entries) {
    const kind = entry?.conversationKind?.(id);
    if (kind) return kind;
  }
  return "group";
}

export function resolveAdemuOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const id = normalizeTarget(params.resolvedTarget?.to ?? params.target);
  if (!id) return null;
  const kind = inferConversationKind(id, params.accountId) ?? "group";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId ?? null,
    recipientSessionExact: true,
    peer: { kind, id },
    chatType: kind,
    from: `${CHANNEL_ID}:${id}`,
    to: `${CHANNEL_ID}:${id}`,
  });
}

export const ademuMessaging: ChannelMessagingAdapter = {
  targetPrefixes: [CHANNEL_ID],
  targetIdComparison: "lowercase",
  normalizeTarget: (raw) => normalizeTarget(raw),
  inferTargetChatType: ({ to }) => inferConversationKind(to),
  resolveOutboundSessionRoute: (params) => resolveAdemuOutboundSessionRoute(params),
  targetResolver: {
    looksLikeId: (raw) => looksLikeId(raw.replace(/^ademu:/i, "")),
    hint: "<conversation-id>",
  },
};
