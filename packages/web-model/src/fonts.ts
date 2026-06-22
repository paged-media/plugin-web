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

// Font parity — the W1 slice (BREAKAGE_LOG W-01 follow-up). The
// preview iframe renders with BROWSER DEFAULT fonts while the engine
// document has REGISTERED document fonts; this module is the pure
// half that lets the panel stop the source lane from lying about
// typography. It does two host-free things:
//
//   1. `familiesUsed` — scan `font-family` usage out of the source
//      CSS (longhand + the `font:` shorthand), returning the ordered
//      family NAMES each declaration asks for (the fallback stack).
//   2. `diagnoseFonts` — given those used families and the families
//      the DOCUMENT registers (passed in as plain data — web-model
//      stays host-agnostic; the panel feeds the collections-door
//      result), emit parity diagnostics.
//
// The bytes question is settled by the host contract, not here: the
// `fonts` collection door crosses family NAMES only (wire FontSummary
// has no face bytes; the only bytes-carrying message is the engine's
// host→worker `registerFont`). So this is the MATCH/REPORT half; the
// preview substitutes and BADGES, and serving real `@font-face` bytes
// is the W-06 asset-store dependency. The scanner is a scanner, not a
// parser — it must never crash on garbage CSS.

import type { WebDiagnostic } from "./diagnose";

/** Generic CSS font families — never "missing from the document":
 *  they map to the browser's own families, not document faces. */
const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace",
  "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial",
  "unset", "revert", "revert-layer", "default",
]);

/** CSS-wide / keyword tokens a `font:` shorthand may carry that are
 *  NOT family names — filtered so the shorthand parser doesn't read
 *  `bold`/`italic`/`12px` as a typeface. Deliberately small: the
 *  scanner errs toward treating an unknown bare word as a family
 *  (the lint is a hint, and an over-report reads as "is this in the
 *  document?", never a crash). */
const SHORTHAND_NON_FAMILY = new Set([
  // <font-style>
  "normal", "italic", "oblique",
  // <font-variant> (the common ones)
  "small-caps",
  // <font-weight>
  "bold", "bolder", "lighter",
  "100", "200", "300", "400", "500", "600", "700", "800", "900",
  // <font-stretch>
  "ultra-condensed", "extra-condensed", "condensed", "semi-condensed",
  "semi-expanded", "expanded", "extra-expanded", "ultra-expanded",
  // system font keywords
  "caption", "icon", "menu", "message-box", "small-caption", "status-bar",
]);

/** Strip CSS comments so a `font-family` inside `/* … *\/` doesn't
 *  read as usage. Tolerant of an unterminated comment (garbage in →
 *  best-effort out, never a throw). */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) break; // unterminated — drop the rest
      i = end + 2;
      continue;
    }
    out += css[i];
    i += 1;
  }
  return out;
}

/** Split a comma-separated family list into trimmed names, unquoting
 *  `"…"`/`'…'` and dropping empties. A bare (unquoted) family may be
 *  multi-word per CSS — we keep it verbatim (whitespace-collapsed). */
