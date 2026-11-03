import { describe, expect, it } from "vitest";
import { bodyForAgent, describeContent, escapeRuntimeContextDelimiters, formatSize, sanitizeFilename } from "../src/monitor/content.js";

const chat = (body: unknown, context?: unknown) => ({ protocol: "ademu.chat", body, ...(context !== undefined ? { context } : {}) }) as Parameters<typeof describeContent>[0];

describe("describeContent", () => {
  it("text, media, a view-once, any other chat body, and another protocol", () => {
    expect(describeContent(chat({ type: "text", text: "hi" }))).toEqual({ kind: "text", text: "hi" });
    expect(
      describeContent(chat({ type: "media", blobs: [{ type: "voice", filename: "v.m4a", mime: "audio/mp4", size: 10 }], caption: "listen" }, { media: [{ position: 0, fetch_state: "none" }] })),
    ).toEqual({
      kind: "media",
      files: [{ position: 0, type: "voice", filename: "v.m4a", mime: "audio/mp4", size: 10 }],
      caption: "listen",
    });
    expect(describeContent(chat({ type: "media", blobs: [], caption: "" }))).toEqual({ kind: "media", files: [], caption: "" });
    expect(describeContent(chat({ type: "view_once", blob: { type: "photo" }, caption: "" }))).toEqual({ kind: "view_once", type: "photo" });
    expect(describeContent(chat({ type: "reaction", target_message_id: "m1", emoji: "x", created_at_ms: 1 }))).toEqual({ kind: "unknown" });
    expect(describeContent(chat({ type: "poll" }))).toEqual({ kind: "unknown" });
    expect(describeContent(chat(3))).toEqual({ kind: "unknown" });
    expect(describeContent({ protocol: "example.cursor", body: { x: 1 } })).toEqual({ kind: "unknown" });
    expect(describeContent({ protocol: "ademu.call", body: { type: "record", call_id: "c" } })).toEqual({ kind: "unknown" });
  });

  it("keeps a file with an unknown type and fills bad fields with blanks", () => {
    expect(describeContent(chat({ type: "media", blobs: [{ type: "hologram", filename: 1, mime: null, size: -5 }], caption: 7 }, { media: [{ position: 0, fetch_state: "none" }] }))).toEqual({
      kind: "media",
      files: [{ position: 0, type: "hologram", filename: "", mime: "", size: 0 }],
      caption: "",
    });
  });

  it("takes each file's position from the daemon's context only, never from its order", () => {
    const c = describeContent(
      chat({ type: "media", blobs: [{ type: "photo" }, { type: "photo" }, { type: "photo" }], caption: "" }, { media: [{ position: 4, fetch_state: "none" }, { position: -1, fetch_state: "none" }] }),
    );
    expect(c.kind === "media" && c.files.map((f) => f.position)).toEqual([4, undefined, undefined]);
  });
});

