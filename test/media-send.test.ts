// Sending files (#27): the shared core `sendAdemuMedia` over the fake client (which plays the 0.7.0
// client's composed send + wait), and the `send.media` adapter over a mocked host loader.
import { BlobWriteError, DetachedError, RequestError } from "@ademu/adc-client";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEXT_CHUNK_LIMIT,
  ademuMessageAdapter,
  refusalLine,
  registerLiveAccount,
  reportRefusals,
  resetLiveAccountsForTests,
  sendAdemuMedia,
  peekRefusalNote,
  type RefusalNotes,
} from "../src/outbound.js";
import { FakeAdcClient, MEDIA_SEND_ADVERT, ROOM_DM } from "./fakes/adc.js";
import { fakeLoader, tinyPng } from "./fakes/media-files.js";

vi.mock("openclaw/plugin-sdk/media-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  resolveOutboundAttachmentFromUrl: vi.fn(),
}));

const cfg = { channels: { ademu: {} } } as never;
const png = { bytes: tinyPng(), contentType: "image/png" };
const pdf = { bytes: Buffer.from("%PDF-1.4 tiny"), contentType: "application/pdf" };
const flush = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  resetLiveAccountsForTests();
  vi.mocked(resolveOutboundAttachmentFromUrl).mockReset();
});

