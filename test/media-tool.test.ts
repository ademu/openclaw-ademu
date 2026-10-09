// The `ademu_get_media` tool (openclaw-ademu #22): scope, every fetch state, read failures, saving.
import { BlobReadError, RequestError, type MediaItem, type MessageSummary } from "@ademu/adc-client";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it } from "vitest";
import { registerLiveAccount, resetLiveAccountsForTests } from "../src/outbound.js";
import { createMediaTool, mediaToolHiddenBy, MediaToolError, registerMediaTool, resetSavedCopiesForTests, type MediaToolDeps, type SavedMedia } from "../src/tools/media.js";
import { ROOM_DM, ROOM_GROUP } from "./fakes/adc.js";

type Loose<T> = { [K in keyof T]?: T[K] | undefined };

const photo = (over: Loose<MediaItem> = {}): MediaItem => ({
  position: 0,
  type: "photo",
  mime: "image/jpeg",
  size: 2048,
  filename: "IMG_0042.jpg",
  fetch_state: "fetched",
  stored_len: 2048,
  ...over,
}) as MediaItem;

const summary = (over: Loose<MessageSummary> = {}): MessageSummary => ({
  message_id: "m-1",
  group_id: ROOM_DM,
  sender_user_id: "u",
  sender_username: "marios",
  is_outgoing: false,
  ct: "media",
  body: "",
  created_at_ms: 0,
  reactions: [],
  media: [photo()],
  ...over,
}) as MessageSummary;

class FakeMedia {
  capabilities = new Set(["get_blob", "fetch_media"]);
  messages = new Map<string, MessageSummary>([["m-1", summary()]]);
  bytes = Buffer.from("plaintext-bytes");
  blobError: unknown;
  fetchError: unknown;
  /** Set: getBlob waits on this instead of answering at once. */
  blobGate: Promise<void> | undefined;
  reads: Array<{ message_id: string; position: number; timeoutMs: number | undefined }> = [];
  fetches: Array<{ message_id: string; position?: number | undefined }> = [];
  async getMessage(p: { message_id: string }) {
    const m = this.messages.get(p.message_id);
    if (!m) throw new RequestError("get_message", "1", "not_found", "no such message");
    return m;
  }
  async getBlob(p: { message_id: string; position: number }, o?: { timeoutMs?: number }) {
    this.reads.push({ ...p, timeoutMs: o?.timeoutMs });
    if (this.blobGate) await this.blobGate;
    if (this.blobError) throw this.blobError;
    return this.bytes;
  }
  async fetchMedia(p: { message_id: string; position?: number }) {
    this.fetches.push(p);
    if (this.fetchError) throw this.fetchError;
    return { files: [{ position: p.position ?? 0, fetch_state: "none" }] };
  }
}

const LIMIT = 50 * 1024 * 1024;

function setup(opts: { ctx?: Loose<OpenClawPluginToolContext>; register?: boolean; savedType?: string; maxOpenBytes?: number; imageFails?: boolean } = {}) {
  const media = new FakeMedia();
  if (opts.register !== false) registerLiveAccount("iris", { client: {} as never, media: media as never });
  const saves: Array<{ size: number; contentType: string | undefined; subdir: string | undefined; maxBytes: number | undefined; name: string | undefined }> = [];
  const images: Array<{ path: string; extraText?: string | undefined }> = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
  /** Saved copies "on disk": path → size. Empty = every copy is gone. */
  const disk = new Map<string, number>();
  const deps: MediaToolDeps = {
    saveMediaBuffer: async (buffer, contentType, subdir, maxBytes, name): Promise<SavedMedia> => {
      saves.push({ size: buffer.length, contentType, subdir, maxBytes, name });
      const type = opts.savedType ?? contentType;
      return { path: "/state/media/inbound/IMG_0042---uuid.jpg", size: buffer.length, ...(type ? { contentType: type } : {}) };
    },
    imageResult: async (p) => {
      if (opts.imageFails) throw new Error("Input buffer contains unsupported image format");
      images.push(p);
      return { content: [{ type: "text", text: p.extraText }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }], details: p.details };
    },
    maxOpenBytes: () => opts.maxOpenBytes ?? LIMIT,
    fileSize: async (path) => disk.get(path),
    log: (event, fields) => logs.push({ event, fields }),
  };
  const ctx = {
    messageChannel: "ademu",
    agentAccountId: "iris",
    deliveryContext: { channel: "ademu", to: `ademu:${ROOM_DM}`, accountId: "iris" },
    ...opts.ctx,
  } as unknown as OpenClawPluginToolContext;
  const tool = createMediaTool(ctx, deps);
  const call = (args: Record<string, unknown>, signal?: AbortSignal) => tool!.execute("call-1", args, signal);
  return { media, tool, call, saves, images, logs, disk };
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

