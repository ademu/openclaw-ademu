// What an inbound message carries, by `ct` (AdemuMLS PROTOCOL.md "a mind dispatches on `ct`"; #440).
// `text` keeps the ingress path as it was. A daemon that serves media (#440) sends `ct:"media"` with
// `body` = the caption (often "") and `media[]` metadata; the bytes stay in the daemon. Any other
// `ct` is content this plugin does not handle. Both still become a turn — acked at adoption like
// text, never held — whose text tells the agent what arrived: OpenClaw drops media facts that carry
// no path or url, so the text is the only way the agent learns of a file.
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

/** `position` undefined = the frame did not give one, so the file cannot be named to `ademu_get_media`. */
export type FileFacts = { position: number | undefined; type: string; filename: string; mime: string; size: number };

export type InboundContent = { kind: "text" } | { kind: "media"; files: FileFacts[] } | { kind: "unknown" };

/** A frame without `ct` predates the field and is text; only `"media"` is media. */
export function describeContent(ev: { ct?: unknown; media?: unknown }): InboundContent {
  if (ev.ct === undefined || ev.ct === "text") return { kind: "text" };
  if (ev.ct !== "media") return { kind: "unknown" };
  const files: FileFacts[] = [];
  if (Array.isArray(ev.media)) {
    for (const item of ev.media as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const m = item as Record<string, unknown>;
      if (typeof m.type !== "string" || m.type.length === 0) continue;
      files.push({
        position: typeof m.position === "number" && Number.isSafeInteger(m.position) && m.position >= 0 ? m.position : undefined,
        type: m.type,
        filename: typeof m.filename === "string" ? m.filename : "",
        mime: typeof m.mime === "string" ? m.mime : "",
        size: typeof m.size === "number" && Number.isFinite(m.size) && m.size > 0 ? m.size : 0,
      });
    }
  }
  return { kind: "media", files };
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
      : content.files.length === 0
        ? [strings.media.anyFile]
        : content.files.map((f, i) => fileLine(f, i, content.files.length, opts));
  // The lines name a tool the host's tool policy may not give this agent: say what to do then, so the
  // agent does not retry a call it cannot make.
  if (content.kind === "media" && content.files.some((f) => openable(f, opts))) lines.push(strings.media.openNote);
  return caption.trim().length > 0 ? `${lines.join("\n")}\n${caption}` : lines.join("\n");
}