describe("a location (AdemuMLS #941; bodies from ipc_v2.ndjson lines 157–158)", () => {
  const pin = { accuracy_m: 12.5, is_current: true, lat: 50.064712, lon: 19.944981, type: "location" };
  const start = { accuracy_m: 6.5, is_current: true, lat: 37.9416, live: { comment: "On my way", until_ms: 1_793_793_600_000 }, lon: 23.7392, type: "location" };

  it("a pin reads its coordinates; a live share's START its end time, with the comment as its caption", () => {
    expect(describeContent(chat(pin))).toEqual({ kind: "location", location: { lat: 50.064712, lon: 19.944981, isCurrent: true, accuracyM: 12.5, live: undefined } });
    expect(describeContent(chat(start))).toEqual({
      kind: "location",
      location: { lat: 37.9416, lon: 23.7392, isCurrent: true, accuracyM: 6.5, live: { untilMs: 1_793_793_600_000 } },
      comment: "On my way",
    });
    expect(describeContent(chat({ type: "location", lat: 1, lon: 2, is_current: false }))).toEqual({
      kind: "location",
      location: { lat: 1, lon: 2, isCurrent: false, accuracyM: undefined, live: undefined },
    });
  });

  it("coordinates out of range or not numbers read as an unknown kind; a live without an end reads as a pin", () => {
    expect(describeContent(chat({ type: "location", lat: 91, lon: 0, is_current: false }))).toEqual({ kind: "unknown" });
    expect(describeContent(chat({ type: "location", lat: "1", lon: 0, is_current: false }))).toEqual({ kind: "unknown" });
    expect(describeContent(chat({ type: "location", lat: 0, lon: Infinity, is_current: false }))).toEqual({ kind: "unknown" });
    expect(describeContent(chat({ type: "location", lat: 0, lon: 0, is_current: true, live: { comment: "x" } }))).toEqual({
      kind: "location",
      location: { lat: 0, lon: 0, isCurrent: true, accuracyM: undefined, live: undefined },
    });
    expect(describeContent({ protocol: "example.cursor", body: pin })).toEqual({ kind: "unknown" });
  });

  it("renders a pin, a picked place and a live START; the comment follows on its own line", () => {
    const text = (body: unknown) => {
      const c = describeContent(chat(body));
      if (c.kind === "text") throw new Error("text");
      return bodyForAgent(c.kind === "location" ? (c.comment ?? "") : "", c);
    };
    expect(text(pin)).toBe("[location: 50.064712, 19.944981 (±13 m) — the sender's current position]");
    expect(text({ type: "location", lat: 1, lon: 2, is_current: false })).toBe("[location: 1, 2 — a place the sender picked]");
    expect(text(start)).toBe("[started sharing live location until 2026-11-04T12:00:00Z: 37.9416, 23.7392 (±7 m)]\nOn my way");
  });

  it("a live_location position is not described as a location", () => {
    expect(describeContent(chat({ type: "live_location", target_message_id: "l2", lat: 1, lon: 2, seq: 3, until_ms: 1, fix_at_ms: 1, accuracy_m: 1 }))).toEqual({ kind: "unknown" });
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

  it("a view-once reads as a placeholder that only a phone opens", () => {
    expect(bodyForAgent("", { kind: "view_once", type: "photo" }, { messageId: "m-9" })).toBe("[a view-once photo — it can only be opened on a phone]");
    expect(bodyForAgent("", { kind: "view_once", type: "hologram" })).toBe("[a view-once file — it can only be opened on a phone]");
  });

  it("an unknown file type reads as a file; a voice note by its name", () => {
    expect(bodyForAgent("", { kind: "media", files: [{ position: 0, type: "hologram", filename: "h", mime: "", size: 0 }] })).toBe("[file: h — this channel can't open files yet]");
    expect(bodyForAgent("  ", { kind: "media", files: [{ position: 0, type: "voice", filename: "", mime: "", size: 2048 }] })).toBe("[voice note: 2.0 KB — this channel can't open files yet]");
  });

  it("with a message id, each line names the call that opens its file", () => {
    expect(
      bodyForAgent("", { kind: "media", files: [{ position: 0, type: "photo", filename: "a.jpg", mime: "image/jpeg", size: 0 }, { position: 1, type: "file", filename: "b.pdf", mime: "", size: 0 }] }, { messageId: "m-9" }),
    ).toBe(
      "[photo 1 of 2: a.jpg — open it with ademu_get_media message_id=m-9 position=0]\n[file 2 of 2: b.pdf — open it with ademu_get_media message_id=m-9 position=1]\n[if ademu_get_media is not among your tools, say you can't open files here; don't call it]",
    );
  });

  it("the note for an agent without the tool follows the lines, before the caption, and only when the lines name the tool", () => {
    const files = [{ position: 0, type: "photo", filename: "a.jpg", mime: "image/jpeg", size: 0 }];
    expect(bodyForAgent("look", { kind: "media", files }, { messageId: "m-9" })).toBe(
      "[photo: a.jpg — open it with ademu_get_media message_id=m-9 position=0]\n[if ademu_get_media is not among your tools, say you can't open files here; don't call it]\nlook",
    );
    expect(bodyForAgent("", { kind: "media", files })).not.toContain("ademu_get_media");
    expect(bodyForAgent("", { kind: "media", files: [] }, { messageId: "m-9" })).not.toContain("ademu_get_media");
  });

  it("a file without the daemon's position is never named to the tool", () => {
    const files = [
      { position: undefined, type: "photo", filename: "a.jpg", mime: "image/jpeg", size: 0 },
      { position: 1, type: "photo", filename: "b.jpg", mime: "image/jpeg", size: 0 },
    ];
    expect(bodyForAgent("", { kind: "media", files }, { messageId: "m-9" })).toBe(
      "[photo 1 of 2: a.jpg — this channel can't open files yet]\n[photo 2 of 2: b.jpg — open it with ademu_get_media message_id=m-9 position=1]\n[if ademu_get_media is not among your tools, say you can't open files here; don't call it]",
    );
    expect(bodyForAgent("", { kind: "media", files: [files[0]!] }, { messageId: "m-9" })).toBe("[photo: a.jpg — this channel can't open files yet]");
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
