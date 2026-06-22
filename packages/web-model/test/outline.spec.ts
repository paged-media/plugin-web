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

import { describe, expect, it } from "vitest";

import { tagOutline } from "../src/outline";
import { DEFAULT_SOURCE } from "../src/source";

describe("tagOutline — tag-position scan", () => {
  it("emits opening tags in source order with exact ranges", () => {
    const html = "<div><p>hi</p></div>";
    const o = tagOutline(html);
    expect(o.map((e) => e.tag)).toEqual(["div", "p"]);
    // Each range slices back to exactly the open tag.
    for (const e of o) {
      expect(html.slice(e.sourceStart, e.sourceEnd)).toBe(`<${e.tag}>`);
    }
  });

  it("skips close tags (no open-tag range to jump to)", () => {
    const o = tagOutline("<span>x</span>");
    expect(o).toHaveLength(1);
    expect(o[0].tag).toBe("span");
  });

  it("captures attributes within the open-tag range", () => {
    const html = '<a href="x" class="c">link</a>';
    const o = tagOutline(html);
    expect(o).toHaveLength(1);
    expect(html.slice(o[0].sourceStart, o[0].sourceEnd)).toBe(
      '<a href="x" class="c">',
    );
  });

  it("emits void and self-closing tags as findable openings", () => {
    const html = '<p>x</p><br><img src="i.png"/>';
    const o = tagOutline(html);
    expect(o.map((e) => e.tag)).toEqual(["p", "br", "img"]);
    expect(html.slice(o[2].sourceStart, o[2].sourceEnd)).toBe(
      '<img src="i.png"/>',
    );
  });

  it("lowercases tag names but ranges index the original casing", () => {
    const html = "<DIV><P>x</P></DIV>";
    const o = tagOutline(html);
    expect(o.map((e) => e.tag)).toEqual(["div", "p"]);
    expect(html.slice(o[0].sourceStart, o[0].sourceEnd)).toBe("<DIV>");
  });

  it("reports 1-based source lines", () => {
    const html = "<div>\n  <p>x</p>\n</div>";
    const o = tagOutline(html);
    expect(o.map((e) => [e.tag, e.line])).toEqual([
      ["div", 1],
      ["p", 2],
    ]);
  });

  it("emits a <script> open tag (so the author can find and delete it)", () => {
    const o = tagOutline("<div></div><script>x()</script>");
    expect(o.map((e) => e.tag)).toEqual(["div", "script"]);
  });

  it("ranges of the default source all slice back cleanly", () => {
    const o = tagOutline(DEFAULT_SOURCE.html);
    expect(o.map((e) => e.tag)).toEqual(["h1", "p"]);
    for (const e of o) {
      const slice = DEFAULT_SOURCE.html.slice(e.sourceStart, e.sourceEnd);
      expect(slice.startsWith(`<${e.tag}`)).toBe(true);
      expect(slice.endsWith(">")).toBe(true);
    }
  });

  it("is total — empty / non-string / garbage never throws", () => {
    expect(tagOutline("")).toEqual([]);
    expect(tagOutline(undefined as unknown as string)).toEqual([]);
    expect(tagOutline("<<<>>> not really markup")).toEqual([]);
  });
});
