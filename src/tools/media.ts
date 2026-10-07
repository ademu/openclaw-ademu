// The `ademu_get_media` tool (openclaw-ademu #22, AdemuMLS #440). A received file's bytes stay in the
// daemon: ingress dispatches the message at once with one line per file naming this call, and the
// agent opens a file here, inside its own turn. The tool never waits — a file still downloading
// returns its state and the agent asks again — so a turn never sits on a download. Reading acks
// nothing and uses no seq (`getBlob`), and the daemon keeps files permanently, so a file stays
// readable after its message was acked.
//
// Scope: only files of the conversation the current turn answers. A guest in a room cannot make the
// agent pull a file out of the owner's DM.
import { BlobReadError, RequestError, type MediaItem } from "@ademu/adc-client";
import { imageResultFromFile, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { CHANNEL_ID } from "../config.js";
import { normalizeId, normalizeTarget } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { formatSize, sanitizeFilename } from "../monitor/content.js";
import { getLiveAccount, resolveOutboundAccountId, type MediaClient } from "../outbound.js";

export const MEDIA_TOOL_NAME = "ademu_get_media";

/** Per-read no-progress deadline (the client's idle timer restarts on every chunk). */
const READ_TIMEOUT_MS = 30_000;
/** What the model path takes as an image as-is; anything else is saved and returned by path. */
const MODEL_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** The `get_blob` refusals logged by name (a closed set; anything else logs as "other"). */
const READ_CODES = new Set(["not_fetched", "not_found", "too_many_tickets", "query_failed"]);

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: unknown };
const text = (msg: string, details: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: msg }], details });

export type SavedMedia = { path: string; size: number; contentType?: string };

export type MediaToolDeps = {
  /** OpenClaw's media store (`api.runtime.channel.media.saveMediaBuffer`). */
  saveMediaBuffer: (buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string) => Promise<SavedMedia>;
  /** Builds an image result from a saved file (resizes for the model); a seam for tests. */
  imageResult?: (p: { label: string; path: string; extraText?: string; details?: Record<string, unknown> }) => Promise<unknown>;
  /** Structural fields only (privacy audit): never ids, filenames, paths or tickets. */
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export class MediaToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaToolError";
  }
}

/** The conversation this turn answers, from the host's tool context; undefined outside an Ademú turn. */
function turnConversation(ctx: OpenClawPluginToolContext): string | undefined {
  if (ctx.messageChannel !== CHANNEL_ID) return undefined;
  const to = ctx.deliveryContext?.channel === CHANNEL_ID ? ctx.deliveryContext.to : undefined;
  return normalizeTarget(to ?? "") ?? normalizeTarget(ctx.nativeChannelId ?? "");
}

function mediaClientFor(ctx: OpenClawPluginToolContext): MediaClient {
  try {
    const account = getLiveAccount(resolveOutboundAccountId(ctx.agentAccountId ?? ctx.deliveryContext?.accountId));
    if (account.media) return account.media;
  } catch {
    // AccountNotRunningError: the same answer as an account without a media handle.
  }
  throw new MediaToolError(strings.media.tool.notRunning);
}

