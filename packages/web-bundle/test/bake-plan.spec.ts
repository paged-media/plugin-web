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

// Phase C — the PURE bake planner (`SceneLayer → BakePlan`). No host, no
// engine: plain data in, plain data out. Pins the flatten semantics (text +
// solid rects become native; everything else is counted honestly).

import { describe, expect, it } from "vitest";

import type { SceneLayer } from "@paged-media/web-model";

import {
  TEXT_PAD_PT,
  bakeBatchOps,
  charCount,
  pathAsRect,
  pathToAnchors,
  sceneLayerToBakePlan,
} from "../src/bake-plan";

/** A closed axis-aligned rectangle path `[left,top]..[right,bottom]`. */
const rectPath = (l: number, t: number, r: number, b: number) => [
  { op: "moveTo" as const, x: l, y: t },
  { op: "lineTo" as const, x: r, y: t },
  { op: "lineTo" as const, x: r, y: b },
  { op: "lineTo" as const, x: l, y: b },
  { op: "close" as const },
];

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("pathAsRect", () => {
  it("recognises a closed axis-aligned rectangle → [top,left,bottom,right]", () => {
    expect(pathAsRect(rectPath(10, 20, 110, 60))).toEqual([20, 10, 60, 110]);
  });

  it("recognises a rect traced without an explicit close", () => {
    expect(
      pathAsRect([
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 100, y: 0 },
        { op: "lineTo", x: 100, y: 50 },
        { op: "lineTo", x: 0, y: 50 },
      ]),
    ).toEqual([0, 0, 50, 100]);
  });

  it("rejects a path with a curve", () => {
    expect(
      pathAsRect([
        { op: "moveTo", x: 0, y: 0 },
        { op: "cubicTo", cx1: 10, cy1: 0, cx2: 20, cy2: 0, x: 30, y: 0 },
        { op: "close" },
      ]),
    ).toBeNull();
  });

  it("rejects a triangle (3 corners) and an L-shape (4 x's / 4 y's)", () => {
    expect(
      pathAsRect([
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 100, y: 0 },
        { op: "lineTo", x: 50, y: 80 },
        { op: "close" },
      ]),
    ).toBeNull();
  });
});

