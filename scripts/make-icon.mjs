#!/usr/bin/env node
// Generates the PLACEHOLDER plugin icon at assets/icon.png (256x256): a deep-teal rounded square
// with a white "A" made of straight strokes. Deterministic, zero dependencies — the owner supplies
// the real mark before launch (recorded in the design entry). Usage: `npm run icon`.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const BG = [0x0b, 0x3d, 0x3a]; // deep teal
const FG = [0xff, 0xff, 0xff];

function inRoundedSquare(x, y) {
  const r = 48;
  const cx = Math.min(Math.max(x, r), SIZE - 1 - r);
  const cy = Math.min(Math.max(y, r), SIZE - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// The letter A: two legs meeting at the apex plus a crossbar, drawn as thick segments.
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inLetter(x, y) {
  const w = 14;
  const apex = [128, 62];
  const left = [74, 196];
  const right = [182, 196];
  const bar = [[96, 150], [160, 150]];
  return (
    distToSegment(x, y, apex[0], apex[1], left[0], left[1]) <= w ||
    distToSegment(x, y, apex[0], apex[1], right[0], right[1]) <= w ||
    distToSegment(x, y, bar[0][0], bar[0][1], bar[1][0], bar[1][1]) <= w - 2
  );
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (!inRoundedSquare(x, y)) {
      raw[o] = raw[o + 1] = raw[o + 2] = raw[o + 3] = 0;
      continue;
    }
    const c = inLetter(x, y) ? FG : BG;
    raw[o] = c[0];
    raw[o + 1] = c[1];
    raw[o + 2] = c[2];
    raw[o + 3] = 255;
  }
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
