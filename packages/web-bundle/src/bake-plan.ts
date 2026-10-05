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
// orchestrator (`bake-to-document.ts`) measures the runs, encodes the images
// and applies the plan as host mutations.
//
// `bakeBatchOps` is the second pure step: placed plans + measured run metrics
// → the ops of ONE `batch` mutation (one undo step for a whole bake, every
// created id named by a `bindCreated` handle and read back from the outcome's
// `minted` list — no collection diffing).
//
// What bakes: text runs (position, size, colour, family + style, opacity),
// solid fills (rectangles, single- and multi-subpath paths), strokes, linear
// and radial gradient fills (native gradient swatches), a translucent paint
// (item opacity), an outer box shadow (the native drop-shadow effect on the
// rectangle that casts it) and raster images (an image frame with the pixels
// inline). What does not is COUNTED in `deferred`, never faked: sweep
// gradients, gradient strokes, blend modes, inner shadows, a shadow on a
// non-rectangular box (the engine sets drop shadows on rectangles and text
// frames only), translucent gradient stops (baked opaque). Geometry stays in
// the SceneLayer's own frame-content POINTS; the orchestrator offsets by the
// frame's page origin.

import type { MutationInput, PageId, PathAnchorSpec } from "@paged-media/plugin-api";
import type { SceneGradient, SceneLayer, ScenePathSeg } from "@paged-media/web-model";

/** A process RGB swatch to create (channels 0..255), keyed by a deterministic
 *  `Color/wb-RRGGBB` self-id so the plan can reference it without a read-back.
 *  Deduplicated across the layer — one swatch per distinct colour. */
export interface BakeSwatch {
  id: string;
  r: number;
  g: number;
  b: number;
}

/** A gradient swatch to create, keyed by a deterministic `Gradient/wb-…`
 *  self-id; each stop references a {@link BakeSwatch}. */
export interface BakeGradient {
  id: string;
  kind: "Linear" | "Radial";
  stops: { colorId: string; locationPct: number }[];
}

/** A stroke: a swatch id and a weight in points. */
export interface BakeStroke {
  colorId: string;
  weight: number;
}

/** How a gradient lies on the item that it fills: angle (degrees,
 *  counter-clockwise from the x axis, as InDesign measures it) and length
 *  (points). */
export interface BakeGradientPlacement {
  angle: number;
  length: number;
}

/** A native drop shadow: offsets and size in points, opacity 0..100, colour
 *  a swatch id. */
export interface BakeShadow {
  xOffset: number;
  yOffset: number;
  size: number;
  opacityPct: number;
  colorId: string;
}

/** A rectangle → a native rectangle frame. Bounds are frame-content points
 *  `[top, left, bottom, right]`; `fillColorId` is a {@link BakeSwatch} or
 *  {@link BakeGradient} id (`null`: no fill, a stroke-only rectangle). */
export interface BakeRect {
  bounds: [number, number, number, number];
  fillColorId: string | null;
  gradient?: BakeGradientPlacement;
  stroke?: BakeStroke;
  /** Item opacity 0..100 (a translucent paint); absent = opaque. */
  opacity?: number;
  shadow?: BakeShadow;
}

/** A NON-rectangular shape → a native path (`insertPath`). `anchors` (the
 *  first subpath) are in frame-content points; `subpaths` holds every
 *  subpath when there is more than one (a ring, a glyph-like shape) — the
 *  path is then given its full geometry in the same batch. */
export interface BakePath {
  anchors: PathAnchorSpec[];
  subpaths?: PathAnchorSpec[][];
  /** An open path (a stroke that does not close). */
  open?: boolean;
  fillColorId: string | null;
  gradient?: BakeGradientPlacement;
  stroke?: BakeStroke;
  opacity?: number;
}

/** A single-line text run → a native text frame. `left`/`baseline` are the
 *  run's origin in frame-content points (the C-1 `SceneTextItem` x / y);
 *  the orchestrator sizes the frame (width: the engine's shaped advance or
 *  `host.text.measureString`, height from `sizePt`). `fillColorId` is a
 *  {@link BakeSwatch} id; `family` / `fontStyle` the face the run was
 *  shaped with (`fontStyle` in IDML spelling: `"Bold Italic"`). */
