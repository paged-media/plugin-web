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

// The bake keeps what the canvas shows: each run's face, strokes, gradients,
// multi-subpath shapes, opacity, drop shadows and images — pure planner and
// batch-op level (the real engine checks are in conformance/bake.spec.ts).

import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { SceneLayer } from "@paged-media/web-model";

import { bakeBatchOps, fontStyleName, sceneLayerToBakePlan } from "../src/bake-plan";
import { encodePng, zlibStored } from "../src/png";

const rectPath = (l: number, t: number, r: number, b: number) => [
  { op: "moveTo" as const, x: l, y: t },
  { op: "lineTo" as const, x: r, y: t },
  { op: "lineTo" as const, x: r, y: b },
  { op: "lineTo" as const, x: l, y: b },
  { op: "close" as const },
];
/** A rounded rectangle as Blitz paints it: a quarter circle (cubic, handle
 *  0.5523 r) at each corner, joined by straight edges, from the left edge. */
const roundedPath = (l: number, t: number, r: number, b: number, rad: number, close: boolean) => {
  const k = rad * (1 - 0.552284749831);
  type Seg =
    | { op: "moveTo" | "lineTo"; x: number; y: number }
    | { op: "cubicTo"; cx1: number; cy1: number; cx2: number; cy2: number; x: number; y: number }
    | { op: "close" };
  const segs: Seg[] = [
    { op: "moveTo", x: l, y: t + rad },
    { op: "cubicTo", cx1: l, cy1: t + k, cx2: l + k, cy2: t, x: l + rad, y: t },
    { op: "lineTo", x: r - rad, y: t },
    { op: "cubicTo", cx1: r - k, cy1: t, cx2: r, cy2: t + k, x: r, y: t + rad },
    { op: "lineTo", x: r, y: b - rad },
    { op: "cubicTo", cx1: r, cy1: b - k, cx2: r - k, cy2: b, x: r - rad, y: b },
    { op: "lineTo", x: l + rad, y: b },
    { op: "cubicTo", cx1: l + k, cy1: b, cx2: l, cy2: b - k, x: l, y: b - rad },
  ];
  if (close) segs.push({ op: "close" });
  return segs;
};
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const M = { advance: 40, ascender: 9, descender: -3 };
const props = (ops: { op: string; args: unknown }[]) =>
  ops
    .filter((o) => o.op === "setElementProperty")
    .map((o) => {
      const a = o.args as { path: string; value: { value: unknown } };
      return [a.path, a.value.value] as const;
    });

describe("bake fidelity — text in its own face @feat:plugin-web.bake-to-native", () => {
  it("a run's family and weight/slope become its character font family and style", () => {
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "text", x: 0, y: 10, text: "Plain", size: 12, paint: BLACK, family: "Inter" },
        { kind: "text", x: 0, y: 30, text: "Heavy", size: 12, paint: BLACK, family: "Inter", weight: 700, italic: true },
      ],
    });
    expect(plan.texts.map((t) => [t.family, t.fontStyle])).toEqual([
      ["Inter", "Regular"],
      ["Inter", "Bold Italic"],
    ]);
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [M, M] }]);
    const p = props(ops as never);
    expect(p).toContainEqual(["characterFontFamily", "Inter"]);
    expect(p).not.toContainEqual(["characterFontStyle", "Regular"]);
    expect(p).toContainEqual(["characterFontStyle", "Bold Italic"]);
  });

  it("names faces the way the engine does", () => {
    expect(fontStyleName(undefined, undefined)).toBe("Regular");
    expect(fontStyleName(400, true)).toBe("Italic");
    expect(fontStyleName(600, false)).toBe("SemiBold");
    expect(fontStyleName(300, true)).toBe("Light Italic");
    expect(fontStyleName(900, false)).toBe("Black");
  });

  it("a run without a family sets no face (the document default)", () => {
    const plan = sceneLayerToBakePlan({ items: [{ kind: "text", x: 0, y: 10, text: "x", size: 12, paint: BLACK }] });
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [M] }]);
    expect(props(ops as never).map(([k]) => k)).not.toContain("characterFontFamily");
  });

  it("the frame holds the run's engine-shaped advance when it is wider than the measure", () => {
    const layer: SceneLayer = {
      items: [{ kind: "text", x: 0, y: 10, text: "Bold", size: 12, paint: BLACK, family: "Inter", weight: 700 }],
    };
    const wide = bakeBatchOps([{ plan: sceneLayerToBakePlan(layer, [55]), pageId: "uP", top: 0, left: 0, metrics: [M] }]);
    const narrow = bakeBatchOps([{ plan: sceneLayerToBakePlan(layer, [30]), pageId: "uP", top: 0, left: 0, metrics: [M] }]);
    const right = (ops: typeof wide.ops) =>
      ((ops.find((o) => o.op === "insertTextFrame") as { args: { bounds: number[] } }).args.bounds)[3];
    expect(right(wide.ops)).toBe(55 + 2);
    expect(right(narrow.ops)).toBe(40 + 2);
  });
});

