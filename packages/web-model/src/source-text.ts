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

// The TEXT NODES of a source, located in the source string — what in-frame
// editing writes through.
//
// The engine's inspected render names a painted character by its DOM text
// node's ORDINAL (its index among the text nodes under <body> that hold
// something other than white space, in document order) and an offset in
// that node's text. This scanner numbers the source's text the same way and
// keeps, per node, where it sits in the source and how each decoded
// character maps back to the raw bytes (entities, CRLF). An edit then
// replaces only the changed middle of the node's raw text, so markup and
// every untouched entity stay byte-identical.
//
// A scanner, not a parser (the diagnose.ts discipline): it never throws, and
// where the browser's tree building would move or merge text (text directly
// in a <table> is fostered out, an ignored end tag joins two runs) the
// numbering can disagree with the engine. The caller therefore checks the
// node's text against the engine's before it edits, and refuses on a
// mismatch — an edit lands where the user clicked or not at all.

/** Elements whose content is not numbered as text (raw text, form text,
 *  templates) — the same list as `web-render/src/inspect.rs`. */
const NO_TEXT = new Set([
  "style",
  "script",
  "template",
  "textarea",
  "title",
  "noscript",
  "iframe",
  "xmp",
  "noembed",
  "noframes",
]);

/** A leading newline right after these opening tags is dropped by the parser. */
const DROP_LEADING_NEWLINE = new Set(["pre", "listing", "textarea"]);

/** The named character references the decoder knows. An unknown one stays
 *  verbatim — then the node's text differs from the engine's and the edit
 *  is refused rather than guessed. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "­",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  zwj: "‍",
  zwnj: "‌",
};

/** One numbered text node of a source. */
export interface SourceTextNode {
  /** Ordinal among the non-white-space text nodes, document order. */
  ordinal: number;
  /** `[start, end)` of the node's RAW text in the source string. */
  start: number;
  end: number;
  /** The decoded text (what the DOM holds). */
  text: string;
  /** For each decoded UTF-16 unit `i`, the raw offset (relative to `start`)
   *  where it begins; `rawAt[text.length]` is the raw length. */
  rawAt: number[];
}

interface Decoded {
  text: string;
  rawAt: number[];
}

/** Decode a raw text run: character references and CR/CRLF. */
function decode(raw: string): Decoded {
  let text = "";
  const rawAt: number[] = [];
  let i = 0;
  const push = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) rawAt.push(at);
    text += s;
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === "&") {
      const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(raw.slice(i, i + 40));
      if (m) {
        const body = m[1];
        let out: string | undefined;
        if (body[0] === "#") {
          const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          if (Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
            out = String.fromCodePoint(code);
          }
        } else {
          out = NAMED[body];
        }
        if (out !== undefined) {
          push(out, i);
          i += m[0].length;
          continue;
        }
      }
      push("&", i);
      i += 1;
      continue;
    }
    if (c === "\r") {
      push("\n", i);
      i += raw[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    push(c, i);
    i += 1;
  }
  rawAt.push(raw.length);
  return { text, rawAt };
}

/**
 * Number the text nodes of an HTML fragment (the body content of a web
 * frame source). Pure and total: any input yields a list.
 */
export function scanTextNodes(html: string): SourceTextNode[] {
  const out: SourceTextNode[] = [];
  if (typeof html !== "string" || html.length === 0) return out;
  let i = 0;
  let textStart = 0;
  let lastOpenTag = "";
  const flush = (end: number) => {
    if (end <= textStart) return;
    let start = textStart;
    let raw = html.slice(start, end);
    if (DROP_LEADING_NEWLINE.has(lastOpenTag)) {
      const drop = raw.startsWith("\r\n") ? 2 : raw.startsWith("\n") || raw.startsWith("\r") ? 1 : 0;
      start += drop;
      raw = raw.slice(drop);
    }
    lastOpenTag = "";
    const d = decode(raw);
    if (!/\S/.test(d.text)) return; // white space only: not numbered
    out.push({ ordinal: out.length, start, end, text: d.text, rawAt: d.rawAt });
  };
  while (i < html.length) {
    if (html[i] !== "<") {
      i += 1;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      flush(i);
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? html.length : close + 3;
      textStart = i;
      lastOpenTag = "";
      continue;
    }
    const next = html[i + 1] ?? "";
    if (next === "!" || next === "?") {
      flush(i);
      const close = html.indexOf(">", i + 2);
      i = close === -1 ? html.length : close + 1;
      textStart = i;
      lastOpenTag = "";
      continue;
    }
    const closing = next === "/";
    const nameStart = closing ? i + 2 : i + 1;
    if (!/[A-Za-z]/.test(html[nameStart] ?? "")) {
      i += 1; // a literal "<"
      continue;
    }
    flush(i);
    // The tag runs to the next ">" outside quotes.
    let j = nameStart;
    while (j < html.length && /[A-Za-z0-9-]/.test(html[j])) j += 1;
    const name = html.slice(nameStart, j).toLowerCase();
    let quote = "";
    while (j < html.length) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    i = j + 1;
    textStart = i;
    lastOpenTag = closing ? "" : name;
    if (!closing && NO_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      i = close === -1 ? html.length : close;
      textStart = i;
      lastOpenTag = "";
    }
  }
  flush(html.length);
  return out;
}

/** Escape text for an HTML text position. */
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

/**
 * Replace the text of `node` in `html` by `next` (decoded text), touching
 * only the raw bytes of the part that changed: the common prefix and suffix
 * of the old and new text keep their raw form (entities included), the
 * middle is escaped. Returns the new source.
 */
export function editTextNode(html: string, node: SourceTextNode, next: string): string {
  const prev = node.text;
  if (prev === next) return html;
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev[p] === next[p]) p += 1;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s += 1;
  // Never cut inside a decoded entity: rawAt groups the units of one
  // reference at the same raw offset, so widen to whole references.
  while (p > 0 && node.rawAt[p] === node.rawAt[p - 1]) p -= 1;
  while (s > 0 && node.rawAt[prev.length - s] === node.rawAt[prev.length - s - 1]) s -= 1;
  const rawFrom = node.start + node.rawAt[p];
  const rawTo = node.start + node.rawAt[prev.length - s];
  return html.slice(0, rawFrom) + escapeText(next.slice(p, next.length - s)) + html.slice(rawTo);
}
