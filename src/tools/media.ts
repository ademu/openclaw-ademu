// The `ademu_get_media` tool (openclaw-ademu #22, AdemuMLS #440). A received file's bytes stay in the
// daemon: ingress dispatches the message at once with one line per file naming this call, and the
// agent opens a file here, inside its own turn. The tool never waits — a file still downloading
// returns its state and the agent asks again — so a turn never sits on a download. Reading acks
// nothing and uses no seq (`getBlob`), and the daemon keeps files permanently, so a file stays
// readable after its message was acked.
//
// Scope: only files of the conversation the current turn answers. A guest in a room cannot make the
// agent pull a file out of the owner's DM.
//
// Cost: a file is read whole into the gateway, so files above `mediaMaxOpenMb` are refused unread, and a
// file opened again reuses the copy already saved instead of reading and saving it a second time.
import { stat } from "node:fs/promises";
import { BlobReadError, RequestError, type MediaItem } from "@ademu/adc-client";
import { imageResultFromFile, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { CHANNEL_ID } from "../config.js";
import { normalizeId, normalizeTarget } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { formatSize, sanitizeFilename } from "../monitor/content.js";
import { getLiveAccount, resolveOutboundAccountId, untilAborted, type MediaClient } from "../outbound.js";

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

/**
 * The copies this process already saved, per account + message + position, so a file the agent opens
 * again is not read and saved again. On `globalThis` because OpenClaw builds the tool in a fresh plugin
 * registration per call (as the live-account registry, `src/outbound.ts`). Bounded; oldest dropped first.
 */
const SAVED_COPIES_KEY = Symbol.for("ademu.openclaw.savedMediaCopies");
const SAVED_COPIES_MAX = 256;
const savedCopies: Map<string, SavedMedia> = ((globalThis as { [SAVED_COPIES_KEY]?: Map<string, SavedMedia> })[SAVED_COPIES_KEY] ??= new Map<
  string,
  SavedMedia
>());

function rememberCopy(key: string, copy: SavedMedia): void {
  savedCopies.delete(key);
  savedCopies.set(key, copy);
  if (savedCopies.size > SAVED_COPIES_MAX) savedCopies.delete(savedCopies.keys().next().value!);
}

export function resetSavedCopiesForTests(): void {
  savedCopies.clear();
}

async function fileSizeOnDisk(path: string): Promise<number | undefined> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

export type MediaToolDeps = {
  /** OpenClaw's media store (`api.runtime.channel.media.saveMediaBuffer`). */
  saveMediaBuffer: (buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string) => Promise<SavedMedia>;
  /** Builds an image result from a saved file (resizes for the model); a seam for tests. */
  imageResult?: (p: { label: string; path: string; extraText?: string; details?: Record<string, unknown> }) => Promise<unknown>;
  /** The largest file read into the gateway, in bytes (`mediaMaxOpenMb`), resolved per call. */
  maxOpenBytes: () => number;
  /** A saved copy's size on disk, undefined when it is gone; a seam for tests. */
  fileSize?: (path: string) => Promise<number | undefined>;
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

function mediaClientFor(ctx: OpenClawPluginToolContext): { accountId: string; client: MediaClient } {
  try {
    const accountId = resolveOutboundAccountId(ctx.agentAccountId ?? ctx.deliveryContext?.accountId);
    const account = getLiveAccount(accountId);
    if (account.media) return { accountId, client: account.media };
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
      const { accountId, client } = mediaClientFor(ctx);
      if (!client.capabilities.has("get_blob")) throw new MediaToolError(strings.media.tool.noGetBlob);

      let message;
      try {
        message = await untilAborted(() => client.getMessage({ message_id: messageId }), signal);
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
          try {
            await untilAborted(() => client.fetchMedia({ message_id: messageId, position }), signal);
          } catch (err) {
            if (!(err instanceof RequestError)) throw err;
            // Deleted since `getMessage`, or the daemon refused: the same answers as a read.
            deps.log("media_tool_requeue_refused", { code: err.code === "not_found" ? "not_found" : "other" });
            if (err.code === "not_found") throw new MediaToolError(strings.media.tool.noSuchFile);
            return text(strings.media.tool.readFailed, details);
          }
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

      // Hand the saved file to the agent: an image the model can see, or a path for its file tools.
      const present = async (saved: SavedMedia, reused: boolean): Promise<ToolResult> => {
        const mime = saved.contentType ?? item.mime;
        const savedFacts = { ...facts, size: formatSize(saved.size) };
        const savedDetails = { ...details, mime, size: saved.size, path: saved.path };
        if (MODEL_IMAGE_MIMES.has(mime)) {
          const imageResult = deps.imageResult ?? imageResultFromFile;
          try {
            const result = (await imageResult({
              label: strings.media.tool.label,
              path: saved.path,
              extraText: strings.media.tool.image(savedFacts, saved.path),
              details: savedDetails,
            })) as ToolResult;
            deps.log("media_tool_result", { state, returned: "image", reused });
            return result;
          } catch {
            // A file that claims to be an image but does not decode (truncated, corrupt): the copy is
            // saved, so hand over its path like any other file.
            deps.log("media_tool_result", { state, returned: "path", reused, image_failed: true });
            return text(strings.media.tool.saved(savedFacts, mime, saved.path), savedDetails);
          }
        }
        deps.log("media_tool_result", { state, returned: "path", reused });
        return text(strings.media.tool.saved(savedFacts, mime, saved.path), savedDetails);
      };

      // Opened before by this process and still on disk: no read, no second copy.
      const copyKey = `${accountId}\0${messageId}\0${position}`;
      const copy = savedCopies.get(copyKey);
      if (copy && (await (deps.fileSize ?? fileSizeOnDisk)(copy.path)) === copy.size) return present(copy, true);
      savedCopies.delete(copyKey);

      // The whole file is held in memory while it is saved: refuse a big one before reading a byte.
      const maxBytes = deps.maxOpenBytes();
      if ((item.stored_len ?? item.size) > maxBytes) {
        deps.log("media_tool_result", { state, returned: "over_limit" });
        return text(strings.media.tool.overLimit(facts.kind, formatSize(maxBytes)), details);
      }

      let bytes: Buffer;
      try {
        bytes = await untilAborted(() => client.getBlob({ message_id: messageId, position }, { timeoutMs: READ_TIMEOUT_MS }), signal);
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
      if (bytes.length > maxBytes) {
        // `stored_len` absent and the sender's advisory size understated the file.
        deps.log("media_tool_result", { state, returned: "over_limit" });
        return text(strings.media.tool.overLimit(facts.kind, formatSize(maxBytes)), details);
      }

      const saved = await deps.saveMediaBuffer(bytes, item.mime || undefined, "inbound", maxBytes, sanitizeFilename(item.filename) || undefined);
      rememberCopy(copyKey, saved);
      return present(saved, false);
    },
  };
}

/** Tool-policy entries that let this tool through: its name, the plugin id, every plugin tool, everything. */
const GRANTS = new Set([MEDIA_TOOL_NAME, CHANNEL_ID, "group:plugins", "*"]);

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()) : [];
const recordOf = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * The config places that plainly keep `ademu_get_media` from agents: a `deny` naming it, an explicit
 * `allow` without it, or the `minimal` profile (the one built-in profile the manifest does not list)
 * without an `alsoAllow`. Global `tools` and every agent's `tools` are checked; anything subtler
 * (per-provider or group policies) is the host's to resolve, so this only ever warns.
 */
export function mediaToolHiddenBy(cfg: unknown): string[] {
  const root = recordOf(cfg);
  const globalTools = recordOf(root?.tools);
  const agents = recordOf(root?.agents);
  const scopes: Array<{ label: string; tools: Record<string, unknown> | undefined }> = [{ label: "tools", tools: globalTools }];
  const list = Array.isArray(agents?.list) ? (agents.list as unknown[]) : [];
  list.forEach((a, i) => scopes.push({ label: `agents.list[${i}].tools`, tools: recordOf(recordOf(a)?.tools) }));
  for (const [key, a] of Object.entries(recordOf(agents?.entries) ?? {})) scopes.push({ label: `agents.entries.${key}.tools`, tools: recordOf(recordOf(a)?.tools) });

  const granted = (entries: string[]) => entries.some((e) => GRANTS.has(e));
  const hidden: string[] = [];
  for (const { label, tools } of scopes) {
    const isAgent = tools !== globalTools;
    if (isAgent && !tools) continue; // an agent without its own section inherits the global one, checked already
    const grants = [...listOf(tools?.allow), ...listOf(tools?.alsoAllow), ...(isAgent ? listOf(globalTools?.alsoAllow) : [])];
    if (granted(listOf(tools?.deny))) hidden.push(`${label}.deny`);
    else if (Array.isArray(tools?.allow) && !granted(grants)) hidden.push(`${label}.allow`);
    else if ((tools?.profile ?? (isAgent ? globalTools?.profile : undefined)) === "minimal" && !granted(grants)) hidden.push(`${label}.profile`);
  }
  return hidden;
}

const WARNED_KEY = Symbol.for("ademu.openclaw.mediaToolPolicyWarned");

export function registerMediaTool(api: OpenClawPluginApi, deps: MediaToolDeps): void {
  api.registerTool((ctx) => createMediaTool(ctx, deps) as never, { name: MEDIA_TOOL_NAME });
  // Once per process: the host registers the plugin again for every tool-discovery pass.
  const flags = globalThis as { [WARNED_KEY]?: boolean };
  if (flags[WARNED_KEY]) return;
  const hidden = mediaToolHiddenBy(api.config);
  if (hidden.length === 0) return;
  flags[WARNED_KEY] = true;
  api.logger.warn(strings.media.tool.hiddenByPolicy(hidden.join(", ")));
}
