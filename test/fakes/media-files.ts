// Files for the media-send tests: a real (tiny) PNG the client's photo prep can decode, and a loader
// that stands in for the host's `resolveOutboundAttachmentFromUrl` — it stages each file in a temp dir
// under the host store's `name---<uuid>.ext` naming, so the original-filename logic is exercised.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { MediaLoader } from "../../src/outbound.js";

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A 2×2 RGB PNG. */
export function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export type FakeFile = { bytes: Buffer; contentType?: string };

/** `https://files.test/<name>` (or a bare name) → a staged copy of `files[name]`; unknown names and files over `maxBytes` throw. */
export function fakeLoader(files: Record<string, FakeFile>): MediaLoader & { calls: Array<{ url: string; maxBytes: number }> } {
  const dir = mkdtempSync(join(tmpdir(), "ademu-media-send-"));
  const calls: Array<{ url: string; maxBytes: number }> = [];
  const load = async (url: string, maxBytes: number) => {
    calls.push({ url, maxBytes });
    const name = basename(url.replace(/^https:\/\/files\.test\//, ""));
    const file = files[name];
    if (!file) throw new Error("fetch failed");
    if (file.bytes.length > maxBytes) throw new Error("Media exceeds limit");
    const ext = extname(name);
    const path = join(dir, `${basename(name, ext)}---${randomUUID()}${ext}`);
    writeFileSync(path, file.bytes);
    return { path, ...(file.contentType ? { contentType: file.contentType } : {}) };
  };
  return Object.assign(load, { calls });
}