function splitFamilies(list: string): string[] {
  return list
    .split(",")
    .map((raw) => {
      const t = raw.trim();
      if (
        (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'"))
      ) {
        return t.slice(1, -1).trim();
      }
      return t.replace(/\s+/g, " ");
    })
    .filter((t) => t.length > 0);
}

/** From a `font:` shorthand VALUE, recover the family list. Per the
 *  grammar the family list is the trailing run after `<font-size>`
 *  (optionally `/<line-height>`). We don't parse the whole grammar;
 *  we take the substring AFTER the last `/` if present, else after
 *  the first size-looking token, and filter out the non-family
 *  keywords. Anything we can't confidently classify falls through as
 *  a candidate family — an over-report is a harmless "in document?"
 *  hint, never a crash. */
function familiesFromShorthand(value: string): string[] {
  // Everything after a line-height slash is the family list; if no
  // slash, drop the size/weight/style keyword run up to the last
  // size-looking token.
  let tail = value;
  const slash = value.lastIndexOf("/");
  if (slash !== -1) {
    // `…/1.2 "Family", serif` → after the size token following `/`.
    const afterSlash = value.slice(slash + 1).trim();
    const sp = afterSlash.indexOf(" ");
    tail = sp === -1 ? "" : afterSlash.slice(sp + 1);
  } else {
    // No line height: split tokens, find the last <size>-looking one
    // (contains a digit), families are everything after it.
    const head = value.split(",")[0].trim();
    const tokens = head.split(/\s+/);
    let lastSizeIdx = -1;
    for (let k = 0; k < tokens.length; k++) {
      if (/\d/.test(tokens[k])) lastSizeIdx = k;
    }
    const firstFamilyTokens =
      lastSizeIdx === -1 ? tokens : tokens.slice(lastSizeIdx + 1);
    tail =
      firstFamilyTokens.join(" ") +
      (value.includes(",") ? "," + value.slice(value.indexOf(",") + 1) : "");
  }
  return splitFamilies(tail).filter(
    (f) => !SHORTHAND_NON_FAMILY.has(f.toLowerCase()),
  );
}

// One positional scanner so source order is preserved across both
// forms. `font-family:` (longhand) carries the family list directly;
// the `font:` shorthand (a `font:` NOT followed by `-family`) needs
// the shorthand recovery. A leading boundary keeps `font:` from
// matching inside `font-family:` etc.
const FONT_DECL =
  /(?:^|[;{}\s])font(-family)?\s*:\s*([^;{}]*)/gi;

/**
 * The ordered set of font families the source CSS requests — from
 * both `font-family:` longhand and the `font:` shorthand. Generic
 * families (serif, monospace, …) are excluded: they resolve to the
 * browser's own families, not document faces. The result preserves
 * source order and dedups case-insensitively (keeping the first-seen
 * casing). Never throws on malformed CSS.
 */
export function familiesUsed(css: string): string[] {
  if (typeof css !== "string" || css.length === 0) return [];
  const clean = stripComments(css);
  const seen = new Map<string, string>(); // lowercased → first casing
  const push = (fam: string): void => {
    const key = fam.toLowerCase();
    if (GENERIC.has(key)) return;
    if (!seen.has(key)) seen.set(key, fam);
  };

  let m: RegExpExecArray | null;
  FONT_DECL.lastIndex = 0;
  while ((m = FONT_DECL.exec(clean)) !== null) {
    const isLonghand = m[1] !== undefined;
    const value = m[2] ?? "";
    const fams = isLonghand
      ? splitFamilies(value)
      : familiesFromShorthand(value);
    for (const fam of fams) push(fam);
  }
  return Array.from(seen.values());
}

/** Case-insensitive membership, tolerant of surrounding whitespace —
 *  the document registry and the CSS may differ only in casing. */
function registrySet(registered: readonly string[]): Set<string> {
  const s = new Set<string>();
  for (const r of registered) {
    if (typeof r === "string") s.add(r.trim().toLowerCase());
  }
  return s;
}

export interface FontParity {
  /** Families the source asks for that the document does NOT register
   *  — text WILL substitute in the engine document (and in the
   *  preview). The preview must badge this. */
  unregistered: string[];
  /** Families the document registers AND the source uses — resolvable
   *  matches. The preview still can't inject their BYTES (W-06), so
   *  they substitute in the iframe too, but they are honest in the
   *  engine document. */
  matched: string[];
}

/**
 * Compare the families the source uses against the families the
 * DOCUMENT registers (the `fonts` collection's family names, passed
 * in as data). Pure: no host, no DOM. The `registered` list is the
 * door's `FontSummary[].family` projection — web-model never reaches
 * for it, the panel feeds it.
 */
export function fontParity(
  css: string,
  registered: readonly string[],
): FontParity {
  const reg = registrySet(registered);
  const unregistered: string[] = [];
  const matched: string[] = [];
  for (const fam of familiesUsed(css)) {
    if (reg.has(fam.toLowerCase())) matched.push(fam);
    else unregistered.push(fam);
  }
  return { unregistered, matched };
}

/** One document font face the host's asset store resolved to BYTES
 *  (W-06). The bundle wraps the bytes in an object URL and composes an
 *  `@font-face` rule, then drops the badge for that family. Host-free:
 *  the panel hands web-model the already-resolved `{ family, src }`
 *  (the object URL it created from the asset bytes), web-model only
 *  composes the CSS — it never touches `URL`/`Blob`/bytes (the linter
 *  stays a pure, DOM-free scanner). */
export interface ResolvedFontFace {
  /** The family name to declare (the document-canonical family). */
  family: string;
  /** A URL the iframe can load the face from — an object URL the panel
   *  created from the served bytes (`URL.createObjectURL(blob)`). */
  src: string;
  /** The `@font-face` `format()` hint, when known. */
  format?: "truetype" | "opentype" | "woff" | "woff2";
}

// Base64 without `btoa`/`Buffer` — web-model is pure TS with no DOM
// and no node built-ins, and the input may be a SharedArrayBuffer-
// backed view (the worker's served bytes): plain indexed reads work on
// those where `Blob`/`btoa` paths reject or require copies.
const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

/** The data-url MIME for a face container format. */
function fontMime(format: ResolvedFontFace["format"]): string {
  switch (format) {
    case "truetype":
      return "font/ttf";
    case "opentype":
      return "font/otf";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

/**
 * Inline served face BYTES as a `data:` URL for the `@font-face` `src`
 * (the W-06 real-bytes path). A `data:` URL — not an object URL — is
 * the only kind the preview can actually load: the iframe is sandboxed
 * with `sandbox=""` (OPAQUE origin, §6.1), and `blob:` URLs are bound
 * to the origin that minted them, so the opaque-origin document cannot
 * fetch the panel's blobs. Inlining also kills the revoke lifecycle.
 * Pure string assembly; empty/invalid bytes → `""` (caller skips).
 */
export function fontFaceDataUrl(
  bytes: Uint8Array,
  format?: ResolvedFontFace["format"],
): string {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return "";
  return `data:${fontMime(format)};base64,${toBase64(bytes)}`;
}

/** Map an asset `format` to the CSS `format()` keyword. */
function cssFormat(
  format: ResolvedFontFace["format"],
): string | null {
  switch (format) {
    case "truetype":
      return "truetype";
    case "opentype":
      return "opentype";
    case "woff":
      return "woff";
    case "woff2":
      return "woff2";
    default:
      return null;
  }
}

/** Escape a family name for a CSS string literal (quotes/backslashes).
 *  The family comes from the document registry; escaping keeps a stray
 *  quote from breaking out of the `@font-face` block (defence in depth —
 *  the iframe is already sandboxed with no script). */
function cssStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Compose `@font-face` CSS for the faces the host resolved to bytes
 * (W-06). Pure string assembly — the panel created the object URLs from
 * the asset store's bytes; web-model only emits the rules so the
 * sandboxed preview loads the DOCUMENT's actual faces. Empty input → "".
 * Faces with no usable `src` are skipped (defensive; never throws).
 */
export function composeFontFaces(faces: readonly ResolvedFontFace[]): string {
  const rules: string[] = [];
  for (const face of faces) {
    if (
      !face ||
      typeof face.family !== "string" ||
      face.family.length === 0 ||
      typeof face.src !== "string" ||
      face.src.length === 0
    ) {
      continue;
    }
    const fmt = cssFormat(face.format);
    const srcExpr = fmt
      ? `url(${face.src}) format("${fmt}")`
      : `url(${face.src})`;
    rules.push(
      `@font-face{font-family:${cssStringLiteral(face.family)};` +
        `src:${srcExpr};font-display:block;}`,
    );
  }
  return rules.join("");
}

/**
 * Parity diagnostics for the source panel + the host problems lane.
 * `source: "css"` (the families come from CSS). Two vocab entries:
 *   · "font not in document"  (warning) — a used family the document
 *     does not register; it will substitute.
 *   · "document font not previewable" (info) — a used family the
 *     document DOES register, but the preview can't load its bytes
 *     (no asset-store door — W-06), so the iframe substitutes it. The
 *     badge says so; this info makes the reason explicit per family.
 *
 * When the registry is empty (door not wired / no document fonts) we
 * emit nothing rather than flag every family — absence of a registry
 * is not evidence a family is missing.
 *
 * W-06 flip: `shown` lists the registered families whose BYTES the host
 * asset store served and the panel composed into a real `@font-face` —
 * those are now SHOWN in the preview, so they emit NO "not previewable"
 * info. A registered-but-not-shown family still gets the info (e.g. the
 * host has no bytes for it). The substitution WARNING for an
 * unregistered family is unchanged (no bytes can exist for it).
 */
export function diagnoseFonts(
  css: string,
  registered: readonly string[],
  shown: readonly string[] = [],
): WebDiagnostic[] {
  const used = familiesUsed(css);
  if (used.length === 0) return [];
  const reg = registrySet(registered);
  if (reg.size === 0) return [];
  const shownSet = registrySet(shown);
  const out: WebDiagnostic[] = [];
  for (const fam of used) {
    if (reg.has(fam.toLowerCase())) {
      // Resolved to real bytes and shown → no caveat to emit.
      if (shownSet.has(fam.toLowerCase())) continue;
      out.push({
        severity: "info",
        message: `document font “${fam}” is not previewable here (the preview substitutes it — see badge)`,
        source: "css",
      });
    } else {
      out.push({
        severity: "warning",
        message: `font “${fam}” is not in the document — text will substitute`,
        source: "css",
      });
    }
  }
  return out;
}
