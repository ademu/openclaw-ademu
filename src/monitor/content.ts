// What an inbound frame carries (AdemuMLS PROTOCOL.md §`received`, envelope v2 — #978). The frame's
// `body` is the protocol's: for `ademu.chat` a `text`, a `media` (render fields per blob, the caption;
// the bytes stay in the daemon and each file's state rides `context.media`) or a `view_once`
// placeholder; anything else is content this plugin does not turn into a turn. Media and a view-once
// still become a turn — acked at adoption like text, never held — whose text tells the agent what
// arrived: OpenClaw drops media facts that carry no path or url, so the text is the only way the
// agent learns of a file.
import { chatBodyOf, type ReceivedContext } from "@ademu/adc-client";
import { strings } from "../i18n/strings.js";

// OpenClaw before 2026.9.3 lifts any `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` … `<<<END_…>>>` block it
// finds in a turn's prompt into hidden "runtime context" and does not escape inbound text
// (openclaw/openclaw#140404). Every sender-controlled string the plugin hands the host is escaped to
// OpenClaw's own escaped forms, so no message, caption, filename or name can open or close such a
// block. Independent of the host version; 2026.9.3+ escapes again on its side.
const RUNTIME_CONTEXT_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
  ["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]"],
  ["<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", "[[OPENCLAW_INTERNAL_CONTEXT_END]]"],
];

export function escapeRuntimeContextDelimiters(text: string): string {
  let out = text;
  for (const [raw, escaped] of RUNTIME_CONTEXT_DELIMITERS) out = out.replaceAll(raw, escaped);
  return out;
}

/** `position` undefined = the daemon's context did not give one, so the file cannot be named to `ademu_get_media`. */
export type FileFacts = { position: number | undefined; type: string; filename: string; mime: string; size: number };

export type InboundContent =
  | { kind: "text"; text: string }
  | { kind: "media"; files: FileFacts[]; caption?: string }
  | { kind: "view_once"; type: string }
  | { kind: "unknown" };

/** The frame fields the description reads: the envelope and the daemon's context. */
export type InboundFrame = { protocol: string; body: unknown; context?: ReceivedContext | undefined };

/**
 * The `ademu.chat` body, read structurally: a `text` is text; a `media` is its blobs (in position
 * order) with each file's position taken from the daemon's `context.media` — never from its order —
 * and its caption; a `view_once` is its kind. Any other protocol or body type is unknown.
 */
export function describeContent(ev: InboundFrame): InboundContent {
  const body = chatBodyOf(ev);
  if (!body) return { kind: "unknown" };
  switch (body.type) {
    case "text":
      return { kind: "text", text: typeof body.text === "string" ? body.text : "" };
    case "media": {
      const files: FileFacts[] = [];
      const blobs: unknown[] = Array.isArray(body.blobs) ? body.blobs : [];
      const states: unknown[] = Array.isArray(ev.context?.media) ? ev.context.media : [];
      blobs.forEach((item, index) => {
        if (typeof item !== "object" || item === null) return;
        const m = item as Record<string, unknown>;
        if (typeof m.type !== "string" || m.type.length === 0) return;
        const state = states[index];
        const position = typeof state === "object" && state !== null ? (state as Record<string, unknown>).position : undefined;
        files.push({
          position: typeof position === "number" && Number.isSafeInteger(position) && position >= 0 ? position : undefined,
          type: m.type,
          filename: typeof m.filename === "string" ? m.filename : "",
          mime: typeof m.mime === "string" ? m.mime : "",
          size: typeof m.size === "number" && Number.isFinite(m.size) && m.size > 0 ? m.size : 0,
        });
      });
      return { kind: "media", files, caption: typeof body.caption === "string" ? body.caption : "" };
    }
    case "view_once":
      return { kind: "view_once", type: typeof body.blob?.type === "string" ? body.blob.type : "" };
    default:
      return { kind: "unknown" };
  }
}

const MAX_FILENAME = 80;

/** A sender-chosen filename reaches the model: no control or format characters, no brackets, bounded. */
export function sanitizeFilename(name: string): string {
  const clean = escapeRuntimeContextDelimiters(name)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length > MAX_FILENAME ? `${chars.slice(0, MAX_FILENAME - 1).join("")}…` : clean;
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `messageId` set = the daemon serves files (`get_blob`): each line says how to open its file. */
export type DescribeOptions = { messageId?: string | undefined };

/** Only a file with the daemon's own position can be opened: the tool looks it up by that, never by order. */
const openable = (file: FileFacts, opts: DescribeOptions): opts is { messageId: string } =>
  opts.messageId !== undefined && file.position !== undefined;

function fileLine(file: FileFacts, index: number, count: number, opts: DescribeOptions): string {
  return strings.media.file({
    kind: strings.media.kinds[file.type as keyof typeof strings.media.kinds] ?? strings.media.kinds.file,
    ordinal: count > 1 ? { index: index + 1, count } : undefined,
    filename: sanitizeFilename(file.filename),
    size: formatSize(file.size),
    open: openable(file, opts) ? { messageId: opts.messageId, position: file.position! } : undefined,
  });
}

/**
 * The turn's text for a non-text message: one line per file (or one line for an unknown kind), then
 * the caption. The lines come FIRST so a caption can never make the turn read as a slash command.
 * With `messageId` (a daemon that serves files) each line names the `ademu_get_media` call that opens it,
 * followed by one note for an agent the tool is hidden from.
 */
export function bodyForAgent(caption: string, content: Exclude<InboundContent, { kind: "text" }>, opts: DescribeOptions = {}): string {
  const lines =
    content.kind === "unknown"
      ? [strings.media.unknownKind]
      : content.kind === "view_once"
        ? [strings.media.viewOnce(strings.media.kinds[content.type as keyof typeof strings.media.kinds] ?? strings.media.kinds.file)]
        : content.files.length === 0
          ? [strings.media.anyFile]
          : content.files.map((f, i) => fileLine(f, i, content.files.length, opts));
  // The lines name a tool the host's tool policy may not give this agent: say what to do then, so the
  // agent does not retry a call it cannot make.
  if (content.kind === "media" && content.files.some((f) => openable(f, opts))) lines.push(strings.media.openNote);
  return caption.trim().length > 0 ? `${lines.join("\n")}\n${caption}` : lines.join("\n");
}
