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

// The InDesign lane in CI. Two checks per fixture in indesign/fixtures:
//
// 1. bake -> script: the REAL bake against a recording host (real engine
//    wasm) produces exactly the committed indesign/scripts/<f>.js — the
//    script core turns into the IDML InDesign was asked about. A bake change
//    shows up here first. `UPDATE_INDESIGN_SCRIPTS=1` rewrites the scripts
//    (then re-run indesign/run.sh to refresh the answers).
// 2. answer: when InDesign's answer is committed (indesign/answers/<f>.json,
//    recorded locally by run.sh), every baked item is where InDesign put it
//    (±0.5 pt), carries its text without overset, and every swatch has its
//    RGB value. Disagreements are pinned in DEFECTS.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { engineExtras } from "../../web-bundle/src/engine-loader";
import { expectedFrom, frameOf, loadInter, recordBake, toPagedScript, type Expected } from "../indesign/bake-lane";

const HERE = fileURLToPath(new URL("../indesign/", import.meta.url));
const BIN = fileURLToPath(new URL("../../web-bundle/bin/", import.meta.url));
const FONT = fileURLToPath(new URL("../../web-render/assets/fonts/Inter.ttf", import.meta.url));
const present = existsSync(BIN + "blitz_web.js") && existsSync(BIN + "blitz_web_bg.wasm");
const TOL_PT = 0.5;

/** Pinned disagreements with InDesign: `<fixture>/<check>` -> defect. */
const DEFECTS: Record<string, string> = {
  "fidelity/each run in its own face":
    "IB-02 a bold italic run arrives in InDesign as Inter Italic: the staged Inter face offers InDesign no Bold Italic",
};

/** What the SOURCE asked for, beyond what the bake plan records. */
const INTENT: Record<string, { text: string; fontStyle: string }[]> = {
  card: [{ text: "Quarterly report", fontStyle: "Bold" }],
};

/** Inter's hhea ascender (1984 / 2048 em): the bake sizes a text frame as
 *  [baseline - ascender, …], so InDesign's first baseline (first baseline
 *  offset = ascent) lands back on the run's baseline. */
const INTER_ASCENT = 1984 / 2048;

const fixtures = readdirSync(join(HERE, "fixtures"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -5))
  .sort();

function split(doc: string): { html: string; css: string } {
  const css = /<style>([\s\S]*?)<\/style>/.exec(doc)?.[1] ?? "";
  const html = /<body>([\s\S]*?)<\/body>/.exec(doc)?.[1] ?? doc;
  return { html: html.trim(), css: css.trim() };
}

interface Glue {
  initSync: (m: { module: Uint8Array }) => unknown;
  render_web_frame: (h: string, w: number, ht: number) => string;
}

async function glue(): Promise<Glue> {
  const g = (await import(new URL("../../web-bundle/bin/blitz_web.js", import.meta.url).href)) as Glue;
  g.initSync({ module: readFileSync(BIN + "blitz_web_bg.wasm") });
  return g;
}

if (process.env.REQUIRE_REAL_ENGINE === "1" && !present) {
  describe("indesign lane — REQUIRED engine", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the engine artifact is missing", () => {
      throw new Error("build the engine wasm with scripts/build-wasm.sh --engine");
    });
  });
}

describe.skipIf(!present)("InDesign lane: bake -> paged script -> IDML", () => {
  it.each(fixtures)("%s: the bake produces the committed script @feat:plugin-web.bake-to-native", async (name) => {
    const doc = readFileSync(join(HERE, "fixtures", `${name}.html`), "utf8");
    const { widthPt, heightPt } = frameOf(doc);
    const { html, css } = split(doc);
    const g = await glue();
    const ops = await recordBake(html, css, widthPt, heightPt, g.render_web_frame, loadInter(FONT), engineExtras(g as never));
    const script = toPagedScript(ops, `${name}: ${widthPt}x${heightPt} pt web frame at (36, 36), baked`);
    const scriptPath = join(HERE, "scripts", `${name}.js`);
    const expectedPath = join(HERE, "scripts", `${name}.expected.json`);
    const expected = JSON.stringify(expectedFrom(ops), null, 1) + "\n";
    if (process.env.UPDATE_INDESIGN_SCRIPTS === "1") {
      mkdirSync(join(HERE, "scripts"), { recursive: true });
      writeFileSync(scriptPath, script);
      writeFileSync(expectedPath, expected);
    }
    expect(script).toBe(readFileSync(scriptPath, "utf8"));
    expect(expected).toBe(readFileSync(expectedPath, "utf8"));
  });
});

interface Answer {
  indesign: string;
  items: {
    type: string;
    bounds: [number, number, number, number];
    fill: string;
    contents?: string;
    overflows?: boolean;
    pointSize?: number;
    textFill?: string;
    fontStyle?: string;
    baseline?: number;
    font?: string;
    stroke?: string;
    strokeWeight?: number;
    opacity?: number;
    shadow?: string;
    shadowOffset?: [number, number];
    shadowSize?: number;
    cornerOptions?: string[];
    cornerRadii?: number[];
    paths?: number;
    graphics?: number;
  }[];
  swatches: { name: string; space: string; value: number[] }[];
}

const answered = fixtures.filter((f) => existsSync(join(HERE, "answers", `${f}.json`)));