describe("sceneLayerToBakePlan — text", () => {
  it("maps a text run to a BakeText + a deduped swatch it references", () => {
    const layer: SceneLayer = {
      items: [{ kind: "text", x: 12, y: 40, text: "Hello", size: 16, paint: RED }],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.texts).toEqual([
      { left: 12, baseline: 40, text: "Hello", sizePt: 16, fillColorId: "Color/wb-ff0000" },
    ]);
    expect(plan.swatches).toEqual([{ id: "Color/wb-ff0000", r: 255, g: 0, b: 0 }]);
    expect(plan.rects).toEqual([]);
    expect(plan.deferred).toEqual({});
  });

  it("skips empty and fully-transparent text (nothing to bake)", () => {
    const layer: SceneLayer = {
      items: [
        { kind: "text", x: 0, y: 10, text: "", size: 12, paint: BLACK },
        { kind: "text", x: 0, y: 20, text: "ghost", size: 12, paint: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.texts).toEqual([]);
    expect(plan.swatches).toEqual([]);
  });

  it("deduplicates one swatch across runs of the same colour", () => {
    const layer: SceneLayer = {
      items: [
        { kind: "text", x: 0, y: 10, text: "a", size: 12, paint: RED },
        { kind: "text", x: 0, y: 30, text: "b", size: 12, paint: RED },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.swatches).toHaveLength(1);
    expect(plan.texts.map((t) => t.fillColorId)).toEqual([
      "Color/wb-ff0000",
      "Color/wb-ff0000",
    ]);
  });

  it("rounds 0..1 channels to 0..255 in both the id and the value", () => {
    const layer: SceneLayer = {
      items: [
        { kind: "text", x: 0, y: 10, text: "x", size: 12, paint: { r: 0.5, g: 0.2, b: 0.8, a: 1 } },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    // 0.5*255=127.5→128 (0x80), 0.2*255=51 (0x33), 0.8*255=204 (0xcc)
    expect(plan.swatches[0]).toEqual({ id: "Color/wb-8033cc", r: 128, g: 51, b: 204 });
  });
});

describe("sceneLayerToBakePlan — fills", () => {
  it("maps a rectangular fill path to a BakeRect + swatch", () => {
    const layer: SceneLayer = {
      items: [{ kind: "fillPath", path: rectPath(10, 20, 110, 60), paint: BLACK }],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.rects).toEqual([
      { bounds: [20, 10, 60, 110], fillColorId: "Color/wb-000000" },
    ]);
    expect(plan.swatches).toEqual([{ id: "Color/wb-000000", r: 0, g: 0, b: 0 }]);
  });

  it("bakes a non-rectangular single-subpath fill as a native PATH (Phase F)", () => {
    const layer: SceneLayer = {
      items: [
        {
          kind: "fillPath",
          path: [
            { op: "moveTo", x: 0, y: 0 },
            { op: "cubicTo", cx1: 10, cy1: 0, cx2: 20, cy2: 10, x: 30, y: 20 },
            { op: "lineTo", x: 0, y: 20 },
            { op: "close" },
          ],
          paint: BLACK,
        },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.rects).toEqual([]);
    expect(plan.deferred).toEqual({});
    expect(plan.paths).toHaveLength(1);
    expect(plan.paths[0].fillColorId).toBe("Color/wb-000000");
    // The cubic set the start anchor's OUT-handle + the new anchor's IN-handle.
    expect(plan.paths[0].anchors).toEqual([
      { anchor: [0, 0], left: [0, 0], right: [10, 0] },
      { anchor: [30, 20], left: [20, 10], right: [30, 20] },
      { anchor: [0, 20], left: [0, 20], right: [0, 20] },
    ]);
  });

  it("defers a MULTI-subpath fill (a second moveTo) — v1 is single-subpath", () => {
    const layer: SceneLayer = {
      items: [
        {
          kind: "fillPath",
          path: [
            { op: "moveTo", x: 0, y: 0 },
            { op: "lineTo", x: 10, y: 0 },
            { op: "lineTo", x: 10, y: 10 },
            { op: "moveTo", x: 20, y: 20 }, // a hole / second subpath
            { op: "lineTo", x: 25, y: 20 },
          ],
          paint: BLACK,
        },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.paths).toEqual([]);
    expect(plan.deferred).toEqual({ "fillPath.multiSubpath": 1 });
  });
});

describe("pathToAnchors", () => {
  it("maps corner points to handle-less anchors (left = right = anchor)", () => {
    expect(
      pathToAnchors([
        { op: "moveTo", x: 0, y: 0 },
        { op: "lineTo", x: 10, y: 0 },
        { op: "lineTo", x: 10, y: 10 },
        { op: "close" },
      ]),
    ).toEqual([
      { anchor: [0, 0], left: [0, 0], right: [0, 0] },
      { anchor: [10, 0], left: [10, 0], right: [10, 0] },
      { anchor: [10, 10], left: [10, 10], right: [10, 10] },
    ]);
  });

  it("returns null for a second subpath and for a degenerate run", () => {
    expect(
      pathToAnchors([
        { op: "moveTo", x: 0, y: 0 },
        { op: "moveTo", x: 5, y: 5 },
      ]),
    ).toBeNull();
    expect(pathToAnchors([{ op: "moveTo", x: 0, y: 0 }])).toBeNull(); // < 2 anchors
    expect(pathToAnchors([{ op: "close" }])).toBeNull();
  });
});

describe("sceneLayerToBakePlan — deferred kinds", () => {
  it("counts images honestly", () => {
    const layer: SceneLayer = {
      items: [
        { kind: "image", rgba: [0, 0, 0, 255], width: 1, height: 1, x: 0, y: 0, w: 10, h: 10 },
        { kind: "image", rgba: [0, 0, 0, 255], width: 1, height: 1, x: 0, y: 0, w: 10, h: 10 },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.deferred).toEqual({ image: 2 });
    expect(plan.texts).toEqual([]);
    expect(plan.rects).toEqual([]);
  });

  it("mixes text + rect + deferred in one layer", () => {
    const layer: SceneLayer = {
      items: [
        { kind: "fillPath", path: rectPath(0, 0, 200, 100), paint: { r: 0.8, g: 0.9, b: 1, a: 1 } },
        { kind: "text", x: 8, y: 24, text: "Title", size: 18, paint: BLACK },
        { kind: "image", rgba: [0], width: 1, height: 1, x: 0, y: 0, w: 5, h: 5 },
      ],
    };
    const plan = sceneLayerToBakePlan(layer);
    expect(plan.rects).toHaveLength(1);
    expect(plan.texts).toHaveLength(1);
    expect(plan.deferred).toEqual({ image: 1 });
    expect(plan.swatches).toHaveLength(2); // the bg blue + the black text
  });
});

describe("bakeBatchOps — the whole bake as ONE batch", () => {
  const M = { advance: 40, ascender: 9, descender: -3 };
  const layer: SceneLayer = {
    items: [
      { kind: "fillPath", path: rectPath(0, 0, 200, 100), paint: RED },
      { kind: "text", x: 8, y: 24, text: "Title", size: 18, paint: BLACK },
    ],
  };

  it("swatches first, then insert → bindCreated → address by handle (no read-back)", () => {
    const plan = sceneLayerToBakePlan(layer);
    const { ops, handles, swatchIds } = bakeBatchOps([
      { plan, pageId: "uP", top: 100, left: 50, metrics: [M] },
    ]);
    expect(swatchIds).toEqual(["Color/wb-ff0000", "Color/wb-000000"]);
    expect(handles).toEqual({ rects: ["r0"], paths: [], texts: ["t0"] });
    expect(ops.map((o) => o.op)).toEqual([
      "createSwatch",
      "createSwatch",
      "insertFrame",
      "bindCreated",
      "setElementProperty",
      "insertTextFrame",
      "bindCreated",
      "insertText",
      "setElementProperty",
      "setElementProperty",
    ]);
    // The rectangle sits at the frame's page origin.
    expect(ops[2]).toEqual({ op: "insertFrame", args: { pageId: "uP", bounds: [100, 50, 200, 250] } });
    expect(ops[4]).toMatchObject({
      args: { elementId: { kind: "rectangle", id: "$h:r0" }, path: "frameFillColor" },
    });
    // The text frame: baseline-exact bounds from the measured metrics.
    expect(ops[5]).toEqual({
      op: "insertTextFrame",
      args: { pageId: "uP", bounds: [124 - 9, 58, 124 + 3, 58 + 40 + TEXT_PAD_PT] },
    });
    expect(ops[6]).toEqual({ op: "bindCreated", args: { handle: "t0" } });
    // The minted STORY is addressed through the frame's handle.
    expect(ops[7]).toEqual({
      op: "insertText",
      args: { storyId: "$h:t0", offset: 0, text: "Title" },
    });
    const range = { kind: "storyRange", id: { story_id: "$h:t0", start: 0, end: 5 } };
    expect(ops[8]).toEqual({
      op: "setElementProperty",
      args: { elementId: range, path: "characterFontSize", value: { type: "length", value: 18 } },
    });
    expect(ops[9]).toEqual({
      op: "setElementProperty",
      args: {
        elementId: range,
        path: "characterFillColor",
        value: { type: "colorRef", value: "Color/wb-000000" },
      },
    });
  });

  it("skips swatches the document already has, and creates each once across frames", () => {
    const plan = sceneLayerToBakePlan(layer);
    const { ops, swatchIds, handles } = bakeBatchOps(
      [
        { plan, pageId: "uP", top: 0, left: 0, metrics: [M] },
        { plan, pageId: "uQ", top: 0, left: 0, metrics: [M] },
      ],
      new Set(["Color/wb-ff0000"]),
    );
    expect(swatchIds).toEqual(["Color/wb-000000"]);
    expect(ops.filter((o) => o.op === "createSwatch")).toHaveLength(1);
    // Handles stay unique across the frames of one batch.
    expect(handles).toEqual({ rects: ["r0", "r1"], paths: [], texts: ["t0", "t1"] });
  });

  it("a story range ends at the CHARACTER count (the engine's), not UTF-16 units", () => {
    expect(charCount("a😀b")).toBe(3);
    const plan = sceneLayerToBakePlan({
      items: [{ kind: "text", x: 0, y: 10, text: "a😀b", size: 10, paint: BLACK }],
    });
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [M] }]);
    const size = ops.find(
      (o) => o.op === "setElementProperty" && (o.args as { path: string }).path === "characterFontSize",
    ) as { args: { elementId: { id: { end: number } } } };
    expect(size.args.elementId.id.end).toBe(3);
  });

  it("an empty plan is an empty batch", () => {
    const plan = sceneLayerToBakePlan({ items: [] });
    expect(bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [] }]).ops).toEqual([]);
  });
});
