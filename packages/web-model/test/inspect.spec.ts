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

import { boxesForOutline, caretAt, hitText, outlineIndexAt, parseInspected } from "../src/inspect";
import { tagOutline } from "../src/outline";

describe("hitText / caretAt @feat:plugin-web.in-frame-edit", () => {
  const m = {
    nodes: [
      { n: 0, text: "Hi " },
      { n: 1, text: "you" },
    ],
    lines: [
      {
        top: 0,
        bottom: 12,
        baseline: 9,
        c: [
          [0, 5, -1, 0, 0],
          [5, 6, 0, 0, 1],
          [11, 3, 0, 1, 1],
          [14, 3, 0, 2, 1],
          [17, 6, 1, 0, 1],
          [23, 6, 1, 1, 1],
          [29, 6, 1, 2, 1],
        ] as [number, number, number, number, number][],
      },
    ],
  };

  it("maps a point to the node and the side of the character it falls on", () => {
    expect(hitText(m, 6, 5)).toEqual({ node: 0, offset: 0 });
    expect(hitText(m, 10, 5)).toEqual({ node: 0, offset: 1 });
    expect(hitText(m, 25, 30)).toEqual({ node: 1, offset: 1 }); // below: nearest line
    expect(hitText(m, 1, 5)).toEqual({ node: 0, offset: 0 }); // the marker is skipped
  });

  it("draws the caret at the start of the character at the offset, or after the last", () => {
    expect(caretAt(m, { node: 1, offset: 1 })).toEqual({ x: 23, top: 0, bottom: 12 });
    expect(caretAt(m, { node: 1, offset: 3 })).toEqual({ x: 35, top: 0, bottom: 12 });
    expect(caretAt(m, { node: 7, offset: 0 })).toBeNull();
  });

  it("has no hit in a frame without text", () => {
    expect(hitText({ nodes: [], lines: [] }, 1, 1)).toBeNull();
  });
});

describe("outline ↔ boxes @feat:plugin-web.outline-canvas", () => {
  const outline = tagOutline("<p>a</p><div><p>b</p></div>");
  const boxes = [
    { tag: "p", n: 0, x: 0, y: 0, w: 100, h: 10 },
    { tag: "div", n: 0, x: 0, y: 10, w: 100, h: 10 },
    { tag: "p", n: 1, x: 0, y: 10, w: 100, h: 10 },
  ];

  it("finds the painted box of an outline entry by tag occurrence", () => {
    expect(boxesForOutline(boxes, outline, 2)).toEqual([boxes[2]]);
    expect(boxesForOutline(boxes, outline, 1)).toEqual([boxes[1]]);
    expect(boxesForOutline(boxes, outline, 9)).toEqual([]);
  });

  it("finds the outline entry of the innermost box under a point", () => {
    expect(outlineIndexAt(boxes, outline, 5, 15)).toBe(2);
    expect(outlineIndexAt(boxes, outline, 5, 5)).toBe(0);
    expect(outlineIndexAt(boxes, outline, 500, 5)).toBe(-1);
  });
});

describe("parseInspected @feat:plugin-web.in-frame-edit", () => {
  it("reads malformed JSON as an empty render", () => {
    expect(parseInspected("nope")).toEqual({ layer: { items: [] }, text: { nodes: [], lines: [] }, boxes: [] });
    expect(parseInspected('{"layer":{"items":[]},"text":{"nodes":[],"lines":[{"c":[]}]},"boxes":[]}').text.lines).toHaveLength(1);
  });
});