describe("sendAdemuMedia", () => {
  it("a PNG goes as a photo with the reply text as its caption, under its original filename", async () => {
    const client = new FakeAdcClient();
    const load = fakeLoader({ "chart.png": png });
    const result = await sendAdemuMedia({ client, groupId: ROOM_DM, text: "here it is", urls: ["https://files.test/chart.png"], load });
    expect(result).toEqual({ album: { messageId: "media-1", status: "queued" }, text: [], refused: [] });
    expect(client.sent).toEqual([]);
    expect(client.mediaSends).toHaveLength(1);
    const [send] = client.mediaSends;
    expect(send!.caption).toBe("here it is");
    expect(send!.items[0]).toMatchObject({ type: "photo", mime: "image/png", filename: "chart.png", width: 2, height: 2 });
    expect(load.calls[0]!.maxBytes).toBe(MEDIA_SEND_ADVERT.max_bytes);
  });

  it("a HEIC (or a photo the client can't decode) goes as a file with the loader's mime", async () => {
    const client = new FakeAdcClient();
    const load = fakeLoader({ "IMG_1.heic": { bytes: Buffer.from("not really heic"), contentType: "image/heic" }, "bad.png": { bytes: Buffer.from("nope"), contentType: "image/png" } });
    await sendAdemuMedia({ client, groupId: ROOM_DM, urls: ["https://files.test/IMG_1.heic", "https://files.test/bad.png"], load });
    expect(client.mediaSends[0]!.items).toMatchObject([
      { type: "file", mime: "image/heic", filename: "IMG_1.heic" },
      { type: "file", mime: "image/png", filename: "bad.png" },
    ]);
    expect(client.mediaSends[0]!.caption).toBeUndefined();
  });

  it("a file the loader can't read is refused; the others still go, and an all-refused reply keeps its text", async () => {
    const client = new FakeAdcClient();
    const load = fakeLoader({ "a.pdf": pdf });
    const some = await sendAdemuMedia({ client, groupId: ROOM_DM, text: "two files", urls: ["https://files.test/a.pdf", "https://files.test/missing.pdf"], load });
    expect(some.refused).toEqual([{ name: "missing.pdf", reason: "load_failed" }]);
    expect(client.mediaSends[0]!.items.map((i) => i.filename)).toEqual(["a.pdf"]);
    expect(client.mediaSends[0]!.caption).toBe("two files");

    const none = await sendAdemuMedia({ client, groupId: ROOM_DM, text: "only text survives", urls: ["https://files.test/gone.pdf"], load });
    expect(none.refused).toEqual([{ name: "gone.pdf", reason: "load_failed" }]);
    expect(client.mediaSends).toHaveLength(1); // no album for nothing
    expect(client.sent.map((s) => s.body)).toEqual(["only text survives"]);
  });

  it("the hello's advert decides: an unaccepted type and files past max_items are refused before the send", async () => {
    const client = new FakeAdcClient();
    client.hello.media_send = { max_bytes: 1_000_000, max_items: 1, types: { photo: ["image/jpeg", "image/png"] } };
    const load = fakeLoader({ "a.pdf": pdf, "b.png": png, "c.png": png });
    const result = await sendAdemuMedia({ client, groupId: ROOM_DM, urls: ["https://files.test/a.pdf", "https://files.test/b.png"], load });
    expect(result.refused).toEqual([
      { name: "a.pdf", reason: "unsupported_type" },
      { name: "b.png", reason: "too_many" },
    ]);
    expect(client.mediaSends).toEqual([]);
  });

  it("text longer than a caption goes first as text; the album follows without a caption", async () => {
    const client = new FakeAdcClient();
    const text = "x".repeat(TEXT_CHUNK_LIMIT + 10);
    const result = await sendAdemuMedia({ client, groupId: ROOM_DM, text, urls: ["https://files.test/a.pdf"], load: fakeLoader({ "a.pdf": pdf }) });
    expect(result.text.length).toBeGreaterThanOrEqual(2);
    expect(client.mediaSends[0]!.caption).toBeUndefined();
    expect(result.album?.status).toBe("queued");
  });

  it("an album the daemon fails refuses every file with its code, and the caption is sent as text", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "failed", code: "store_failed" };
    const load = fakeLoader({ "a.pdf": pdf, "b.png": png });
    const result = await sendAdemuMedia({ client, groupId: ROOM_DM, text: "both", urls: ["https://files.test/a.pdf", "https://files.test/b.png"], load });
    expect(result.album).toBeUndefined();
    expect(result.refused).toEqual([
      { name: "a.pdf", reason: "store_failed" },
      { name: "b.png", reason: "store_failed" },
    ]);
    expect(client.sent.map((s) => s.body)).toEqual(["both"]);
  });

  it("thrown errors map to the closed list; anything unknown is `other`", async () => {
    const load = fakeLoader({ "a.pdf": pdf });
    const cases: Array<[Error | { status: "failed" | "cancelled"; code?: string }, string]> = [
      [new RequestError("send_media", "1", "too_large", "detail"), "too_large"],
      [new RequestError("send_media", "1", "brand_new_code", "detail"), "other"],
      [new BlobWriteError("peer_closed", 1, 10), "transfer_interrupted"],
      [new Error("boom"), "other"],
      [{ status: "cancelled" }, "cancelled"],
      [{ status: "failed", code: "something_new" }, "other"],
    ];
    for (const [outcome, reason] of cases) {
      const client = new FakeAdcClient();
      client.mediaOutcome = outcome;
      const result = await sendAdemuMedia({ client, groupId: ROOM_DM, urls: ["https://files.test/a.pdf"], load });
      expect(result.refused).toEqual([{ name: "a.pdf", reason }]);
    }
  });

  it("a send still pending after the wait counts as sent; a late failure resends the caption, posts the line and notes it for the agent", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "pending" };
    let settle!: (o: { message_id: string; status: "failed"; code: string }) => void;
    client.lateOutcome = new Promise((r) => (settle = r));
    const notes: RefusalNotes = new Map();
    const logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
    const result = await sendAdemuMedia({
      client,
      groupId: ROOM_DM,
      text: "the report",
      urls: ["https://files.test/a.pdf"],
      load: fakeLoader({ "a.pdf": pdf }),
      notes,
      log: (event, fields) => logs.push({ event, fields }),
    });
    expect(result.album).toEqual({ messageId: "media-1", status: "pending" });
    expect(logs).toEqual([
      { event: "media_send_pending", fields: { items: 1 } },
      { event: "media_send_result", fields: { status: "pending", items: 1, refused: 0, urls: 1 } },
    ]);
    expect(client.sent).toEqual([]);

    settle({ message_id: "media-1", status: "failed", code: "upload_failed" });
    await flush();
    expect(client.sent.map((s) => s.body)).toEqual(["the report", "[couldn't send a.pdf: the upload failed]"]);
    const note = peekRefusalNote(notes, ROOM_DM)!;
    expect(note.text).toBe("[your earlier file a.pdf was not delivered: the upload failed]");
    note.consume();
    expect(peekRefusalNote(notes, ROOM_DM)).toBeUndefined(); // once
    expect(logs.map((l) => l.event)).toContain("media_send_late_failure");
  });

  it("a late failure whose caption resend fails still posts the line and records the note (H3)", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "pending" };
    client.lateOutcome = Promise.resolve({ message_id: "media-1", status: "failed", code: "upload_failed" });
    const notes: RefusalNotes = new Map();
    const logs: string[] = [];
    let calls = 0;
    const sendText = client.sendText.bind(client);
    client.sendText = async (p) => {
      if (calls++ === 0) throw new Error("caption resend failed");
      return sendText(p);
    };
    await sendAdemuMedia({ client, groupId: ROOM_DM, text: "the report", urls: ["https://files.test/a.pdf"], load: fakeLoader({ "a.pdf": pdf }), notes, log: (e) => logs.push(e) });
    await flush();
    expect(client.sent.map((s) => s.body)).toEqual(["[couldn't send a.pdf: the upload failed]"]);
    expect(peekRefusalNote(notes, ROOM_DM)?.text).toBe("[your earlier file a.pdf was not delivered: the upload failed]");
    expect(logs).toContain("media_send_caption_resend_failed");
    expect(logs).not.toContain("media_send_wait_lost");
  });

  it("a lost wait (restart, end of session) is logged as such and posts nothing", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "pending" };
    const lost = Promise.reject(new DetachedError("closed"));
    lost.catch(() => {}); // handled by the watch once it attaches
    client.lateOutcome = lost;
    const logs: string[] = [];
    await sendAdemuMedia({ client, groupId: ROOM_DM, urls: ["https://files.test/a.pdf"], load: fakeLoader({ "a.pdf": pdf }), log: (e) => logs.push(e) });
    await flush();
    expect(logs).toContain("media_send_wait_lost");
    expect(client.sent).toEqual([]);
  });

  it("a failed album whose caption resend fails still returns the refusals (H4)", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "failed", code: "store_failed" };
    client.sendText = async () => {
      throw new Error("send_text failed");
    };
    const logs: string[] = [];
    const result = await sendAdemuMedia({ client, groupId: ROOM_DM, text: "caption", urls: ["https://files.test/a.pdf"], load: fakeLoader({ "a.pdf": pdf }), log: (e) => logs.push(e) });
    expect(result.refused).toEqual([{ name: "a.pdf", reason: "store_failed" }]);
    expect(result.text).toEqual([]);
    expect(logs).toContain("media_send_caption_resend_failed");
  });

  it("media_send_result: the album's outcome, declared items, refusals and reply files (closed-set fields)", async () => {
    const run = async (outcome: FakeAdcClient["mediaOutcome"], urls: string[]) => {
      const client = new FakeAdcClient();
      client.mediaOutcome = outcome;
      const logs: Array<Record<string, unknown> | undefined> = [];
      await sendAdemuMedia({ client, groupId: ROOM_DM, urls, load: fakeLoader({ "a.pdf": pdf, "b.png": png }), log: (event, fields) => event === "media_send_result" && logs.push(fields) });
      return logs[0];
    };
    expect(await run({ status: "queued" }, ["https://files.test/a.pdf", "https://files.test/gone.pdf"])).toEqual({ status: "queued", items: 1, refused: 1, urls: 2, code: "load_failed" });
    expect(await run({ status: "cancelled" }, ["https://files.test/a.pdf", "https://files.test/gone.pdf"])).toEqual({ status: "cancelled", items: 1, refused: 2, urls: 2, code: "cancelled" });
    expect(await run(new RequestError("send_media", "1", "not_a_member", "d"), ["https://files.test/a.pdf"])).toEqual({ status: "failed", items: 1, refused: 1, urls: 1, code: "not_a_member" });
    expect(await run({ status: "queued" }, ["https://files.test/gone.pdf"])).toEqual({ status: "refused", items: 0, refused: 1, urls: 1, code: "load_failed" });
  });

  it("a daemon without the media_send advert is a version mismatch: the send throws, and is counted", async () => {
    const client = new FakeAdcClient();
    delete client.hello.media_send;
    const logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
    await expect(
      sendAdemuMedia({ client, groupId: ROOM_DM, urls: ["https://files.test/a.pdf"], load: fakeLoader({}), log: (event, fields) => logs.push({ event, fields }) }),
    ).rejects.toThrow(/too old to send files/);
    expect(logs).toEqual([{ event: "media_send_result", fields: { status: "refused", items: 0, refused: 1, urls: 1, code: "other" } }]);
  });

  it("a note is consumed only for what was read: a refusal added meanwhile stays", async () => {
    const notes: RefusalNotes = new Map();
    const client = new FakeAdcClient();
    await reportRefusals({ client, groupId: ROOM_DM, refused: [{ name: "a.pdf", reason: "too_large" }], notes });
    const note = peekRefusalNote(notes, ROOM_DM)!;
    await reportRefusals({ client, groupId: ROOM_DM, refused: [{ name: "b.pdf", reason: "upload_failed" }], notes });
    note.consume();
    expect(peekRefusalNote(notes, ROOM_DM)?.text).toBe("[your earlier file b.pdf was not delivered: the upload failed]");
  });

  it("refusal lines group by reason and sanitize names", () => {
    expect(
      refusalLine([
        { name: "a.pdf", reason: "upload_failed" },
        { name: "b]\n[evil.png", reason: "store_failed" },
        { name: "c.mov", reason: "too_large" },
      ]),
    ).toBe("[couldn't send a.pdf, b) (evil.png: the upload failed]\n[couldn't send c.mov: it is too large]");
  });
});