describe("bake fidelity — paint @feat:plugin-web.bake-to-native", () => {
  it("a translucent fill or run becomes the item's opacity", () => {
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "fillPath", path: rectPath(0, 0, 10, 10), paint: { r: 1, g: 0, b: 0, a: 0.5 } },
        { kind: "text", x: 0, y: 10, text: "x", size: 12, paint: { r: 0, g: 0, b: 0, a: 0.25 } },
      ],
    });
    expect(plan.rects[0].opacity).toBe(50);
    expect(plan.texts[0].opacity).toBe(25);
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [M] }]);
    const opacity = ops.filter((o) => (o.args as { path?: string }).path === "frameOpacity");
    expect(opacity.map((o) => (o.args as { elementId: { kind: string } }).elementId.kind)).toEqual([
      "rectangle",
      "textFrame",
    ]);
  });

  it("strokes bake as stroked shapes: a closed rectangle, an open line", () => {
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "strokePath", path: rectPath(0, 0, 20, 10), paint: BLACK, width: 2 },
        {
          kind: "strokePath",
          path: [
            { op: "moveTo", x: 0, y: 30 },
            { op: "lineTo", x: 50, y: 30 },
          ],
          paint: BLACK,
          width: 1,
        },
      ],
    });
    expect(plan.rects).toEqual([{ bounds: [0, 0, 10, 20], fillColorId: null, stroke: { colorId: "Color/wb-000000", weight: 2 } }]);
    expect(plan.paths[0]).toMatchObject({ open: true, fillColorId: null, stroke: { weight: 1 } });
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [] }]);
    expect(ops.find((o) => o.op === "insertPath")).toMatchObject({ args: { open: true } });
    expect(props(ops as never)).toContainEqual(["frameStrokeWeight", 2]);
    expect(props(ops as never).map(([k]) => k)).not.toContain("frameFillColor");
  });

  it("a linear gradient bakes as a gradient swatch, angle and length; a sweep is counted", () => {
    const stops = [
      { offset: 0, r: 1, g: 0, b: 0, a: 1 },
      { offset: 1, r: 0, g: 0, b: 1, a: 1 },
    ];
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "fillPathGradient", path: rectPath(0, 0, 100, 50), gradient: { type: "linear", x0: 0, y0: 50, x1: 0, y1: 0, stops } },
        { kind: "fillPathGradient", path: rectPath(0, 0, 10, 10), gradient: { type: "sweep", cx: 5, cy: 5, start_angle: 0, stops } },
      ],
    });
    expect(plan.gradients).toHaveLength(1);
    expect(plan.gradients[0]).toMatchObject({
      kind: "Linear",
      stops: [
        { colorId: "Color/wb-ff0000", locationPct: 0 },
        { colorId: "Color/wb-0000ff", locationPct: 100 },
      ],
    });
    // Bottom to top: 90 degrees counter-clockwise, 50 pt long.
    expect(plan.rects[0].gradient).toEqual({ angle: 90, length: 50 });
    expect(plan.deferred).toEqual({ "fillPathGradient.sweep": 1 });
    const { ops, gradientIds } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [] }]);
    expect(gradientIds).toEqual([plan.gradients[0].id]);
    const order = ops.map((o) => o.op);
    expect(order.indexOf("createGradient")).toBeGreaterThan(order.lastIndexOf("createSwatch"));
    expect(props(ops as never)).toContainEqual(["frameFillColor", plan.gradients[0].id]);
  });

  it("an outer shadow attaches to the rectangle that casts it", () => {
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "dropShadow", path: rectPath(4, 6, 104, 56), offset_x: 0, offset_y: 0, blur_radius: 3, r: 0, g: 0, b: 0, a: 0.4 },
        { kind: "fillPath", path: rectPath(0, 0, 100, 50), paint: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    });
    expect(plan.rects[0].shadow).toEqual({ xOffset: 4, yOffset: 6, size: 3, opacityPct: 40, colorId: "Color/wb-000000" });
    expect(plan.deferred).toEqual({});
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [] }]);
    expect(props(ops as never)).toContainEqual(["frameDropShadowMode", "Drop"]);
    expect(props(ops as never)).toContainEqual(["frameDropShadowSize", 3]);
  });

  it("a shadow with no shape to carry it is counted, never faked", () => {
    const plan = sceneLayerToBakePlan({
      items: [{ kind: "dropShadow", path: rectPath(0, 0, 10, 10), offset_x: 0, offset_y: 0, blur_radius: 1, r: 0, g: 0, b: 0, a: 1 }],
    });
    expect(plan.deferred).toEqual({ "dropShadow.noShape": 1 });
  });

  it("a uniformly rounded box bakes as a rectangle with rounded corners, carrying its shadow", () => {
    // Real Blitz output for a 100 x 60 px box with border-radius 14px and
    // box-shadow 4px 4px 6px at a 10 px margin (points).
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "dropShadow", path: roundedPath(10.5, 10.5, 85.5, 55.5, 10.5, true), offset_x: 0, offset_y: 0, blur_radius: 4.5, r: 0, g: 0, b: 0, a: 0.4 },
        { kind: "fillPath", path: roundedPath(7.5, 7.5, 82.5, 52.5, 10.5, false), paint: { r: 0.8, g: 0.2, b: 0.2, a: 1 } },
      ],
    });
    expect(plan.paths).toEqual([]);
    expect(plan.rects).toHaveLength(1);
    expect(plan.rects[0].bounds).toEqual([7.5, 7.5, 52.5, 82.5]);
    expect(plan.rects[0].cornerRadius).toBe(10.5);
    expect(plan.rects[0].shadow).toEqual({ xOffset: 3, yOffset: 3, size: 4.5, opacityPct: 40, colorId: "Color/wb-000000" });
    expect(plan.deferred).toEqual({});
    const p = props(bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [] }]).ops as never);
    for (const c of ["TopLeft", "TopRight", "BottomLeft", "BottomRight"]) {
      expect(p).toContainEqual([`frameCornerOption${c}`, "RoundedCorner"]);
      expect(p).toContainEqual([`frameCornerRadius${c}`, 10.5]);
    }
    expect(p).toContainEqual(["frameDropShadowMode", "Drop"]);
  });

  it("unequal corners stay a path, and the path carries its shadow", () => {
    const leaf = roundedPath(0, 0, 80, 40, 3, false);
    // Two opposite corners rounder than the others: not a rectangle.
    leaf[1] = { op: "cubicTo", cx1: 0, cy1: 7, cx2: 7, cy2: 0, x: 15, y: 0 };
    leaf[0] = { op: "moveTo", x: 0, y: 15 };
    const plan = sceneLayerToBakePlan({
      items: [
        { kind: "dropShadow", path: leaf.map((s) => ("x" in s ? { ...s, x: s.x + 2, y: s.y + 2, ...("cx1" in s ? { cx1: s.cx1 + 2, cy1: s.cy1 + 2, cx2: s.cx2 + 2, cy2: s.cy2 + 2 } : {}) } : s)), offset_x: 0, offset_y: 0, blur_radius: 3, r: 0, g: 0, b: 0, a: 0.5 },
        { kind: "fillPath", path: leaf, paint: BLACK },
      ],
    });
    expect(plan.rects).toEqual([]);
    expect(plan.paths).toHaveLength(1);
    expect(plan.paths[0].shadow).toEqual({ xOffset: 2, yOffset: 2, size: 3, opacityPct: 50, colorId: "Color/wb-000000" });
    expect(plan.deferred).toEqual({});
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [] }]);
    const shadowOn = ops
      .filter((o) => (o.args as { path?: string }).path === "frameDropShadowMode")
      .map((o) => (o.args as { elementId: { kind: string } }).elementId.kind);
    expect(shadowOn).toEqual(["polygon"]);
  });

  it("a multi-subpath shape gets its whole geometry in the batch", () => {
    const plan = sceneLayerToBakePlan({
      items: [
        {
          kind: "fillPath",
          path: [...rectPath(0, 0, 30, 30).slice(0, 4), { op: "close" as const }, ...rectPath(10, 10, 20, 20).slice(0, 4)].map(
            (s) => s,
          ),
          paint: BLACK,
        },
      ],
    });
    const { ops } = bakeBatchOps([{ plan, pageId: "uP", top: 100, left: 50, metrics: [] }]);
    const fp = ops.find((o) => (o.args as { path?: string }).path === "framePath") as {
      args: { value: { value: { anchors: { anchor: number[] }[]; subpathStarts: number[] } } };
    };
    expect(fp.args.value.value.subpathStarts).toEqual([0, 4]);
    // A baked fill has no stroke: a new path would take the document's.
    expect(props(ops as never)).toContainEqual(["frameStrokeColor", "Swatch/None"]);
    expect(fp.args.value.value.anchors[4].anchor).toEqual([60, 110]);
  });
});