afterEach(() => {
  resetLiveAccountsForTests();
  resetSavedCopiesForTests();
});

describe("ademu_get_media: offered on Ademú turns only", () => {
  it("returns null on another channel's turn", () => {
    expect(setup({ ctx: { messageChannel: "telegram" } }).tool).toBeNull();
  });
});

describe("ademu_get_media: a downloaded file", () => {
  it("a photo is saved with the configured ceiling and returned as an image", async () => {
    const w = setup();
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(w.media.reads).toEqual([{ message_id: "m-1", position: 0, timeoutMs: 30_000 }]);
    expect(w.saves).toEqual([{ size: w.media.bytes.length, contentType: "image/jpeg", subdir: "inbound", maxBytes: LIMIT, name: "IMG_0042.jpg" }]);
    expect(w.images).toHaveLength(1);
    expect(w.images[0]!.path).toBe("/state/media/inbound/IMG_0042---uuid.jpg");
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    expect(w.logs).toEqual([{ event: "media_tool_result", fields: { state: "fetched", returned: "image", reused: false } }]);
  });

  it("a PDF is saved and its path returned as text", async () => {
    const w = setup();
    w.media.messages.set("m-1", summary({ media: [photo({ type: "file", mime: "application/pdf", filename: "report.pdf", stored_len: 15 })] }));
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(w.images).toHaveLength(0);
    expect(textOf(r)).toBe("Saved the file report.pdf (application/pdf, 15 B) at /state/media/inbound/IMG_0042---uuid.jpg. Use your file tools to read it.");
    expect(r.details).toMatchObject({ state: "fetched", path: "/state/media/inbound/IMG_0042---uuid.jpg", mime: "application/pdf" });
  });

  it("the type detected by the store decides: a HEIC photo is not handed to the model as an image", async () => {
    const w = setup({ savedType: "image/heic" });
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(w.images).toHaveLength(0);
    expect(textOf(r)).toContain("Saved the photo IMG_0042.jpg (image/heic");
  });

  it("an image that does not decode comes back as its saved path", async () => {
    const w = setup({ imageFails: true });
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(textOf(r)).toBe("Saved the photo IMG_0042.jpg (image/jpeg, 15 B) at /state/media/inbound/IMG_0042---uuid.jpg. Use your file tools to read it.");
    expect(w.logs).toEqual([{ event: "media_tool_result", fields: { state: "fetched", returned: "path", reused: false, image_failed: true } }]);
  });

  it("accepts the position as a numeric string", async () => {
    const w = setup();
    await w.call({ message_id: "m-1", position: "0" });
    expect(w.media.reads).toHaveLength(1);
  });
});

