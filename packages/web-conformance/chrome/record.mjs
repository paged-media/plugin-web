#!/usr/bin/env node
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

// record.mjs — the Chrome oracle for single-frame layout.
//
// For every fixture in `fixtures/*.html` and every frame width in WIDTHS,
// headless Chromium (Playwright) lays the fixture out in a WIDTH x HEIGHT
// viewport with the engine's own font file injected, and we write
// `recorded/<fixture>@<width>.json`:
//
//   elements  every [data-id] element: border-box rect (getBoundingClientRect,
//             CSS px, page space), tag and computed display
//   lines     every line box of every text-bearing [data-id] block: the text
//             on the line, and the extent of its glyph boxes (Range client
//             rects per character, grouped into lines by vertical overlap)
//   pseudo    inline ::before/::after strings (Range cannot see them; the
//             replay folds them into the owner's first/last line)
//
// plus `recorded/<fixture>@<width>.png` (full page). The recording is LOCAL
// (needs Chromium); the JSON/PNG are committed and CI replays them against
// Blitz without a browser: packages/web-render/tests/chrome_parity.rs.
//
//   node chrome/record.mjs                 # all fixtures
//   node chrome/record.mjs lists text-*    # by name (glob * supported)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chromium } from "playwright";

import { HERE, assertInterLoaded, fontFaceStyle, injectHead, sha256 } from "./shared.mjs";

export const WIDTHS = [240, 400];
export const HEIGHT = 1000;

const FIXTURES = join(HERE, "fixtures");
const OUT = join(HERE, "recorded");

function selected(names) {
  const all = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".html"))
    .map((f) => basename(f, ".html"))
    .sort();
  if (names.length === 0) return all;
  const res = names.map((n) => new RegExp("^" + n.replace(/\*/g, ".*") + "$"));
  return all.filter((f) => res.some((re) => re.test(f)));
}

/** Runs IN THE PAGE: extract element rects + line boxes. */
function extract() {
  const round = (v) => Math.round(v * 1000) / 1000;
  const elements = [];
  const pseudo = [];
  for (const el of document.querySelectorAll("[data-id]")) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    elements.push({
      id: el.dataset.id,
      tag: el.tagName.toLowerCase(),
      display: cs.display,
      position: cs.position,
      x: round(r.x + scrollX),
      y: round(r.y + scrollY),
      w: round(r.width),
      h: round(r.height),
    });
    for (const which of ["::before", "::after"]) {
      const ps = getComputedStyle(el, which);
      const c = ps.content;
      if (c && c !== "none" && c !== "normal" && /^".*"$/.test(c)) {
        pseudo.push({ id: el.dataset.id, which: which.slice(2), display: ps.display, text: JSON.parse(c) });
      }
    }
  }

  // Owner of a text node = nearest ancestor that establishes the block the
  // text lays out in (display not inline/contents) and carries a data-id.
  const ownerOf = (node) => {
    let el = node.parentElement;
    let ifc = null;
    while (el) {
      const d = getComputedStyle(el).display;
      if (!ifc && d !== "inline" && d !== "contents") ifc = el;
      if (ifc && el.dataset.id !== undefined) return el.dataset.id;
      el = el.parentElement;
    }
    return null;
  };

  const lines = [];
  const byOwner = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
    const owner = ownerOf(tn);
    if (owner === null) continue;
    const text = tn.data;
    let ownerLines = byOwner.get(owner);
    if (!ownerLines) {
      ownerLines = [];
      byOwner.set(owner, ownerLines);
    }
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i);
      const len = cp > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + len);
      range.setStart(tn, i);
      range.setEnd(tn, i + len);
      const rects = range.getClientRects();
      i += len;
      if (rects.length === 0) continue;
      // After a soft-hyphen break Chrome also reports the generated hyphen
      // (end of the previous line) as the next character's first rect; that
      // character's own glyph is its last rect. (A space at a wrap has a rect
      // on both lines too; it stays with the line it ends.)
      const r = /\s/.test(ch) ? rects[0] : rects[rects.length - 1];
      if (r.height === 0) continue;
      const top = r.top + scrollY;
      const bottom = r.bottom + scrollY;
      const left = r.left + scrollX;
      const right = r.right + scrollX;
      let line = ownerLines[ownerLines.length - 1];
      const overlaps =
        line &&
        Math.min(line.bottom, bottom) - Math.max(line.top, top) >
          0.5 * Math.min(line.bottom - line.top, bottom - top) &&
        // a jump BACK to the left on an overlapping band is a new column/line
        !(left + 0.5 < line.lastLeft && top > line.top + 0.5);
      if (!overlaps) {
        line = { owner, text: "", top, bottom, left: Infinity, right: -Infinity, lastLeft: left };
        ownerLines.push(line);
        lines.push(line);
      }
      line.text += ch;
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
      line.lastLeft = left;
      if (!/\s|­/.test(ch) && r.width > 0) {
        line.left = Math.min(line.left, left);
        line.right = Math.max(line.right, right);
      }
    }
  }
  return {
    elements,
    pseudo,
    lines: lines.map((l) => ({
      owner: l.owner,
      text: l.text,
      top: round(l.top),
      bottom: round(l.bottom),
      left: Number.isFinite(l.left) ? round(l.left) : null,
      right: Number.isFinite(l.right) ? round(l.right) : null,
    })),
    scrollHeight: document.documentElement.scrollHeight,
  };
}

async function main() {
  const names = selected(process.argv.slice(2));
  if (names.length === 0) throw new Error("record: no fixtures matched");
  mkdirSync(OUT, { recursive: true });
  const face = fontFaceStyle();
  const browser = await chromium.launch();
  const version = browser.version();
  try {
    for (const name of names) {
      const bytes = readFileSync(join(FIXTURES, `${name}.html`));
      const html = injectHead(bytes.toString("utf8"), face);
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
        await page.setContent(html, { waitUntil: "load" });
        await assertInterLoaded(page);
        const got = await page.evaluate(extract);
        const rec = {
          fixture: name,
          width,
          height: HEIGHT,
          sourceSha256: sha256(bytes),
          chrome: version,
          ...got,
        };
        writeFileSync(join(OUT, `${name}@${width}.json`), JSON.stringify(rec, null, 1) + "\n");
        await page.screenshot({ path: join(OUT, `${name}@${width}.png`), fullPage: true });
        await page.close();
        console.log(`record: ${name}@${width}  ${got.elements.length} elements, ${got.lines.length} lines`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
