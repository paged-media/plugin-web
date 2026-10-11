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

// The `@font-face` rules of a source, read without a CSS parser, and the
// little a host needs to know about a face's bytes: its format, its own
// family name, and the bytes of a `data:` URL. Pure — no host, no DOM.
//
// The engine (Blitz) loads these faces itself through the resource provider
// and lays text out with them; engine-inputs.ts hands the same bytes to the
// host's scene-layer face table so the canvas draws the runs in them too.

/** One `@font-face` rule: the family it declares, its `url()` sources in
 *  order, its style as a face name (`"Bold"`, `"Light Italic"`, undefined
 *  for a regular face or a weight range), and the directory its URLs
 *  resolve against. */
export interface CssFace {
  family: string;
  srcs: string[];
  style: string | undefined;
  base: string;
}

const FONT_FACE = /@font-face\s*\{([^}]*)\}/gi;
const SRC_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** The declarations of a rule body, split on the `;` that sit outside
 *  parentheses and quotes (a `data:` URL carries its own). */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let quote = "";
  let start = 0;
  const take = (end: number) => {
    const decl = block.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) out.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim());
    start = end + 1;
  };
  for (let i = 0; i < block.length; i += 1) {
    const c = block[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) take(i);
  }
  take(block.length);
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** The face name of a weight and slope, as the asset store names styles. */
export function faceStyle(weight: string | null, slope: string | null): string | undefined {
  const w = (weight ?? "normal").trim().toLowerCase();
  const italic = /^(italic|oblique)\b/i.test((slope ?? "").trim());
  // A range (`100 900`, a variable face) covers every weight: no style.
  if (/^\d+(\.\d+)?\s+\d/.test(w)) return italic ? "Italic" : undefined;
  const n = w === "bold" ? 700 : w === "normal" ? 400 : Number.parseFloat(w);
  const rounded = Number.isFinite(n) ? Math.min(900, Math.max(100, Math.round(n / 100) * 100)) : 400;
  const name = WEIGHT_NAMES[rounded];
  if (name && italic) return `${name} Italic`;
  return name ?? (italic ? "Italic" : undefined);
}

/** The `@font-face` rules `text` (a document with inline CSS, or a
 *  stylesheet) declares that name a family and at least one `url()`. A
 *  scanner: it never throws. */
export function fontFaceRules(text: string, base = ""): CssFace[] {
  const out: CssFace[] = [];
  let m: RegExpExecArray | null;
  FONT_FACE.lastIndex = 0;
  while ((m = FONT_FACE.exec(text)) !== null) {
    const decls = declarations(m[1]);
    const family = unquote(decls.get("font-family") ?? "");
    const src = decls.get("src") ?? "";
    const srcs: string[] = [];
    let u: RegExpExecArray | null;
    SRC_URL.lastIndex = 0;
    while ((u = SRC_URL.exec(src)) !== null) {
      const url = (u[1] ?? u[2] ?? u[3] ?? "").trim();
      if (url) srcs.push(url);
    }
    if (!family || srcs.length === 0) continue;
    out.push({
      family,
      srcs,
      style: faceStyle(decls.get("font-weight") ?? null, decls.get("font-style") ?? null),
      base,
    });
  }
  return out;
}

/** A face's container format by its magic bytes. */
export function fontFormat(bytes: Uint8Array): "sfnt" | "woff" | "woff2" | null {
  if (bytes.byteLength < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "OTTO" || tag === "true" || tag === "ttcf" || tag === "\u0000\u0001\u0000\u0000") return "sfnt";
  return null;
}

function decodeName(bytes: Uint8Array, platform: number): string {
  if (platform === 1) return String.fromCharCode(...bytes);
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

/** A TrueType/OpenType face's own family — the typographic family (name
 *  id 16), else the family (name id 1), English first — the name the
 *  engine reports for a run shaped with it. `null` for any other bytes (a
 *  collection reads its first face). */
export function sfntFamily(bytes: Uint8Array): string | null {
  try {
    if (fontFormat(bytes) !== "sfnt") return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let font = 0;
    if (view.getUint32(0) === 0x74746366) font = view.getUint32(12); // 'ttcf'
    const tables = view.getUint16(font + 4);
    let name = -1;
    for (let i = 0; i < tables; i += 1) {
      const rec = font + 12 + i * 16;
      if (view.getUint32(rec) === 0x6e616d65) name = view.getUint32(rec + 8); // 'name'
    }
    if (name < 0) return null;
    const count = view.getUint16(name + 2);
    const strings = name + view.getUint16(name + 4);
    let best: { id: number; rank: number; text: string } | null = null;
    for (let i = 0; i < count; i += 1) {
      const rec = name + 6 + i * 12;
      const platform = view.getUint16(rec);
      const language = view.getUint16(rec + 4);
      const id = view.getUint16(rec + 6);
      if (id !== 16 && id !== 1) continue;
      if (platform !== 0 && platform !== 1 && platform !== 3) continue;
      const length = view.getUint16(rec + 8);
      const offset = strings + view.getUint16(rec + 10);
      const text = decodeName(bytes.subarray(offset, offset + length), platform).trim();
      if (!text) continue;
      const english = (platform === 3 && language === 0x409) || (platform === 1 && language === 0);
      const rank = (id === 16 ? 0 : 2) + (english ? 0 : 1);
      if (!best || rank < best.rank) best = { id, rank, text };
    }
    return best?.text ?? null;
  } catch {
    return null;
  }
}

/** The bytes of a `data:` URL (base64 or percent-encoded), or `null`. */
export function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:([^,]*),(.*)$/is.exec(url.trim());
  if (!m) return null;
  try {
    if (/;base64$/i.test(m[1])) {
      const bin = atob(m[2].replace(/\s+/g, ""));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    }
    const out: number[] = [];
    const s = m[2];
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
        out.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        out.push(...new TextEncoder().encode(s[i]));
      }
    }
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

/** FNV-1a over the bytes: the identity of a face's bytes. */
export function bytesHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + bytes.byteLength.toString(16);
}