function readPosition(args: Record<string, unknown>): number | undefined {
  const raw = args.position;
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function describeFile(item: MediaItem, size: number): { kind: string; name: string; size: string } {
  return {
    kind: strings.media.kinds[item.type as keyof typeof strings.media.kinds] ?? strings.media.kinds.file,
    name: sanitizeFilename(item.filename) || strings.media.tool.unnamed,
    size: formatSize(size),
  };
}

export function createMediaTool(ctx: OpenClawPluginToolContext, deps: MediaToolDeps) {
  // Offered only on Ademú turns; every other channel's turn never sees it. A restrictive tool profile
  // still filters it out unless the manifest's `toolMetadata.ademu_get_media.profiles` names that profile.
  if (ctx.messageChannel !== CHANNEL_ID) return null;
  return {
    label: strings.media.tool.label,
    name: MEDIA_TOOL_NAME,
    description: strings.media.tool.description,
    parameters: Type.Object({
      message_id: Type.String({ description: "The message_id from the file's line in the message." }),
      position: Type.Integer({ minimum: 0, description: "The position from the file's line in the message." }),
    }),
    execute: async (_toolCallId: string, rawArgs: unknown, signal?: AbortSignal): Promise<ToolResult> => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const messageId = readStringParam(args, "message_id")?.trim();
      const position = readPosition(args);
      if (!messageId || position === undefined) throw new MediaToolError(strings.media.tool.badArgs);

      const conversation = turnConversation(ctx);
      if (!conversation) throw new MediaToolError(strings.media.tool.noTurn);
      const client = mediaClientFor(ctx);
      if (!client.capabilities.has("get_blob")) throw new MediaToolError(strings.media.tool.noGetBlob);

      signal?.throwIfAborted();
      let message;
      try {
        message = await client.getMessage({ message_id: messageId });
      } catch (err) {
        if (err instanceof RequestError && err.code === "not_found") throw new MediaToolError(strings.media.tool.noSuchFile);
        throw err;
      }
      // Scope before anything about the file is revealed: another conversation's file does not exist here.
      if (normalizeId(message.group_id) !== conversation) {
        deps.log("media_tool_refused", { reason: "other_conversation" });
        throw new MediaToolError(strings.media.tool.notThisConversation);
      }
      const item = message.deleted || message.ct !== "media" ? undefined : message.media?.find((m) => m.position === position);
      if (!item) throw new MediaToolError(strings.media.tool.noSuchFile);

      const state = item.fetch_state ?? "none";
      const facts = describeFile(item, item.stored_len ?? item.size);
      const details = { state, kind: item.type, mime: item.mime };
      switch (state) {
        case "fetched":
          break;
        case "failed":
          // Re-queue the download (idempotent; only `failed` files move) and let the agent ask again.
          await client.fetchMedia({ message_id: messageId, position });
          deps.log("media_tool_result", { state });
          return text(strings.media.tool.failedRequeued(facts.kind), details);
        case "unavailable":
          deps.log("media_tool_result", { state });
          return text(strings.media.tool.unavailable(facts.kind), details);
        case "too_large":
          deps.log("media_tool_result", { state });
          return text(strings.media.tool.tooLarge(facts.kind), details);
        default:
          // `none`, `fetching`, or a state this plugin does not know yet: not readable now.
          deps.log("media_tool_result", { state: state === "none" || state === "fetching" ? state : "other" });
          return text(strings.media.tool.pending(facts.kind), details);
      }

      signal?.throwIfAborted();
      let bytes: Buffer;
      try {
        bytes = await client.getBlob({ message_id: messageId, position }, { timeoutMs: READ_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof RequestError) {
          deps.log("media_tool_read_refused", { code: READ_CODES.has(err.code) ? err.code : "other" });
          if (err.code === "not_fetched") return text(strings.media.tool.pending(facts.kind), { ...details, state: "pending" });
          if (err.code === "not_found") throw new MediaToolError(strings.media.tool.noSuchFile);
          if (err.code === "too_many_tickets") return text(strings.media.tool.busy, details);
        }
        if (err instanceof BlobReadError) {
          // received 0 = the daemon refused the ticket (e.g. the message was deleted meanwhile).
          deps.log("media_tool_read_failed", { reason: err.reason, received: err.received > 0 });
          return text(strings.media.tool.readFailed, details);
        }
        throw err;
      }

      // An explicit ceiling: the store's default (5 MB) would refuse most videos.
      const saved = await deps.saveMediaBuffer(bytes, item.mime || undefined, "inbound", Math.max(bytes.length, 1), sanitizeFilename(item.filename) || undefined);
      const mime = saved.contentType ?? item.mime;
      const savedFacts = { ...facts, size: formatSize(saved.size) };
      const savedDetails = { ...details, mime, size: saved.size, path: saved.path };
      if (MODEL_IMAGE_MIMES.has(mime)) {
        deps.log("media_tool_result", { state, returned: "image" });
        const imageResult = deps.imageResult ?? imageResultFromFile;
        return (await imageResult({
          label: strings.media.tool.label,
          path: saved.path,
          extraText: strings.media.tool.image(savedFacts, saved.path),
          details: savedDetails,
        })) as ToolResult;
      }
      deps.log("media_tool_result", { state, returned: "path" });
      return text(strings.media.tool.saved(savedFacts, mime, saved.path), savedDetails);
    },
  };
}

export function registerMediaTool(api: OpenClawPluginApi, deps: MediaToolDeps): void {
  api.registerTool((ctx) => createMediaTool(ctx, deps) as never, { name: MEDIA_TOOL_NAME });
}