describe("ademu_get_media: size limit and saved copies", () => {
  it("a file above the limit is refused before a byte is read", async () => {
    const w = setup({ maxOpenBytes: 1024 });
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(textOf(r)).toBe("This photo is larger than this gateway opens (1.0 KB), so it was not read. The gateway's owner can raise the Ademú plugin's mediaMaxOpenMb setting.");
    expect(w.media.reads).toEqual([]);
    expect(w.saves).toEqual([]);
    expect(w.logs).toEqual([{ event: "media_tool_result", fields: { state: "fetched", returned: "over_limit" } }]);
  });

  it("without stored_len the sender's size decides first, and the bytes read are checked again", async () => {
    const w = setup({ maxOpenBytes: 10 });
    w.media.messages.set("m-1", summary({ media: [photo({ size: 4, stored_len: undefined })] }));
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(w.media.reads).toHaveLength(1);
    expect(textOf(r)).toContain("larger than this gateway opens");
    expect(w.saves).toEqual([]);
  });

  it("a file opened again reuses the saved copy while it is still on disk", async () => {
    const w = setup();
    await w.call({ message_id: "m-1", position: 0 });
    w.disk.set("/state/media/inbound/IMG_0042---uuid.jpg", w.media.bytes.length);
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(w.media.reads).toHaveLength(1);
    expect(w.saves).toHaveLength(1);
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    expect(w.logs.at(-1)).toEqual({ event: "media_tool_result", fields: { state: "fetched", returned: "image", reused: true } });
  });

  it("a saved copy that is gone or changed is read and saved again", async () => {
    const w = setup();
    await w.call({ message_id: "m-1", position: 0 });
    w.disk.set("/state/media/inbound/IMG_0042---uuid.jpg", 3);
    await w.call({ message_id: "m-1", position: 0 });
    w.disk.clear();
    await w.call({ message_id: "m-1", position: 0 });
    expect(w.media.reads).toHaveLength(3);
    expect(w.saves).toHaveLength(3);
  });

  it("a reused copy still goes through scope and state: a deleted message is no such file", async () => {
    const w = setup();
    await w.call({ message_id: "m-1", position: 0 });
    w.disk.set("/state/media/inbound/IMG_0042---uuid.jpg", w.media.bytes.length);
    w.media.messages.set("m-1", summary({ deleted: true, media: undefined }));
    await expect(w.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/no such file/);
  });
});

describe("ademu_get_media: never waits", () => {
  for (const state of ["none", "fetching"]) {
    it(`${state}: still downloading, nothing read`, async () => {
      const w = setup();
      w.media.messages.set("m-1", summary({ media: [photo({ fetch_state: state, stored_len: undefined })] }));
      const r = await w.call({ message_id: "m-1", position: 0 });
      expect(textOf(r)).toBe("This photo is still downloading to this device. Ask again in a few seconds.");
      expect(w.media.reads).toEqual([]);
    });
  }

  it("failed: the download is queued again", async () => {
    const w = setup();
    w.media.messages.set("m-1", summary({ media: [photo({ fetch_state: "failed" })] }));
    const r = await w.call({ message_id: "m-1", position: 0 });
    expect(w.media.fetches).toEqual([{ message_id: "m-1", position: 0 }]);
    expect(textOf(r)).toContain("queued again");
    expect(w.media.reads).toEqual([]);
  });

  it("failed, then deleted before the re-queue: no such file; any other refusal: try again", async () => {
    const w = setup();
    w.media.messages.set("m-1", summary({ media: [photo({ fetch_state: "failed" })] }));
    w.media.fetchError = new RequestError("fetch_media", "1", "not_found", "deleted meanwhile");
    await expect(w.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/no such file/);
    w.media.fetchError = new RequestError("fetch_media", "1", "query_failed", "db busy");
    expect(textOf(await w.call({ message_id: "m-1", position: 0 }))).toContain("Reading the file failed");
    expect(w.logs.filter((l) => l.event === "media_tool_requeue_refused").map((l) => l.fields)).toEqual([{ code: "not_found" }, { code: "other" }]);
  });

  it("unavailable and too_large are final answers", async () => {
    const w = setup();
    w.media.messages.set("m-1", summary({ media: [photo({ fetch_state: "unavailable" }), photo({ position: 1, fetch_state: "too_large" })] }));
    expect(textOf(await w.call({ message_id: "m-1", position: 0 }))).toContain("no longer available");
    expect(textOf(await w.call({ message_id: "m-1", position: 1 }))).toContain("larger than this device accepts");
    expect(w.media.reads).toEqual([]);
    expect(w.media.fetches).toEqual([]);
  });

  it("a race (not_fetched on read) reads as still downloading", async () => {
    const w = setup();
    w.media.blobError = new RequestError("get_blob", "1", "not_fetched", "fetching");
    expect(textOf(await w.call({ message_id: "m-1", position: 0 }))).toContain("still downloading");
  });
});

