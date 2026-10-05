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

// The BAKE PLANNER (Phase C, ADR-020 "real output") — the PURE half of
// "flatten a rendered web frame into NATIVE Paged page items", so a flowed
// web document exports to IDML/PDF through core's own native export and a
// foreign open sees real content (no plugin engine needed). Mirrors
// plugin-sheets' `lower-to-table.ts`: a pure `SceneLayer → BakePlan`
// translation with ZERO host calls, so it is fully unit-testable. The impure
// orchestrator (`bake-to-document.ts`) measures the runs and applies the
// plan as host mutations.
//
// `bakeBatchOps` is the second pure step: placed plans + measured run metrics
// → the ops of ONE `batch` mutation (one undo step for a whole bake, every
// created id named by a `bindCreated` handle and read back from the outcome's
// `minted` list — no collection diffing).
//
// SCOPE (v0, honest): the dominant content — single-line TEXT runs (position +
// size + fill colour) and solid axis-aligned FILL RECTANGLES (backgrounds /
// borders). Every other SceneItem kind (non-rect fill paths, images, strokes,
// gradients, shadows) is COUNTED in `deferred`, never faked — the caller
// surfaces the counts as a diagnostic. Geometry stays in the SceneLayer's own
// frame-content POINTS; the orchestrator offsets by the frame's page origin.

import type { MutationInput, PageId, PathAnchorSpec } from "@paged-media/plugin-api";
import type { SceneLayer, ScenePathSeg } from "@paged-media/web-model";

/** A process RGB swatch to create (channels 0..255), keyed by a deterministic
 *  `Color/wb-RRGGBB` self-id so the plan can reference it without a read-back.
 *  Deduplicated across the layer — one swatch per distinct colour. */
export interface BakeSwatch {
  id: string;
  r: number;
  g: number;
  b: number;
}

/** A solid fill rectangle → a native rectangle frame. Bounds are
 *  frame-content points `[top, left, bottom, right]`; `fillColorId` is a
 *  {@link BakeSwatch} id. */
export interface BakeRect {
  bounds: [number, number, number, number];
  fillColorId: string;
}

/** A solid NON-rectangular fill → a native path (`insertPath`). `anchors`
 *  are in frame-content points (the orchestrator offsets them by the frame's
 *  page origin); `fillColorId` is a {@link BakeSwatch} id. Single-subpath
 *  only in v1 — a multi-subpath fill stays deferred. */
export interface BakePath {
  anchors: PathAnchorSpec[];
  fillColorId: string;
}

/** A single-line text run → a native text frame. `left`/`baseline` are the
 *  run's origin in frame-content points (the C-1 `SceneTextItem` x / y);
 *  the orchestrator sizes the frame (width via `host.text.measureString`,
 *  height from `sizePt`). `fillColorId` is a {@link BakeSwatch} id. */
export interface BakeText {
  left: number;
  baseline: number;
  text: string;
  sizePt: number;
  fillColorId: string;
}

/** The native-content plan for one rendered web frame — pure data. */
export interface BakePlan {
  swatches: BakeSwatch[];
  rects: BakeRect[];
  paths: BakePath[];
  texts: BakeText[];
  /** Un-baked SceneItem kinds, counted honestly (never faked). Keys are the
   *  wire `kind` (or a refinement like `fillPath.multiSubpath`); values are counts. */
  deferred: Record<string, number>;
}

/** Two hex nibbles for a 0..1 channel, clamped — the swatch id + value share
 *  this rounding so a colour maps to exactly one swatch. */
