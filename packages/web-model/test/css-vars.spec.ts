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

// CSS custom properties as a view over the css lane: the scanner finds the
// declarations (not inside comments or strings, at any depth), and a write
// splices ONE value and leaves every other byte as written.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { cssVarNames, cssVarValueProblem, scanCssVars, setCssVar } from "../src";

const CSS = `/* --not: a var */
:root { --brand: #c00; --gap:  12px !important }
@media print {
  :root { --brand: black; }
  p::before { content: "--fake: 1;"; --label: "a;b"; }
}
p { color: var(--brand); margin: var(--gap) }
`;

describe("cssVar scanner @feat:plugin-web.object-model", () => {
  it("finds declarations in rules and at-rules, skipping comments and strings", () => {
    const d = scanCssVars(CSS);
    expect(d.map((x) => [x.name, x.value])).toEqual([
      ["--brand", "#c00"],
      ["--gap", "12px"],
      ["--brand", "black"],
      ["--label", '"a;b"'],
    ]);
    expect(d[1]!.important).toBe(true);
    expect(d[2]!.context).toEqual(["@media print", ":root"]);
    expect(CSS.slice(d[0]!.start, d[0]!.end)).toBe("#c00");
    expect(cssVarNames(CSS)).toEqual(["--brand", "--gap", "--label"]);
  });

  it("a set splices the first declaration only, the rest byte-identical", () => {
    const out = setCssVar(CSS, "--brand", "rebeccapurple");
    expect("css" in out).toBe(true);
    const css = (out as { css: string }).css;
    expect(css).toBe(CSS.replace("--brand: #c00", "--brand: rebeccapurple"));
    const gap = setCssVar(CSS, "--gap", "4pt") as { css: string };
    expect(gap.css).toContain("--gap:  4pt !important");
  });

  it("a property the source does not declare is added as a :root rule", () => {
    const out = setCssVar("p { color: red }", "--accent", "teal") as { css: string };
    expect(out.css).toBe("p { color: red }\n:root { --accent: teal; }\n");
    expect(scanCssVars(out.css).map((d) => d.value)).toEqual(["teal"]);
  });

  it("refuses values that would end the declaration or the block", () => {
    for (const bad of ["red; color: blue", "a }", "/* x */", '"open', "(", "", "x)"]) {
      expect(cssVarValueProblem(bad)).not.toBeNull();
      expect("refused" in setCssVar(CSS, "--brand", bad)).toBe(true);
    }
    expect("refused" in setCssVar(CSS, "brand", "red")).toBe(true);
    expect(cssVarValueProblem('url("a;b.png")')).toBeNull();
  });

  it("set then scan reads the value back, and nothing else moves (property)", () => {
    const value = fc
      .stringMatching(/^[A-Za-z0-9#.%, ()-]{1,24}$/)
      .filter((v) => v.trim().length > 0 && cssVarValueProblem(v) === null);
    fc.assert(
      fc.property(value, (v) => {
        const out = setCssVar(CSS, "--brand", v) as { css: string };
        const first = scanCssVars(out.css).find((d) => d.name === "--brand")!;
        expect(first.value).toBe(v.trim());
        expect(out.css.slice(0, first.start)).toBe(CSS.slice(0, scanCssVars(CSS)[0]!.start));
        expect(out.css.slice(first.end)).toBe(CSS.slice(scanCssVars(CSS)[0]!.end));
      }),
    );
  });

  it("never throws on garbage", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => scanCssVars(s)).not.toThrow();
      }),
    );
  });
});