describe("InDesign lane: InDesign's answer matches the bake", () => {
  it("at least one InDesign answer is committed", () => {
    expect(answered.length).toBeGreaterThan(0);
  });

  for (const name of answered) {
    const exp = JSON.parse(readFileSync(join(HERE, "scripts", `${name}.expected.json`), "utf8")) as Expected;
    const ans = JSON.parse(readFileSync(join(HERE, "answers", `${name}.json`), "utf8")) as Answer;
    const check = (what: string, fn: () => void) => {
      const defect = DEFECTS[`${name}/${what}`];
      if (defect) it.fails(`DEFECT ${defect} — ${name}: ${what} @feat:plugin-web.bake-to-native`, fn);
      else it(`${name}: ${what} @feat:plugin-web.bake-to-native`, fn);
    };

    check("item count and kinds", () => {
      expect(ans.items.map((i) => i.type)).toEqual(exp.items.map((i) => ({ rectangle: "Rectangle", polygon: "Polygon", textFrame: "TextFrame" })[i.kind]));
    });
    check("geometry within 0.5 pt", () => {
      exp.items.forEach((e, i) => {
        const a = ans.items[i];
        const d = Math.max(...e.bounds.map((v, k) => Math.abs(v - a.bounds[k])));
        expect(d, `item ${i} (${e.kind}) ${JSON.stringify(e.bounds)} vs ${JSON.stringify(a.bounds)}`).toBeLessThanOrEqual(TOL_PT);
      });
    });
    check("fills reference the baked swatches", () => {
      exp.items.forEach((e, i) => {
        if (e.fill) expect(ans.items[i].fill).toBe(e.fill);
        if (e.textFill) expect(ans.items[i].textFill).toBe(e.textFill);
      });
    });
    check("text per frame, nothing overset", () => {
      exp.items.forEach((e, i) => {
        if (e.kind !== "textFrame") return;
        expect(ans.items[i].contents).toBe(e.text);
        expect(ans.items[i].pointSize).toBe(e.pointSize);
        expect(ans.items[i].overflows, `text frame ${i} ${JSON.stringify(e.text)} is overset in InDesign`).toBe(false);
      });
    });
    check("first baseline on the run's baseline within 0.5 pt", () => {
      exp.items.forEach((e, i) => {
        if (e.kind !== "textFrame") return;
        const want = e.bounds[0] + INTER_ASCENT * (e.pointSize ?? 0);
        expect(Math.abs((ans.items[i].baseline ?? NaN) - want), `${e.text}: ${ans.items[i].baseline} vs ${want}`).toBeLessThanOrEqual(TOL_PT);
      });
    });
    check("each run in its own face", () => {
      exp.items.forEach((e, i) => {
        if (e.kind !== "textFrame" || !e.family) return;
        expect(ans.items[i].font?.split("\t")[0], e.text).toBe(e.family);
        expect(ans.items[i].fontStyle, e.text).toBe(e.fontStyle ?? "Regular");
      });
    });
    check("strokes, opacity, shadows, subpaths and images survive", () => {
      exp.items.forEach((e, i) => {
        const a = ans.items[i];
        const what = `item ${i} (${e.kind})`;
        expect(a.stroke, what).toBe((e.stroke ?? "None").replace(/^Swatch\//, ""));
        if (e.strokeWeight !== undefined) expect(a.strokeWeight, what).toBeCloseTo(e.strokeWeight, 2);
        expect(a.opacity ?? 100, what).toBeCloseTo(e.opacity ?? 100, 0);
        if (e.shadow) expect(a.shadow, what).toBe("DROP");
        if (e.shadowOffset) expect(a.shadowOffset, what).toEqual(e.shadowOffset);
        if (e.shadowSize !== undefined) expect(a.shadowSize, what).toBeCloseTo(e.shadowSize, 2);
        if (e.subpaths) expect(a.paths, what).toBe(e.subpaths);
        if (e.image) expect(a.graphics, what).toBe(1);
      });
    });
    check("rounded corners keep their radius", () => {
      exp.items.forEach((e, i) => {
        const a = ans.items[i];
        const what = `item ${i} (${e.kind})`;
        if (e.cornerRadius === undefined) {
          if (a.cornerOptions) expect(a.cornerOptions, what).toEqual(["NONE", "NONE", "NONE", "NONE"]);
          return;
        }
        expect(a.cornerOptions, what).toEqual(["ROUNDED_CORNER", "ROUNDED_CORNER", "ROUNDED_CORNER", "ROUNDED_CORNER"]);
        for (const r of a.cornerRadii ?? []) expect(r, what).toBeCloseTo(e.cornerRadius, 2);
      });
    });
    if (INTENT[name]) {
      check("source intent: font style", () => {
        for (const want of INTENT[name]) {
          const got = ans.items.find((i) => i.contents === want.text);
          expect(got?.fontStyle, want.text).toBe(want.fontStyle);
        }
      });
    }
    check("swatches keep their RGB values", () => {
      for (const s of exp.swatches) {
        const a = ans.swatches.find((x) => x.name === s.name);
        expect(a, s.name).toBeDefined();
        expect(a!.space).toBe("RGB");
        expect(a!.value.map(Math.round)).toEqual(s.rgb);
      }
    });
  }
});
