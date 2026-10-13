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

// `.html` FILE intake → a WebFrameSource. A SCANNER, not a parser (the
// linter's stance — it must never crash on bad input): `<style>` bodies
// are collected into the source's css lane and excised from the html;
// when a `<body>` exists its inner content becomes the html (the
// document shell around it — doctype/head — is meaningless inside a
// frame). The result then rides the normal sanitize pass (script/
// handler/javascript: removal) in the caller.
//
// The scanner walks the markup the way a browser tokenizes it as far as
// tags go: a comment (`<!-- … -->`) and the content of a raw-text element
// (`<script>`, `<style>`, `<title>`, `<textarea>`, …) are text, never tags.
// So a `<style>` or `<body>` a comment or a script string NAMES is not
// read as one (a mailer whose head comment said "the <style> block becomes
// the CSS" had its CSS start inside that comment).

import { sanitizeHtml, type SanitizeResult } from "./sanitize";
import { DEFAULT_SOURCE, type WebFrameSource } from "./source";

/** Elements whose content is text up to their end tag (HTML raw-text and
 *  escapable raw-text elements). */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

const TAG_NAME = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/;

export interface HtmlFileImport {
  source: WebFrameSource;
  /** What the sanitize pass removed (script blocks, handlers, js: URLs). */
  removed: SanitizeResult["removed"];
}

/** Where the scanner found things: each `<style>` element's span and
 *  content, and the body's inner span. */
interface Scan {
  styles: { start: number; end: number; css: string }[];
  bodyStart: number | null;
  bodyEnd: number | null;
}

/** The index just past the `>` that closes the tag starting at `from`
 *  (quoted attribute values may hold `>`), or the text's length. */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return text.length;
}

/** The start of `</name` at or after `from` (case-insensitive), or -1. */
function endTagAt(lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const next = lower[at + needle.length];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) return at;
    at = lower.indexOf(needle, at + 1);
  }
  return -1;
}

function scan(text: string): Scan {
  const lower = text.toLowerCase();
  const out: Scan = { styles: [], bodyStart: null, bodyEnd: null };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      if (close < 0) break; // an unclosed comment runs to the end
      i = close + 3;
      continue;
    }
    const m = TAG_NAME.exec(text.slice(lt, lt + 64));
    if (!m) {
      // `<!doctype …>`, `<?…>`, a stray `<`: not a tag we act on.
      i = text[lt + 1] === "!" || text[lt + 1] === "?" ? tagEnd(text, lt) : lt + 1;
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const end = tagEnd(text, lt);
    if (closing) {
      if (name === "body" && out.bodyStart !== null && out.bodyEnd === null) out.bodyEnd = lt;
      i = end;
      continue;
    }
    if (name === "body" && out.bodyStart === null) out.bodyStart = end;
    if (RAW_TEXT.has(name)) {
      const close = endTagAt(lower, name, end);
      const contentEnd = close < 0 ? text.length : close;
      const after = close < 0 ? text.length : tagEnd(text, close);
      if (name === "style") out.styles.push({ start: lt, end: after, css: text.slice(end, contentEnd) });
      i = after;
      continue;
    }
    i = end;
  }
  return out;
}

/** Split a whole `.html` FILE into the panel's two lanes and sanitize.
 *  Total on any input: no `<style>`/`<body>` → css stays empty and the
 *  full (sanitized) text is the html. */
export function sourceFromHtmlFile(text: string): HtmlFileImport {
  const found = scan(text);
  const css = found.styles.map((s) => s.css.trim()).filter((c) => c.length > 0);
  // The html is the body's inner content (to the end of the file when the
  // body never closes), else the whole text — with its style blocks cut.
  const from = found.bodyStart ?? 0;
  let to = found.bodyStart === null ? text.length : (found.bodyEnd ?? text.length);
  if (found.bodyStart !== null && found.bodyEnd === null) {
    const tail = /<\/html\s*>\s*$/i.exec(text.slice(from, to));
    if (tail) to = from + tail.index;
  }
  let raw = "";
  let at = from;
  for (const s of found.styles) {
    if (s.end <= from || s.start >= to) continue;
    raw += text.slice(at, Math.max(at, s.start));
    at = Math.max(at, s.end);
  }
  raw += text.slice(at, Math.max(at, to));
  const { html, removed } = sanitizeHtml(raw.trim());
  return {
    source: { html, css: css.join("\n\n"), options: { ...DEFAULT_SOURCE.options } },
    removed,
  };
}
