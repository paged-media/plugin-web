/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// A minimal PNG encoder for the bake: straight RGBA8 → an 8-bit RGBA PNG
// (filter 0 rows, one IDAT). The zlib stream comes from the platform's
// `CompressionStream("deflate")` (browsers and Node 18+); without it the
// image data is stored uncompressed (valid zlib, larger), never dropped.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i += 1) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (v: number) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new TextEncoder().encode(type);
  return [u32(data.length), t, data, u32(crc32([t, data]))];
}

/** A zlib stream of `data` with stored (uncompressed) deflate blocks. */
export function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i += 1) {
    const start = i * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 255;
    out[o++] = len >>> 8;
    out[o++] = ~len & 255;
    out[o++] = (~len >>> 8) & 255;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  out.set(u32(adler32(data)), o);
  return out;
}

/** Below this many raw bytes the stream is stored, not compressed: tiny
 *  images gain nothing, and stored bytes are the same on every platform. */
const COMPRESS_FROM = 64 * 1024;

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < COMPRESS_FROM) return zlibStored(data);
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> })
    .CompressionStream;
  if (!CS) return zlibStored(data);
  try {
    const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CS("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return zlibStored(data);
  }
}

/** Encode straight RGBA8 pixels (`width*height*4` bytes) as a PNG. */
export async function encodePng(
  rgba: Uint8Array | readonly number[],
  width: number,
  height: number,
): Promise<Uint8Array> {
  const row = width * 4;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (row + 1)] = 0; // filter: none
    for (let i = 0; i < row; i += 1) raw[y * (row + 1) + 1 + i] = rgba[y * row + i];
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, filter 0, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", await zlib(raw)),
    ...chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