function channel255(v: number): number {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return n;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** A path is an axis-aligned rectangle iff its segments visit exactly two
 *  distinct x's and two distinct y's along axis-aligned edges (a `moveTo`, up
 *  to four `lineTo`, optional `close`; any `cubicTo` disqualifies it). Returns
 *  the bounds `[top, left, bottom, right]`, or `null` when it is not a rect. */
export function pathAsRect(
  path: ScenePathSeg[],
): [number, number, number, number] | null {
  const xs = new Set<number>();
  const ys = new Set<number>();
  let pts = 0;
  for (const seg of path) {
    if (seg.op === "close") continue;
    if (seg.op === "cubicTo") return null; // a curve is not an axis-aligned rect
    // moveTo | lineTo — round to 3dp so float noise doesn't inflate the count.
    xs.add(Math.round(seg.x * 1000) / 1000);
    ys.add(Math.round(seg.y * 1000) / 1000);
    pts += 1;
  }
  // A rectangle traces 4 corners (a 5th point may repeat the first).
  if (pts < 4 || pts > 5 || xs.size !== 2 || ys.size !== 2) return null;
  const xArr = [...xs].sort((a, b) => a - b);
  const yArr = [...ys].sort((a, b) => a - b);
  return [yArr[0], xArr[0], yArr[1], xArr[1]];
}

/** Convert a SINGLE-subpath {@link ScenePathSeg} run to `insertPath` anchors
 *  (frame-content points). Each anchor is a `{ anchor, left, right }` triple:
 *  a corner point has `left = right = anchor`; a `cubicTo` sets the PREVIOUS
 *  anchor's `right` out-handle (its first control point) and the NEW anchor's
 *  `left` in-handle (its second) — the InDesign bezier model. Returns `null`
 *  for a multi-subpath path (a second `moveTo`), a cubic with no start, or a
 *  degenerate run (< 2 anchors) — those stay deferred. A `close` is geometry-
 *  neutral (a fill is a closed region regardless). */
export function pathToAnchors(path: ScenePathSeg[]): PathAnchorSpec[] | null {
  const anchors: PathAnchorSpec[] = [];
  let started = false;
  for (const seg of path) {
    if (seg.op === "moveTo") {
      if (started) return null; // a second subpath — v1 is single-subpath only
      started = true;
      anchors.push({ anchor: [seg.x, seg.y], left: [seg.x, seg.y], right: [seg.x, seg.y] });
    } else if (seg.op === "lineTo") {
      if (!started) return null;
      anchors.push({ anchor: [seg.x, seg.y], left: [seg.x, seg.y], right: [seg.x, seg.y] });
    } else if (seg.op === "cubicTo") {
      if (anchors.length === 0) return null;
      anchors[anchors.length - 1].right = [seg.cx1, seg.cy1];
      anchors.push({ anchor: [seg.x, seg.y], left: [seg.cx2, seg.cy2], right: [seg.x, seg.y] });
    }
    // `close` — ignored: the fill is closed by the engine either way.
  }
  return anchors.length >= 2 ? anchors : null;
}

/**
 * Translate a rendered {@link SceneLayer} into a {@link BakePlan}: text runs
 * and solid rectangles become native content; every other kind is counted in
 * `deferred`. Pure + total — same layer → same plan, never throws. Colours are
 * deduplicated into `swatches` (opaque colours only; a fully transparent paint
 * is skipped as "nothing to paint").
 */
export function sceneLayerToBakePlan(layer: SceneLayer): BakePlan {
  const swatchById = new Map<string, BakeSwatch>();
  const rects: BakeRect[] = [];
  const paths: BakePath[] = [];
  const texts: BakeText[] = [];
  const deferred: Record<string, number> = {};
  const defer = (k: string) => {
    deferred[k] = (deferred[k] ?? 0) + 1;
  };

  /** Register (dedupe) a paint as a swatch and return its id, or null when the
   *  paint is fully transparent (nothing to bake). */
  const swatchFor = (paint: {
    r: number;
    g: number;
    b: number;
    a: number;
  }): string | null => {
    if (paint.a <= 0) return null;
    const r = channel255(paint.r);
    const g = channel255(paint.g);
    const b = channel255(paint.b);
    const id = `Color/wb-${hex2(r)}${hex2(g)}${hex2(b)}`;
    if (!swatchById.has(id)) swatchById.set(id, { id, r, g, b });
    return id;
  };

  for (const item of layer.items) {
    switch (item.kind) {
      case "text": {
        if (item.text.length === 0) break;
        const colorId = swatchFor(item.paint);
        if (colorId === null) break; // transparent text → nothing to bake
        texts.push({
          left: item.x,
          baseline: item.y,
          text: item.text,
          sizePt: item.size,
          fillColorId: colorId,
        });
        break;
      }
      case "fillPath": {
        const colorId = swatchFor(item.paint);
        if (colorId === null) break; // transparent fill → nothing to bake
        // An axis-aligned rectangle → a native rectangle frame (the simplest,
        // most common fill: backgrounds / borders).
        const rect = pathAsRect(item.path);
        if (rect !== null) {
          rects.push({ bounds: rect, fillColorId: colorId });
          break;
        }
        // Any other single-subpath fill (rounded rects, decorative shapes) →
        // a native path; a multi-subpath fill stays deferred.
        const anchors = pathToAnchors(item.path);
        if (anchors !== null) {
          paths.push({ anchors, fillColorId: colorId });
          break;
        }
        defer("fillPath.multiSubpath");
        break;
      }
      case "image": {
        defer("image");
        break;
      }
      default: {
        // A wire kind web-model's SceneItem union doesn't name yet
        // (strokePath, gradients, shadows) — count by its tag if present.
        const kind = (item as { kind?: string }).kind ?? "unknown";
        defer(kind);
        break;
      }
    }
  }

  return {
    swatches: [...swatchById.values()],
    rects,
    paths,
    texts,
    deferred,
  };
}

// ---------------------------------------------------------------- one batch

/** A little width slack on a baked text frame so the run never clips at the
 *  right edge (points). */
export const TEXT_PAD_PT = 2;

/** A run's measured extent in points (`host.text.measureString`'s answer, or
 *  the orchestrator's estimate). `descender` is negative below the baseline. */
export interface RunMetrics {
  advance: number;
  ascender: number;
  descender: number;
}

/** One frame's plan placed on its page: the plan's frame-content points are
 *  offset by the frame's page origin (`top`/`left`, points). `metrics` holds
 *  one entry per `plan.texts` item, same order. */
export interface PlacedBakePlan {
  plan: BakePlan;
  pageId: PageId | string;
  top: number;
  left: number;
  metrics: readonly RunMetrics[];
}

/** The ops of one bake batch, plus the handle each created item is bound to
 *  (the outcome's `minted[].handle` names them back). */
export interface BakeBatch {
  ops: MutationInput[];
  /** Swatch ids the batch creates (the plans' swatches minus `existing`,
   *  each once). */
  swatchIds: string[];
  /** Handles of the rectangles, paths and text frames, in op order. */
  handles: { rects: string[]; paths: string[]; texts: string[] };
}

/** Story offsets count CHARACTERS (Unicode scalar values) — the engine's
 *  `chars().count()` — not UTF-16 code units. */
export function charCount(text: string): number {
  let n = 0;
  for (const _c of text) n += 1;
  return n;
}

const storyRangeOf = (handle: string, end: number) => ({
  kind: "storyRange",
  id: { story_id: `$h:${handle}`, start: 0, end },
});

/**
 * Translate placed plans into the ops of ONE `batch` mutation — the whole
 * bake as one undo step. Pure: same input → same ops.
 *
 * Order: every new swatch first (deduplicated across frames, and skipping
 * `existing` — the engine refuses a duplicate swatch self-id and a refused
 * child rolls the whole batch back), then per frame its rectangles, paths
 * and text runs. Each creating op is followed by a `bindCreated` naming its
 * mint, and later ops address it as `$h:<handle>`: a text frame's handle in
 * a `storyId` / `story_id` position resolves to the story it minted, so a
 * run is inserted, sized and coloured without reading the story back.
 * Requires the engine's C-15 batch handles (protocol 57; `story_id` in a
 * `storyRange` address from 66).
 */
export function bakeBatchOps(
  placed: readonly PlacedBakePlan[],
  existing: ReadonlySet<string> = new Set(),
): BakeBatch {
  const ops: MutationInput[] = [];
  const swatchIds: string[] = [];
  const seen = new Set(existing);
  const handles = { rects: [] as string[], paths: [] as string[], texts: [] as string[] };

  for (const { plan } of placed) {
    for (const s of plan.swatches) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      swatchIds.push(s.id);
      ops.push({
        op: "createSwatch",
        args: {
          spec: { selfId: s.id, name: s.id, space: "RGB", value: [s.r, s.g, s.b], model: "Process" },
        },
      } as MutationInput);
    }
  }

  for (const { plan, pageId: page, top, left, metrics } of placed) {
    const pageId = page as PageId;
    for (const rect of plan.rects) {
      const handle = `r${handles.rects.length}`;
      handles.rects.push(handle);
      const [rt, rl, rb, rr] = rect.bounds;
      ops.push(
        { op: "insertFrame", args: { pageId, bounds: [rt + top, rl + left, rb + top, rr + left] } },
        { op: "bindCreated", args: { handle } },
        {
          op: "setElementProperty",
          args: {
            elementId: { kind: "rectangle", id: `$h:${handle}` },
            path: "frameFillColor",
            value: { type: "colorRef", value: rect.fillColorId },
          },
        } as MutationInput,
      );
    }
    for (const p of plan.paths) {
      const handle = `p${handles.paths.length}`;
      handles.paths.push(handle);
      const anchors = p.anchors.map((a) => ({
        anchor: [a.anchor[0] + left, a.anchor[1] + top] as [number, number],
        left: [a.left[0] + left, a.left[1] + top] as [number, number],
        right: [a.right[0] + left, a.right[1] + top] as [number, number],
      }));
      ops.push(
        { op: "insertPath", args: { pageId, anchors, open: false } },
        { op: "bindCreated", args: { handle } },
        {
          op: "setElementProperty",
          args: {
            elementId: { kind: "polygon", id: `$h:${handle}` },
            path: "frameFillColor",
            value: { type: "colorRef", value: p.fillColorId },
          },
        } as MutationInput,
      );
    }
    plan.texts.forEach((t, i) => {
      const m = metrics[i];
      if (!m) return;
      const handle = `t${handles.texts.length}`;
      handles.texts.push(handle);
      const pageLeft = t.left + left;
      const pageBaseline = t.baseline + top;
      const bounds: [number, number, number, number] = [
        pageBaseline - m.ascender,
        pageLeft,
        pageBaseline - m.descender,
        pageLeft + Math.max(1, m.advance) + TEXT_PAD_PT,
      ];
      const range = storyRangeOf(handle, charCount(t.text));
      ops.push(
        { op: "insertTextFrame", args: { pageId, bounds } },
        { op: "bindCreated", args: { handle } },
        { op: "insertText", args: { storyId: `$h:${handle}`, offset: 0, text: t.text } },
        {
          op: "setElementProperty",
          args: { elementId: range, path: "characterFontSize", value: { type: "length", value: t.sizePt } },
        } as MutationInput,
        {
          op: "setElementProperty",
          args: {
            elementId: range,
            path: "characterFillColor",
            value: { type: "colorRef", value: t.fillColorId },
          },
        } as MutationInput,
      );
    });
  }

  return { ops, swatchIds, handles };
}