export interface BakeText {
  left: number;
  baseline: number;
  text: string;
  sizePt: number;
  fillColorId: string;
  family?: string;
  fontStyle?: string;
  /** The run's shaped advance (points), from the engine. */
  advance?: number;
  opacity?: number;
}

/** A raster image → a native image frame carrying the pixels. `rgba` is
 *  straight RGBA8, `width` x `height`; the orchestrator encodes it. */
export interface BakeImage {
  bounds: [number, number, number, number];
  rgba: Uint8Array | number[];
  width: number;
  height: number;
}

/** The native-content plan for one rendered web frame — pure data. */
export interface BakePlan {
  swatches: BakeSwatch[];
  gradients: BakeGradient[];
  rects: BakeRect[];
  paths: BakePath[];
  texts: BakeText[];
  images: BakeImage[];
  /** Un-baked SceneItem kinds, counted honestly (never faked). Keys are the
   *  wire `kind` (or a refinement like `dropShadow.onPath`); values are
   *  counts. */
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

/** Split a {@link ScenePathSeg} run into its subpaths' anchors (see
 *  {@link pathToAnchors}), and whether it is OPEN (no subpath closes — a
 *  stroked line). `null` when a subpath is degenerate (< 2 anchors) or a
 *  segment has no start. */
export function pathToSubpaths(
  path: ScenePathSeg[],
): { subpaths: PathAnchorSpec[][]; open: boolean } | null {
  const subpaths: PathAnchorSpec[][] = [];
  let cur: PathAnchorSpec[] | null = null;
  let closed = false;
  for (const seg of path) {
    if (seg.op === "moveTo") {
      cur = [{ anchor: [seg.x, seg.y], left: [seg.x, seg.y], right: [seg.x, seg.y] }];
      subpaths.push(cur);
    } else if (seg.op === "lineTo") {
      if (!cur) return null;
      cur.push({ anchor: [seg.x, seg.y], left: [seg.x, seg.y], right: [seg.x, seg.y] });
    } else if (seg.op === "cubicTo") {
      if (!cur || cur.length === 0) return null;
      cur[cur.length - 1].right = [seg.cx1, seg.cy1];
      cur.push({ anchor: [seg.x, seg.y], left: [seg.cx2, seg.cy2], right: [seg.x, seg.y] });
    } else {
      closed = true;
    }
  }
  if (subpaths.length === 0 || subpaths.some((sp) => sp.length < 2)) return null;
  return { subpaths, open: !closed };
}

/** A path's axis-aligned bounds `[top, left, bottom, right]` (anchor and
 *  control points), or `null` for an empty path. */
export function pathBounds(path: ScenePathSeg[]): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const seg of path) {
    if (seg.op === "close") continue;
    xs.push(seg.x);
    ys.push(seg.y);
    if (seg.op === "cubicTo") {
      xs.push(seg.cx1, seg.cx2);
      ys.push(seg.cy1, seg.cy2);
    }
  }
  if (xs.length === 0) return null;
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

/** The face name a run asks for within its family, from its CSS weight and
 *  slope — the type-menu naming core uses for a scene run (`700` + italic →
 *  `"Bold Italic"`, `400` → `"Regular"`). */
export function fontStyleName(weight: number | undefined, italic: boolean | undefined): string {
  const w = Math.round(weight ?? 400);
  const base =
    w < 150 ? "Thin"
    : w < 250 ? "ExtraLight"
    : w < 350 ? "Light"
    : w < 450 ? "Regular"
    : w < 550 ? "Medium"
    : w < 650 ? "SemiBold"
    : w < 750 ? "Bold"
    : w < 850 ? "ExtraBold"
    : "Black";
  if (!italic) return base;
  return base === "Regular" ? "Italic" : `${base} Italic`;
}

/** FNV-1a, 8 hex digits — deterministic ids for gradient swatches. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** An opacity percentage for a 0..1 alpha, `undefined` when opaque. */
function opacityOf(a: number): number | undefined {
  const pct = Math.round(Math.max(0, Math.min(1, a)) * 1000) / 10;
  return pct >= 100 ? undefined : pct;
}

const NEAR = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/**
 * Translate a rendered {@link SceneLayer} into a {@link BakePlan}. Pure +
 * total — same layer → same plan, never throws. Colours are deduplicated into
 * `swatches` (a fully transparent paint is skipped as "nothing to paint"; a
 * translucent one becomes the item's opacity). `advances` is the engine's
 * shaped advance per `text` item, in item order (`take_text_advances`).
 */
