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

// record-flow.mjs — the Chrome oracle for fragmentation across frames.
//
// Each `flow-fixtures/*.html` names its frame chain in
// `<meta name="paged-frames" content="WxH,WxH,…">` (equal sizes — Chrome has
// no CSS Regions, so the chain is modelled as a multi-column container whose
// columns ARE the frames: column-width = W, column-gap = 0,
// column-fill: auto, height = H). Chrome's fragmentation engine decides where
// the content breaks; every character is assigned to the column its glyph
// box lands in, and we write `recorded-flow/<fixture>.json` with the text of
// each frame and of the overflow columns (= overset). The replay is
// packages/web-render/tests/flow_parity.rs against `render_web_flow`.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chromium } from "playwright";

import { HERE, assertInterLoaded, fontFaceStyle, injectHead, sha256 } from "./shared.mjs";

const FIXTURES = join(HERE, "flow-fixtures");
const OUT = join(HERE, "recorded-flow");

export function framesOf(html) {
  const m = /<meta name="paged-frames" content="([^"]+)">/.exec(html);
  if (!m) throw new Error("flow fixture without <meta name=paged-frames>");
  return m[1].split(",").map((s) => {
    const [w, h] = s.split("x").map(Number);
    return { widthPx: w, heightPx: h };
  });
}

/** Runs IN THE PAGE. */
function fragment({ w, h, n }) {
  const mc = document.createElement("div");
  mc.id = "__paged_flow";
  while (document.body.firstChild) mc.appendChild(document.body.firstChild);
  document.body.appendChild(mc);
  Object.assign(mc.style, {
    width: `${w * n}px`,
    height: `${h}px`,
    columnWidth: `${w}px`,
    columnCount: String(n),
    columnGap: "0px",
    columnFill: "auto",
  });
  const origin = mc.getBoundingClientRect().left;
  const cols = [];
  const walker = document.createTreeWalker(mc, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
    const t = tn.data;
    for (let i = 0; i < t.length; i++) {
      range.setStart(tn, i);
      range.setEnd(tn, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.height === 0) continue;
      const col = Math.floor((r.left + r.width / 2 - origin) / w);
      while (cols.length <= col) cols.push("");
      cols[col] += t[i];
    }
    // a block boundary is a word boundary
    for (let c = 0; c < cols.length; c++) if (cols[c] && !cols[c].endsWith(" ")) cols[c] += " ";
  }
  return cols.map((c) => c.replace(/\s+/g, " ").trim());
}

async function main() {
  // Optional fixture names on the command line record only those
  // (`record-flow.mjs flow-break-avoid`); none records every fixture.
  const only = new Set(process.argv.slice(2));
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".html"))
    .map((f) => basename(f, ".html"))
    .filter((n) => only.size === 0 || only.has(n))
    .sort();
  mkdirSync(OUT, { recursive: true });
  const face = fontFaceStyle();
  const browser = await chromium.launch();
  try {
    for (const name of names) {
      const bytes = readFileSync(join(FIXTURES, `${name}.html`));
      const src = bytes.toString("utf8");
      const frames = framesOf(src);
      const w = frames[0].widthPx;
      const h = frames[0].heightPx;
      if (!frames.every((f) => f.widthPx === w && f.heightPx === h)) {
        throw new Error(`${name}: the Chrome flow oracle models equal frames only`);
      }
      const page = await browser.newPage({ viewport: { width: w * (frames.length + 4), height: h + 100 } });
      await page.setContent(injectHead(src, face), { waitUntil: "load" });
      await assertInterLoaded(page);
      const cols = await page.evaluate(fragment, { w, h, n: frames.length });
      const rec = {
        fixture: name,
        frames,
        sourceSha256: sha256(bytes),
        chrome: browser.version(),
        frameText: frames.map((_, i) => cols[i] ?? ""),
        oversetText: cols.slice(frames.length).filter(Boolean).join(" "),
      };
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify(rec, null, 1) + "\n");
      await page.close();
      console.log(`record-flow: ${name} ${rec.frameText.map((t) => t.split(" ").length).join("/")} words, overset ${rec.oversetText ? "yes" : "no"}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