describe("bake fidelity — images @feat:plugin-web.bake-to-native", () => {
  it("an image becomes an image frame with its pixels inline, in the same batch", () => {
    const plan = sceneLayerToBakePlan({
      items: [{ kind: "image", rgba: [255, 0, 0, 255], width: 1, height: 1, x: 5, y: 6, w: 20, h: 10 }],
    });
    const png = new Uint8Array([1, 2, 3]);
    const { ops, handles } = bakeBatchOps([{ plan, pageId: "uP", top: 100, left: 50, metrics: [], imageBytes: [png] }]);
    expect(handles.images).toEqual(["i0"]);
    expect(ops).toEqual([
      { op: "insertFrame", args: { pageId: "uP", bounds: [106, 55, 116, 75] } },
      { op: "bindCreated", args: { handle: "i0" } },
      { op: "replaceImageBytes", args: { elementId: "$h:i0", bytes: [1, 2, 3] } },
    ]);
  });

  it("an image that did not encode is not baked", () => {
    const plan = sceneLayerToBakePlan({
      items: [{ kind: "image", rgba: [255, 0, 0, 255], width: 1, height: 1, x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(bakeBatchOps([{ plan, pageId: "uP", top: 0, left: 0, metrics: [], imageBytes: [null] }]).ops).toEqual([]);
  });

  it("encodes RGBA as a PNG whose pixels decode back", async () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]);
    const png = await encodePng(rgba, 2, 1);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([2, 1]);
    // IDAT starts after the 8-byte signature + the 25-byte IHDR chunk.
    const idatLen = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, ...rgba]);
  });

  it("a stored zlib stream inflates to its input", () => {
    const data = new Uint8Array(70000).map((_, i) => i % 251);
    expect(Buffer.compare(inflateSync(zlibStored(data)), Buffer.from(data))).toBe(0);
  });
});