describe("ademu_get_media: scope and refusals", () => {
  it("a file from another conversation is refused before anything about it is revealed", async () => {
    const w = setup();
    w.media.messages.set("m-1", summary({ group_id: ROOM_GROUP }));
    await expect(w.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/not in this conversation/);
    expect(w.media.reads).toEqual([]);
    expect(w.logs).toEqual([{ event: "media_tool_refused", fields: { reason: "other_conversation" } }]);
  });

  it("the conversation falls back to nativeChannelId; with neither it refuses", async () => {
    const a = setup({ ctx: { deliveryContext: undefined, nativeChannelId: ROOM_DM.toUpperCase() } });
    await a.call({ message_id: "m-1", position: 0 });
    expect(a.media.reads).toHaveLength(1);
    resetLiveAccountsForTests();
    const b = setup({ ctx: { deliveryContext: undefined } });
    await expect(b.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/while answering an Ademú conversation/);
  });

  it("an unknown or deleted message, a text message, and a missing position are all 'no such file'", async () => {
    const w = setup();
    w.media.messages.set("m-del", summary({ message_id: "m-del", deleted: true, media: undefined }));
    w.media.messages.set("m-txt", summary({ message_id: "m-txt", ct: "text", media: undefined }));
    for (const args of [{ message_id: "m-nope", position: 0 }, { message_id: "m-del", position: 0 }, { message_id: "m-txt", position: 0 }, { message_id: "m-1", position: 3 }]) {
      await expect(w.call(args)).rejects.toThrow(MediaToolError);
    }
    w.media.blobError = new RequestError("get_blob", "1", "not_found", "deleted meanwhile");
    await expect(w.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/no such file/);
  });

  it("bad arguments are refused without touching the daemon", async () => {
    const w = setup();
    for (const args of [{}, { message_id: "m-1" }, { message_id: "m-1", position: -1 }, { message_id: " ", position: 0 }, { message_id: "m-1", position: 1.5 }]) {
      await expect(w.call(args)).rejects.toThrow(/exactly as the file's line/);
    }
    expect(w.media.reads).toEqual([]);
  });

  it("account not running; a daemon without get_blob", async () => {
    const a = setup({ register: false });
    await expect(a.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/not running/);
    const b = setup();
    b.media.capabilities.delete("get_blob");
    await expect(b.call({ message_id: "m-1", position: 0 })).rejects.toThrow(/too old to serve files/);
  });
});

describe("ademu_get_media: read failures", () => {
  it("a refused or broken read asks the agent to try again; the log carries the reason only", async () => {
    const w = setup();
    w.media.blobError = new BlobReadError("short_read", 0, 2048);
    expect(textOf(await w.call({ message_id: "m-1", position: 0 }))).toContain("Reading the file failed");
    expect(w.logs.at(-1)).toEqual({ event: "media_tool_read_failed", fields: { reason: "short_read", received: false } });
  });

  it("too many tickets: busy, try again", async () => {
    const w = setup();
    w.media.blobError = new RequestError("get_blob", "1", "too_many_tickets", "20 outstanding");
    expect(textOf(await w.call({ message_id: "m-1", position: 0 }))).toContain("Too many files");
  });

  it("an aborted turn reads nothing", async () => {
    const w = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(w.call({ message_id: "m-1", position: 0 }, ac.signal)).rejects.toThrow();
    expect(w.media.reads).toEqual([]);
  });

  it("a turn aborted mid-read stops waiting at once and saves nothing", async () => {
    const w = setup();
    let release!: () => void;
    w.media.blobGate = new Promise<void>((r) => (release = r));
    const ac = new AbortController();
    const pending = w.call({ message_id: "m-1", position: 0 }, ac.signal);
    await new Promise((r) => setImmediate(r));
    expect(w.media.reads).toHaveLength(1);
    ac.abort(new Error("turn aborted"));
    await expect(pending).rejects.toThrow("turn aborted");
    release();
    await new Promise((r) => setImmediate(r));
    expect(w.saves).toEqual([]);
  });

  it("no log line carries an id, a filename or a path", async () => {
    const w = setup();
    await w.call({ message_id: "m-1", position: 0 });
    w.media.messages.set("m-1", summary({ group_id: ROOM_GROUP }));
    await w.call({ message_id: "m-1", position: 0 }).catch(() => {});
    const logged = JSON.stringify(w.logs);
    for (const secret of ["m-1", "IMG_0042", "/state/", ROOM_DM, ROOM_GROUP]) expect(logged).not.toContain(secret);
  });
});

describe("ademu_get_media: a tool policy that hides it", () => {
  it("names the config places that plainly keep the tool from agents", () => {
    expect(mediaToolHiddenBy({})).toEqual([]);
    expect(mediaToolHiddenBy({ tools: { profile: "coding" } })).toEqual([]);
    expect(mediaToolHiddenBy({ tools: { profile: "minimal" } })).toEqual(["tools.profile"]);
    expect(mediaToolHiddenBy({ tools: { profile: "minimal", alsoAllow: ["ademu_get_media"] } })).toEqual([]);
    expect(mediaToolHiddenBy({ tools: { profile: "minimal", alsoAllow: ["ademu"] } })).toEqual([]);
    expect(mediaToolHiddenBy({ tools: { allow: ["read", "exec"] } })).toEqual(["tools.allow"]);
    expect(mediaToolHiddenBy({ tools: { allow: ["group:plugins"] } })).toEqual([]);
    expect(mediaToolHiddenBy({ tools: { deny: ["ADEMU_GET_MEDIA"] } })).toEqual(["tools.deny"]);
    expect(
      mediaToolHiddenBy({
        tools: { profile: "coding" },
        agents: { list: [{ id: "a" }, { id: "b", tools: { profile: "minimal" } }, { id: "c", tools: { profile: "minimal", alsoAllow: ["ademu_get_media"] } }] },
      }),
    ).toEqual(["agents.list[1].tools.profile"]);
    expect(mediaToolHiddenBy({ tools: { profile: "minimal", alsoAllow: ["*"] }, agents: { entries: { iris: { tools: { deny: ["ademu"] } } } } })).toEqual([
      "agents.entries.iris.tools.deny",
    ]);
  });

  it("warns once per process, on the host logger", () => {
    const warned: string[] = [];
    const api = {
      config: { tools: { profile: "minimal" } },
      registerTool: () => {},
      logger: { info: () => {}, warn: (m: string) => warned.push(m), error: () => {} },
    } as never;
    const deps = { saveMediaBuffer: async () => ({ path: "", size: 0 }), maxOpenBytes: () => LIMIT, log: () => {} } as MediaToolDeps;
    const key = Symbol.for("ademu.openclaw.mediaToolPolicyWarned");
    delete (globalThis as Record<symbol, unknown>)[key];
    registerMediaTool(api, deps);
    registerMediaTool(api, deps);
    expect(warned).toEqual([
      'ademu_get_media is kept from agents by tools.profile: agents see the files people send but cannot open them. Add "ademu_get_media" to tools.alsoAllow (or to that agent\'s tools.alsoAllow), or remove it from the deny list.',
    ]);
    delete (globalThis as Record<symbol, unknown>)[key];
  });
});
