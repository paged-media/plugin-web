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

// Fragmentation conserves text — a property test against the REAL engine
// wasm (render_web_flow). For random frame chains (2–5 frames, each its own
// width and height), the words painted across the frames, in chain order,
// must be exactly the start of the words the same flow paints in one frame
// tall enough to hold it: nothing lost, nothing duplicated, nothing
// reordered; and when the flow is not overset, all of it.
//
// Needs bin/blitz_web*.wasm (scripts/build-wasm.sh --engine). Skips without
// it locally; REQUIRE_REAL_ENGINE=1 turns the skip into a failure.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

const binDir = fileURLToPath(new URL("../bin/", import.meta.url));
const wasmPath = binDir + "blitz_web_bg.wasm";
const present = existsSync(binDir + "blitz_web.js") && existsSync(wasmPath);

interface Glue {
  initSync: (m: { module: Uint8Array }) => unknown;
  render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
}

async function glue(): Promise<Glue> {
  const g = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as Glue;
  g.initSync({ module: readFileSync(wasmPath) });
  return g;
}

const STYLE =
  "<style>html{font-family:Inter;line-height:1.25}body{margin:0}p{margin:0 0 8px}h2{margin:12px 0 6px;font-size:20px}</style>";
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";

/** Documents whose every word is distinct (w<block>_<n>), so a duplicated or
 *  dropped word is visible. */
const DOCS: Record<string, string> = {
  paragraphs: Array.from({ length: 10 }, (_, b) =>
    `<p>${Array.from({ length: 14 }, (_, n) => `p${b}w${n}`).join(" ")}</p>`,
  ).join(""),
  "long-paragraph": `<p>${Array.from({ length: 160 }, (_, n) => `w${n}`).join(" ")}</p>`,
  "headings-and-text": Array.from({ length: 5 }, (_, b) =>
    `<h2>h${b}</h2><p>${WORDS.split(" ").map((w) => `${w}${b}`).join(" ")}</p>`,
  ).join(""),
  table: `<table>${Array.from({ length: 14 }, (_, r) => `<tr><td>r${r}a</td><td>r${r}b</td></tr>`).join("")}</table>`,
};

function words(layerJson: { items: { kind: string; text?: string }[] }): string[] {
  return layerJson.items
    .filter((i) => i.kind === "text" && typeof i.text === "string")
    .flatMap((i) => i.text!.split(/\s+/))
    .filter(Boolean);
}

function flow(g: Glue, body: string, frames: { widthPx: number; heightPx: number }[]) {
  const out = JSON.parse(g.render_web_flow(`<html><head>${STYLE}</head><body>${body}</body></html>`, JSON.stringify(frames), "")) as {
    frames: { layer: { items: { kind: string; text?: string }[] } }[];
    overset: boolean;
  };
  return { frames: out.frames.map((f) => words(f.layer)), overset: out.overset };
}

if (process.env.REQUIRE_REAL_ENGINE === "1" && !present) {
  describe("flow conservation — REQUIRED engine", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the engine artifact is missing @feat:plugin-web.flow-fragmentation", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${wasmPath} is missing — build it with scripts/build-wasm.sh --engine`);
    });
  });
}

describe.skipIf(!present)("fragmentation conserves text (real engine, fast-check)", () => {
  const frame = fc.record({
    widthPx: fc.integer({ min: 160, max: 420 }),
    heightPx: fc.integer({ min: 40, max: 320 }),
  });
  const chain = fc.array(frame, { minLength: 2, maxLength: 5 });

  it.each(Object.keys(DOCS))(
    "%s: frames in order = a prefix of the single-frame text, all of it unless overset @feat:plugin-web.flow-fragmentation",
    async (doc) => {
      const g = await glue();
      fc.assert(
        fc.property(chain, (frames) => {
          const got = flow(g, DOCS[doc], frames);
          // The same chain's width in one frame tall enough for everything.
          const whole = flow(g, DOCS[doc], [{ widthPx: frames[0].widthPx, heightPx: 100_000 }]).frames[0];
          const flat = got.frames.flat();
          expect(got.frames).toHaveLength(frames.length);
          expect(whole.length, "the single-frame render painted nothing").toBeGreaterThan(20);
          expect(flat.length, "the chain painted nothing").toBeGreaterThan(0);
          expect(new Set(flat).size, "a word was painted twice").toBe(flat.length);
          expect(whole.slice(0, flat.length), "frames are not a prefix of the flow").toEqual(flat);
          if (!got.overset) expect(flat, "not overset, yet words are missing").toEqual(whole);
        }),
        { numRuns: 40, seed: 20261005 },
      );
    },
    60_000,
  );

  // DEFECT FW-02 (CW-02): an outside list marker's glyph run takes the next
  // item's text, so a fragmented list repeats and drops items. Pinned in
  // web-render's flow_parity.rs too. Flip to `it` when the capture is fixed.
  it.fails("DEFECT FW-02: a fragmented list does not conserve its items @feat:plugin-web.flow-fragmentation", async () => {
    const g = await glue();
    const list = `<ul>${Array.from({ length: 12 }, (_, i) => `<li>item${i} ${WORDS}</li>`).join("")}</ul>`;
    const frames = [{ widthPx: 240, heightPx: 160 }, { widthPx: 240, heightPx: 160 }, { widthPx: 240, heightPx: 160 }];
    const flat = flow(g, list, frames).frames.flat();
    const whole = flow(g, list, [{ widthPx: 240, heightPx: 100_000 }]).frames[0];
    expect(whole.slice(0, flat.length)).toEqual(flat);
  });
});
