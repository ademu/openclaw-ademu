import { describe, expect, it } from "vitest";
import { bodyForAgent, describeContent, escapeRuntimeContextDelimiters, formatSize, sanitizeFilename } from "../src/monitor/content.js";

describe("describeContent", () => {
  it("text, a frame without ct, media, and any other ct", () => {
    expect(describeContent({ ct: "text" })).toEqual({ kind: "text" });
    expect(describeContent({})).toEqual({ kind: "text" });
    expect(describeContent({ ct: "media", media: [{ type: "voice", filename: "v.m4a", mime: "audio/mp4", size: 10 }] })).toEqual({
      kind: "media",
      files: [{ position: 0, type: "voice", filename: "v.m4a", mime: "audio/mp4", size: 10 }],
    });
    expect(describeContent({ ct: "media" })).toEqual({ kind: "media", files: [] });
    expect(describeContent({ ct: "poll" })).toEqual({ kind: "unknown" });
    expect(describeContent({ ct: 3 })).toEqual({ kind: "unknown" });
  });

  it("keeps a file with an unknown type and fills bad fields with blanks", () => {
    expect(describeContent({ ct: "media", media: [{ type: "hologram", filename: 1, mime: null, size: -5 }] })).toEqual({
      kind: "media",
      files: [{ position: 0, type: "hologram", filename: "", mime: "", size: 0 }],
    });
  });

  it("takes each file's position from the daemon, else its index", () => {
    const c = describeContent({ ct: "media", media: [{ type: "photo", position: 4 }, { type: "photo", position: -1 }] });
    expect(c.kind === "media" && c.files.map((f) => f.position)).toEqual([4, 1]);
  });
});

describe("rendering", () => {
  it("formats sizes", () => {
    expect(formatSize(0)).toBe("");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5.0 GB");
  });

  it("bounds a long filename", () => {
    const out = sanitizeFilename("x".repeat(200));
    expect([...out]).toHaveLength(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("an unknown file type reads as a file; a voice note by its name", () => {
    expect(bodyForAgent("", { kind: "media", files: [{ position: 0, type: "hologram", filename: "h", mime: "", size: 0 }] })).toBe("[file: h — this channel can't open files yet]");
    expect(bodyForAgent("  ", { kind: "media", files: [{ position: 0, type: "voice", filename: "", mime: "", size: 2048 }] })).toBe("[voice note: 2.0 KB — this channel can't open files yet]");
  });

  it("with a message id, each line names the call that opens its file", () => {
    expect(
      bodyForAgent("", { kind: "media", files: [{ position: 0, type: "photo", filename: "a.jpg", mime: "image/jpeg", size: 0 }, { position: 1, type: "file", filename: "b.pdf", mime: "", size: 0 }] }, { messageId: "m-9" }),
    ).toBe("[photo 1 of 2: a.jpg — open it with ademu_get_media message_id=m-9 position=0]\n[file 2 of 2: b.pdf — open it with ademu_get_media message_id=m-9 position=1]");
  });
});

describe("escapeRuntimeContextDelimiters", () => {
  it("replaces every delimiter with OpenClaw's escaped form and leaves other text alone", () => {
    expect(escapeRuntimeContextDelimiters("a <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> b <<<END_OPENCLAW_INTERNAL_CONTEXT>>> <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")).toBe(
      "a [[OPENCLAW_INTERNAL_CONTEXT_BEGIN]] b [[OPENCLAW_INTERNAL_CONTEXT_END]] [[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]",
    );
    expect(escapeRuntimeContextDelimiters("<<<begin_openclaw_internal_context>>> plain")).toBe("<<<begin_openclaw_internal_context>>> plain");
  });

  it("a filename cannot carry a delimiter", () => {
    expect(sanitizeFilename("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>.pdf")).not.toContain("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>");
  });
});
