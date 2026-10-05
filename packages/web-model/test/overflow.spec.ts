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

// Overflow policies in the source model: the four policies persist in the
// envelope, an unknown value reads as clip, and a scene layer scales by a
// factor (the shrink-to-fit policy).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOURCE,
  OVERFLOW_POLICIES,
  envelopeFor,
  normalizeOverflow,
  scaleSceneLayer,
  sourceFromEnvelope,
  type SceneLayer,
} from "../src";

describe("overflow policy persists in the source", () => {
  it("each policy round-trips through the label envelope", () => {
    for (const overflow of OVERFLOW_POLICIES) {
      const env = envelopeFor({ ...DEFAULT_SOURCE, options: { media: "print", overflow } });
      const back = sourceFromEnvelope(JSON.parse(JSON.stringify(env)));
      expect(back?.options.overflow).toBe(overflow);
    }
  });

  it("an unknown or missing policy reads as clip", () => {
    expect(normalizeOverflow("explode")).toBe("clip");
    expect(normalizeOverflow(undefined)).toBe("clip");
    expect(normalizeOverflow(3)).toBe("clip");
    const env = envelopeFor(DEFAULT_SOURCE);
    (env.data as { options: Record<string, unknown> }).options = { media: "screen" };
    expect(sourceFromEnvelope(env)?.options.overflow).toBe("clip");
  });

  it("the four policies are clip, shrink, grow and thread", () => {
    expect([...OVERFLOW_POLICIES]).toEqual(["clip", "shrink", "grow", "thread"]);
  });
});

describe("scaleSceneLayer", () => {
  it("scales geometry and point sizes, never colours or image pixel sizes", () => {
    const layer = {
      items: [
        {
          kind: "fillPath",
          path: [
            { op: "moveTo", x: 10, y: 20 },
            { op: "cubicTo", cx1: 2, cy1: 4, cx2: 6, cy2: 8, x: 10, y: 12 },
            { op: "close" },
          ],
          paint: { r: 1, g: 0.5, b: 0.25, a: 1 },
        },
        { kind: "text", x: 4, y: 8, text: "Hi", size: 12, paint: { r: 0, g: 0, b: 0, a: 1 } },
        { kind: "image", rgba: [1, 2, 3, 4], width: 1, height: 1, x: 2, y: 2, w: 10, h: 20 },
        {
          kind: "strokePath",
          path: [{ op: "moveTo", x: 1, y: 1 }],
          paint: { r: 0, g: 0, b: 0, a: 1 },
          width: 2,
        },
        {
          kind: "fillPathGradient",
          path: [],
          gradient: { type: "radial", cx: 10, cy: 10, radius: 5, stops: [{ offset: 0.5, r: 1, g: 1, b: 1, a: 1 }] },
        },
        { kind: "dropShadow", path: [], offset_x: 2, offset_y: 4, blur_radius: 6, r: 0, g: 0, b: 0, a: 0.5 },
      ],
    } as unknown as SceneLayer;
    const half = scaleSceneLayer(layer, 0.5) as unknown as { items: Record<string, unknown>[] };
    const [path, text, image, stroke, grad, shadow] = half.items;
    expect((path.path as Record<string, number>[])[0]).toEqual({ op: "moveTo", x: 5, y: 10 });
    expect((path.path as Record<string, number>[])[1]).toEqual({
      op: "cubicTo", cx1: 1, cy1: 2, cx2: 3, cy2: 4, x: 5, y: 6,
    });
    expect(path.paint).toEqual({ r: 1, g: 0.5, b: 0.25, a: 1 });
    expect(text).toMatchObject({ x: 2, y: 4, size: 6, text: "Hi" });
    expect(image).toMatchObject({ width: 1, height: 1, x: 1, y: 1, w: 5, h: 10 });
    expect(stroke.width).toBe(1);
    expect(grad.gradient).toMatchObject({ cx: 5, cy: 5, radius: 2.5 });
    expect((grad.gradient as { stops: unknown[] }).stops[0]).toEqual({ offset: 0.5, r: 1, g: 1, b: 1, a: 1 });
    expect(shadow).toMatchObject({ offset_x: 1, offset_y: 2, blur_radius: 3, a: 0.5 });
  });

  it("factor 1 returns the same layer", () => {
    const layer: SceneLayer = { items: [] };
    expect(scaleSceneLayer(layer, 1)).toBe(layer);
  });
});