describe("send.media adapter", () => {
  const stage = (files: Parameters<typeof fakeLoader>[0]) => {
    const load = fakeLoader(files);
    vi.mocked(resolveOutboundAttachmentFromUrl).mockImplementation((url, maxBytes) => load(url, maxBytes));
  };

  it("passes the host's raw media access fields to the loader and returns a media receipt", async () => {
    const client = new FakeAdcClient();
    registerLiveAccount("main", { client });
    stage({ "chart.png": png });
    const readFile = async () => Buffer.alloc(0);
    const r = await ademuMessageAdapter.send.media!({
      cfg,
      to: ROOM_DM,
      text: "caption",
      accountId: "main",
      mediaUrl: "https://files.test/chart.png",
      mediaLocalRoots: ["/workspace"],
      mediaReadFile: readFile,
    });
    expect(vi.mocked(resolveOutboundAttachmentFromUrl)).toHaveBeenCalledWith("https://files.test/chart.png", MEDIA_SEND_ADVERT.max_bytes, { localRoots: ["/workspace"], readFile });
    expect(r.messageId).toBe("media-1");
    expect(r.receipt.parts[0]?.kind).toBe("media");
  });

  it("the agent's own sends log through the account's logger", async () => {
    const client = new FakeAdcClient();
    const logs: string[] = [];
    registerLiveAccount("main", { client, log: (event) => logs.push(event) });
    stage({ "a.pdf": pdf });
    await ademuMessageAdapter.send.media!({ cfg, to: ROOM_DM, text: "", accountId: "main", mediaUrl: "https://files.test/a.pdf" });
    expect(logs).toEqual(["media_send_result"]);
  });

  it("pending is a success, not an error", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "pending" };
    registerLiveAccount("main", { client });
    stage({ "a.pdf": pdf });
    const r = await ademuMessageAdapter.send.media!({ cfg, to: ROOM_DM, text: "", accountId: "main", mediaUrl: "https://files.test/a.pdf" });
    expect(r.messageId).toBe("media-1");
  });

  it("a refused file throws the refusal line for the agent's tool call", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = new RequestError("send_media", "1", "not_a_member", "d");
    registerLiveAccount("main", { client });
    stage({ "a.pdf": pdf });
    const err = (await ademuMessageAdapter.send.media!({ cfg, to: ROOM_DM, text: "", accountId: "main", mediaUrl: "https://files.test/a.pdf" }).catch((e: unknown) => e)) as Error;
    expect(isChannelPartialDeliveryError(err)).toBe(false);
    expect(err.message).toBe("[couldn't send a.pdf: the agent is not in this conversation]");
  });

  it("a failure after the text already went out is a partial delivery", async () => {
    const client = new FakeAdcClient();
    client.mediaOutcome = { status: "failed", code: "upload_failed" };
    registerLiveAccount("main", { client });
    stage({ "a.pdf": pdf });
    const err = await ademuMessageAdapter.send
      .media!({ cfg, to: ROOM_DM, text: "caption", accountId: "main", mediaUrl: "https://files.test/a.pdf" })
      .catch((e: unknown) => e);
    expect(isChannelPartialDeliveryError(err)).toBe(true);
    expect(client.sent.map((s) => s.body)).toEqual(["caption"]);
  });

  it("proves the declared text and media capabilities", async () => {
    const client = new FakeAdcClient();
    registerLiveAccount("main", { client });
    stage({ "a.pdf": pdf });
    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "ademu",
      adapter: ademuMessageAdapter,
      proofs: {
        text: async () => {
          await ademuMessageAdapter.send.text!({ cfg, to: ROOM_DM, text: "proof", accountId: "main" });
        },
        media: async () => {
          const r = await ademuMessageAdapter.send.media!({ cfg, to: ROOM_DM, text: "", accountId: "main", mediaUrl: "https://files.test/a.pdf" });
          expect(r.receipt.platformMessageIds).toEqual(["media-1"]);
        },
      },
    });
    expect(results.find((r) => r.capability === "text")?.status).toBe("verified");
    expect(results.find((r) => r.capability === "media")?.status).toBe("verified");
    expect(results.filter((r) => r.capability !== "text" && r.capability !== "media").every((r) => r.status === "not_declared")).toBe(true);
  });
});