export function sceneLayerToBakePlan(layer: SceneLayer, advances: readonly number[] = []): BakePlan {
  const swatchById = new Map<string, BakeSwatch>();
  const gradientById = new Map<string, BakeGradient>();
  const rects: BakeRect[] = [];
  const paths: BakePath[] = [];
  const texts: BakeText[] = [];
  const images: BakeImage[] = [];
  const deferred: Record<string, number> = {};
  const defer = (k: string) => {
    deferred[k] = (deferred[k] ?? 0) + 1;
  };
  /** Outer shadows waiting for the rectangle that casts them (blitz paints
   *  a box's shadow just before the box), with their painted bounds. */
  const shadows: { bounds: [number, number, number, number]; size: number; opacityPct: number; colorId: string }[] = [];

  /** Register (dedupe) a paint as a swatch and return its id, or null when the
   *  paint is fully transparent (nothing to bake). */
  const swatchFor = (paint: { r: number; g: number; b: number; a: number }): string | null => {
    if (paint.a <= 0) return null;
    const r = channel255(paint.r);
    const g = channel255(paint.g);
    const b = channel255(paint.b);
    const id = `Color/wb-${hex2(r)}${hex2(g)}${hex2(b)}`;
    if (!swatchById.has(id)) swatchById.set(id, { id, r, g, b });
    return id;
  };

  const gradientFor = (
    gradient: SceneGradient,
  ): { id: string; placement: BakeGradientPlacement } | null => {
    if (gradient.type === "sweep" || gradient.stops.length < 2) return null;
    if (gradient.stops.some((st) => st.a < 1)) defer("fillPathGradient.translucentStop");
    const stops = gradient.stops.map((st) => ({
      colorId: swatchFor({ ...st, a: 1 }) as string,
      locationPct: Math.round(Math.max(0, Math.min(1, st.offset)) * 1000) / 10,
    }));
    const kind = gradient.type === "linear" ? "Linear" : "Radial";
    const id = `Gradient/wb-${shortHash(JSON.stringify([kind, stops]))}`;
    if (!gradientById.has(id)) gradientById.set(id, { id, kind, stops });
    const placement =
      gradient.type === "linear"
        ? {
            angle: (Math.atan2(-(gradient.y1 - gradient.y0), gradient.x1 - gradient.x0) * 180) / Math.PI,
            length: Math.hypot(gradient.x1 - gradient.x0, gradient.y1 - gradient.y0),
          }
        : { angle: 0, length: gradient.radius };
    return { id, placement };
  };

  /** A filled or stroked shape: a rectangle when it is one, else a path. */
  const shape = (
    path: ScenePathSeg[],
    fill: { colorId: string | null; gradient?: BakeGradientPlacement },
    extra: { stroke?: BakeStroke; opacity?: number },
    kind: string,
  ): void => {
    const rect = extra.stroke === undefined || path.some((sg) => sg.op === "close") ? pathAsRect(path) : null;
    if (rect !== null) {
      const r: BakeRect = { bounds: rect, fillColorId: fill.colorId };
      if (fill.gradient) r.gradient = fill.gradient;
      if (extra.stroke) r.stroke = extra.stroke;
      if (extra.opacity !== undefined) r.opacity = extra.opacity;
      // The rectangle that casts a waiting shadow: same size, offset by the
      // shadow's offset.
      const h = rect[2] - rect[0];
      const w = rect[3] - rect[1];
      const i = shadows.findIndex(
        (sh) => NEAR(sh.bounds[2] - sh.bounds[0], h) && NEAR(sh.bounds[3] - sh.bounds[1], w),
      );
      if (i >= 0) {
        const [sh] = shadows.splice(i, 1);
        r.shadow = {
          xOffset: sh.bounds[1] - rect[1],
          yOffset: sh.bounds[0] - rect[0],
          size: sh.size,
          opacityPct: sh.opacityPct,
          colorId: sh.colorId,
        };
      }
      rects.push(r);
      return;
    }
    const geo = pathToSubpaths(path);
    if (geo === null) {
      defer(`${kind}.degenerate`);
      return;
    }
    const p: BakePath = { anchors: geo.subpaths[0], fillColorId: fill.colorId };
    if (geo.subpaths.length > 1) p.subpaths = geo.subpaths;
    if (geo.open && extra.stroke) p.open = true;
    if (fill.gradient) p.gradient = fill.gradient;
    if (extra.stroke) p.stroke = extra.stroke;
    if (extra.opacity !== undefined) p.opacity = extra.opacity;
    paths.push(p);
  };

  let textIndex = 0;
  for (const item of layer.items) {
    switch (item.kind) {
      case "text": {
        const advance = advances[textIndex];
        textIndex += 1;
        if (item.text.length === 0) break;
        const colorId = swatchFor(item.paint);
        if (colorId === null) break; // transparent text → nothing to bake
        const t: BakeText = {
          left: item.x,
          baseline: item.y,
          text: item.text,
          sizePt: item.size,
          fillColorId: colorId,
        };
        if (item.family) {
          t.family = item.family;
          t.fontStyle = item.style ?? fontStyleName(item.weight, item.italic);
        }
        if (typeof advance === "number" && advance > 0) t.advance = advance;
        const opacity = opacityOf(item.paint.a);
        if (opacity !== undefined) t.opacity = opacity;
        texts.push(t);
        break;
      }
      case "fillPath": {
        const colorId = swatchFor(item.paint);
        if (colorId === null) break; // transparent fill → nothing to bake
        shape(item.path, { colorId }, { opacity: opacityOf(item.paint.a) }, "fillPath");
        break;
      }
      case "strokePath": {
        const colorId = swatchFor(item.paint);
        if (colorId === null || !(item.width > 0)) break;
        shape(item.path, { colorId: null }, { stroke: { colorId, weight: item.width }, opacity: opacityOf(item.paint.a) }, "strokePath");
        break;
      }
      case "fillPathGradient": {
        const g = gradientFor(item.gradient);
        if (g === null) {
          defer(`fillPathGradient.${item.gradient.type}`);
          break;
        }
        shape(item.path, { colorId: g.id, gradient: g.placement }, {}, "fillPathGradient");
        break;
      }
      case "dropShadow": {
        const bounds = pathBounds(item.path);
        const colorId = swatchFor({ r: item.r, g: item.g, b: item.b, a: 1 });
        if (bounds === null || colorId === null || item.a <= 0) break;
        shadows.push({
          bounds: [bounds[0] + item.offset_y, bounds[1] + item.offset_x, bounds[2] + item.offset_y, bounds[3] + item.offset_x],
          // The wire carries the CSS blur radius (the layout engine hands
          // it on as is); CSS blurs with a deviation of half of it, and
          // InDesign's Size is twice the deviation — the same number.
          size: item.blur_radius,
          opacityPct: Math.round(Math.max(0, Math.min(1, item.a)) * 1000) / 10,
          colorId,
        });
        break;
      }
      case "image": {
        if (!(item.width > 0 && item.height > 0) || item.rgba.length !== item.width * item.height * 4) {
          defer("image.malformed");
          break;
        }
        images.push({
          bounds: [item.y, item.x, item.y + item.h, item.x + item.w],
          rgba: item.rgba,
          width: item.width,
          height: item.height,
        });
        break;
      }
      default: {
        // A wire kind the bake has no native twin for (blend modes, inner
        // shadows, gradient strokes) — counted by its tag.
        const kind = (item as { kind?: string }).kind ?? "unknown";
        defer(kind);
        break;
      }
    }
  }
  // A shadow whose box is not a rectangle (a rounded box bakes as a path,
  // and the engine sets drop shadows on rectangles and text frames only).
  for (let i = 0; i < shadows.length; i += 1) defer("dropShadow.onPath");

  return {
    swatches: [...swatchById.values()],
    gradients: [...gradientById.values()],
    rects,
    paths,
    texts,
    images,
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
 *  one entry per `plan.texts` item, same order; `imageBytes` one encoded
 *  image (PNG) per `plan.images` item, `null` where encoding failed. */
export interface PlacedBakePlan {
  plan: BakePlan;
  pageId: PageId | string;
  top: number;
  left: number;
  metrics: readonly RunMetrics[];
  imageBytes?: readonly (Uint8Array | null)[];
}

/** The ops of one bake batch, plus the handle each created item is bound to
 *  (the outcome's `minted[].handle` names them back). */
export interface BakeBatch {
  ops: MutationInput[];
  /** Swatch ids the batch creates (the plans' swatches minus `existing`,
   *  each once). */
  swatchIds: string[];
  /** Gradient ids the batch creates. */
  gradientIds: string[];
  /** Handles of the rectangles, paths, images and text frames, in op order. */
  handles: { rects: string[]; paths: string[]; texts: string[]; images: string[] };
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

const setProp = (
  elementId: unknown,
  path: string,
  value: { type: string; value: unknown },
): MutationInput => ({ op: "setElementProperty", args: { elementId, path, value } }) as MutationInput;

const shift = (a: PathAnchorSpec, left: number, top: number): PathAnchorSpec => ({
  anchor: [a.anchor[0] + left, a.anchor[1] + top],
  left: [a.left[0] + left, a.left[1] + top],
  right: [a.right[0] + left, a.right[1] + top],
});

/** The style ops of a shape (rectangle or path) addressed as `el`. */
function shapeStyleOps(
  el: { kind: string; id: string },
  s: { fillColorId: string | null; gradient?: BakeGradientPlacement; stroke?: BakeStroke; opacity?: number },
): MutationInput[] {
  const ops: MutationInput[] = [];
  // A new path takes the document's default stroke (black, 1 pt in a new
  // document); a baked fill has none, so say so.
  if (!s.stroke && el.kind === "polygon") {
    ops.push(setProp(el, "frameStrokeColor", { type: "colorRef", value: NO_SWATCH }));
  }
  if (s.fillColorId !== null) ops.push(setProp(el, "frameFillColor", { type: "colorRef", value: s.fillColorId }));
  if (s.gradient) {
    ops.push(setProp(el, "frameGradientFillAngle", { type: "length", value: round3(s.gradient.angle) }));
    ops.push(setProp(el, "frameGradientFillLength", { type: "length", value: round3(s.gradient.length) }));
  }
  if (s.stroke) {
    ops.push(setProp(el, "frameStrokeColor", { type: "colorRef", value: s.stroke.colorId }));
    ops.push(setProp(el, "frameStrokeWeight", { type: "length", value: s.stroke.weight }));
  }
  if (s.opacity !== undefined) ops.push(setProp(el, "frameOpacity", { type: "length", value: s.opacity }));
  return ops;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The swatch that paints nothing (IDML `Swatch/None`). */
const NO_SWATCH = "Swatch/None";

/**
 * Translate placed plans into the ops of ONE `batch` mutation — the whole
 * bake as one undo step. Pure: same input → same ops.
 *
 * Order: every new swatch first, then every new gradient swatch
 * (deduplicated across frames, skipping `existing` — the engine refuses a
 * duplicate self-id and a refused child rolls the whole batch back), then per
 * frame its rectangles, paths, images and text runs. Each creating op is
 * followed by a `bindCreated` naming its mint, and later ops address it as
 * `$h:<handle>`: a text frame's handle in a `storyId` / `story_id` position
 * resolves to the story it minted, so a run is inserted, sized, set in its
 * face and coloured without reading the story back. Requires the engine's
 * C-15 batch handles (protocol 57; `story_id` in a `storyRange` address from
 * 66).
 */
export function bakeBatchOps(
  placed: readonly PlacedBakePlan[],
  existing: ReadonlySet<string> = new Set(),
): BakeBatch {
  const ops: MutationInput[] = [];
  const swatchIds: string[] = [];
  const gradientIds: string[] = [];
  const seen = new Set(existing);
  const handles = { rects: [] as string[], paths: [] as string[], texts: [] as string[], images: [] as string[] };

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
  for (const { plan } of placed) {
    for (const g of plan.gradients ?? []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      gradientIds.push(g.id);
      ops.push({
        op: "createGradient",
        args: {
          spec: {
            selfId: g.id,
            name: g.id,
            kind: g.kind,
            stops: g.stops.map((st) => ({ stopColor: st.colorId, locationPct: st.locationPct })),
          },
        },
      } as MutationInput);
    }
  }

  for (const { plan, pageId: page, top, left, metrics, imageBytes } of placed) {
    const pageId = page as PageId;
    for (const rect of plan.rects) {
      const handle = `r${handles.rects.length}`;
      handles.rects.push(handle);
      const el = { kind: "rectangle", id: `$h:${handle}` };
      const [rt, rl, rb, rr] = rect.bounds;
      ops.push(
        { op: "insertFrame", args: { pageId, bounds: [rt + top, rl + left, rb + top, rr + left] } },
        { op: "bindCreated", args: { handle } },
        ...shapeStyleOps(el, rect),
      );
      if (rect.shadow) {
        const sh = rect.shadow;
        ops.push(
          setProp(el, "frameDropShadowMode", { type: "text", value: "Drop" }),
          setProp(el, "frameDropShadowXOffset", { type: "length", value: round3(sh.xOffset) }),
          setProp(el, "frameDropShadowYOffset", { type: "length", value: round3(sh.yOffset) }),
          setProp(el, "frameDropShadowSize", { type: "length", value: round3(sh.size) }),
          setProp(el, "frameDropShadowOpacity", { type: "length", value: sh.opacityPct }),
          setProp(el, "frameDropShadowColor", { type: "colorRef", value: sh.colorId }),
        );
      }
    }
    for (const p of plan.paths) {
      const handle = `p${handles.paths.length}`;
      handles.paths.push(handle);
      const el = { kind: "polygon", id: `$h:${handle}` };
      const anchors = p.anchors.map((a) => shift(a, left, top));
      ops.push(
        { op: "insertPath", args: { pageId, anchors, open: p.open === true } },
        { op: "bindCreated", args: { handle } },
      );
      if (p.subpaths && p.subpaths.length > 1) {
        // The full geometry: every subpath, in the path's own (inner) space —
        // the space the first subpath was inserted in.
        const all = p.subpaths.flat().map((a) => shift(a, left, top));
        const starts: number[] = [];
        let n = 0;
        for (const sp of p.subpaths) {
          starts.push(n);
          n += sp.length;
        }
        ops.push(setProp(el, "framePath", { type: "framePath", value: { anchors: all, subpathStarts: starts } }));
      }
      ops.push(...shapeStyleOps(el, p));
    }
    plan.images.forEach((img, i) => {
      const png = imageBytes?.[i];
      if (!png) return;
      const handle = `i${handles.images.length}`;
      handles.images.push(handle);
      const [it, il, ib, ir] = img.bounds;
      ops.push(
        { op: "insertFrame", args: { pageId, bounds: [it + top, il + left, ib + top, ir + left] } },
        { op: "bindCreated", args: { handle } },
        // The pixels inline: a rectangle with image bytes and no content
        // transform draws them fitted to its bounds.
        { op: "replaceImageBytes", args: { elementId: `$h:${handle}`, bytes: Array.from(png) } } as MutationInput,
      );
    });
    plan.texts.forEach((t, i) => {
      const m = metrics[i];
      if (!m) return;
      const handle = `t${handles.texts.length}`;
      handles.texts.push(handle);
      const pageLeft = t.left + left;
      const pageBaseline = t.baseline + top;
      // The frame holds the run as the engine shaped it (its own face) or as
      // the host measures it, whichever is wider.
      const width = Math.max(m.advance, t.advance ?? 0);
      const bounds: [number, number, number, number] = [
        pageBaseline - m.ascender,
        pageLeft,
        pageBaseline - m.descender,
        pageLeft + Math.max(1, width) + TEXT_PAD_PT,
      ];
      const range = storyRangeOf(handle, charCount(t.text));
      ops.push(
        { op: "insertTextFrame", args: { pageId, bounds } },
        { op: "bindCreated", args: { handle } },
        { op: "insertText", args: { storyId: `$h:${handle}`, offset: 0, text: t.text } },
        setProp(range, "characterFontSize", { type: "length", value: t.sizePt }),
        setProp(range, "characterFillColor", { type: "colorRef", value: t.fillColorId }),
      );
      if (t.family) {
        // The family always (a foreign open must not fall back to its own
        // default face); the style only when it is not the family's regular
        // face, which is what a run without a style gets.
        ops.push(setProp(range, "characterFontFamily", { type: "text", value: t.family }));
        if (t.fontStyle && t.fontStyle !== "Regular") {
          ops.push(setProp(range, "characterFontStyle", { type: "text", value: t.fontStyle }));
        }
      }
      if (t.opacity !== undefined) {
        ops.push(setProp({ kind: "textFrame", id: `$h:${handle}` }, "frameOpacity", { type: "length", value: t.opacity }));
      }
    });
  }

  return { ops, swatchIds, gradientIds, handles };
}
