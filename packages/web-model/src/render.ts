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

// The web RENDER CONTRACT — the engine-agnostic seam ADR-011 ratifies:
// "HTML/CSS in, scene layer out." The Blitz engine (packages/web-render,
// compiled to the bundle's wasm and loaded by web-bundle's
// engine-loader.ts) answers these types; the functions here are the
// fallback when that engine cannot load:
//   { sceneLayer: null, diagnostics: [<engine not loaded — source-lane
//     preview only>] }
// Per ADR-011 the paint output lowers to the plugin `sceneLayer` rail
// (C-1), NOT a core paint hook — the engine lives entirely in the plugin.
// Do NOT fake a SceneLayer here; an empty/placeholder layer would be the
// exact dishonesty this seam exists to avoid.

import type { WebDiagnostic } from "./diagnose";
import type { TemplateVars } from "./source";
import { ENGINE_PIN, type EnginePin } from "./engine";

/** A solid sRGB paint (0..=1 per channel; alpha linear) — the C-1
 *  `ScenePaint` shape. Local structural twin so web-model stays
 *  dependency-free (the hard rule); the bundle maps it 1:1 onto the
 *  vendored wire `ScenePaint` when it submits. */
export interface ScenePaintRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** One segment of a {@link ScenePathItem} — the C-1 `ScenePathSeg`
 *  shape (frame-content points). Local twin so web-model stays
 *  dependency-free; the bundle maps it 1:1 onto the wire. */
export type ScenePathSeg =
  | { op: "moveTo"; x: number; y: number }
  | { op: "lineTo"; x: number; y: number }
  | {
      op: "cubicTo";
      cx1: number;
      cy1: number;
      cx2: number;
      cy2: number;
      x: number;
      y: number;
    }
  | { op: "close" };

/** A single-line text run in frame-content points — the C-1
 *  `SceneTextItem` shape (newlines are not laid out). The wire tags it
 *  `{ kind: "text" } & SceneTextItem`; the local twin carries the tag
 *  inline so the union discriminates the same way. */
export interface SceneTextItem {
  kind: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  paint: ScenePaintRgba;
  /** The family of the face the run was shaped with. From protocol 68 core
   *  draws the run in it when the host registered the family (else in the
   *  document default font, reported as a font fallback). */
  family?: string;
  /** The face within `family`, IDML `FontStyle` spelling (`"Bold Italic"`);
   *  absent ⇒ derived from `weight` / `italic`. */
  style?: string;
  /** CSS weight 100..900 (protocol 68); absent ⇒ regular (400). */
  weight?: number;
  /** Italic (protocol 68); absent ⇒ upright. */
  italic?: boolean;
}

/** A filled path in frame-content points — the C-1 `fillPath`
 *  `SceneItem` (segment list + solid fill). The bundle maps it onto the
 *  wire `{ kind: "fillPath"; path; paint }` 1:1. */
export interface ScenePathItem {
  kind: "fillPath";
  path: ScenePathSeg[];
  paint: ScenePaintRgba;
}

/** A pre-decoded raster image painted into an axis-aligned box in
 *  frame-content points — the Stage-A C-1 `image` `SceneItem` (canvas-wasm
 *  v0.41+). `rgba` is straight RGBA8 (`width*height*4` bytes); `x,y,w,h`
 *  is the on-page destination box. The web render lane lowers CSS raster
 *  image fills (the `draw_image` path) to this; a rotated/sheared image
 *  dest stays an honest unsupported-paint drop (no per-image transform on
 *  the wire yet). */
export interface SceneImageItem {
  kind: "image";
  rgba: Uint8Array | number[];
  width: number;
  height: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A stroked path — the C-1 `strokePath` item (solid paint, width in
 *  points). */
export interface SceneStrokeItem {
  kind: "strokePath";
  path: ScenePathSeg[];
  paint: ScenePaintRgba;
  width: number;
}

/** One gradient stop (offset 0..1, sRGB 0..1). */
export interface SceneGradientStop {
  offset: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A gradient in frame-content points — the C-1 `SceneGradient`. */
export type SceneGradient =
  | { type: "linear"; x0: number; y0: number; x1: number; y1: number; stops: SceneGradientStop[] }
  | { type: "radial"; cx: number; cy: number; radius: number; stops: SceneGradientStop[] }
  | { type: "sweep"; cx: number; cy: number; start_angle: number; stops: SceneGradientStop[] };

/** A gradient-filled path — the C-1 `fillPathGradient` item. */
export interface SceneGradientItem {
  kind: "fillPathGradient";
  path: ScenePathSeg[];
  gradient: SceneGradient;
}

/** An outer box shadow — the C-1 `dropShadow` item. The wire keeps the
 *  variant's multi-word fields snake_case. */
export interface SceneDropShadowItem {
  kind: "dropShadow";
  path: ScenePathSeg[];
  offset_x: number;
  offset_y: number;
  blur_radius: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** One drawable in a {@link SceneLayer} — the subset of the C-1
 *  `SceneItem` union the web render lane lowers to: filled paths,
 *  (multi-run, transform-correct) single-line text runs, and axis-aligned
 *  raster images. `strokePath` is the remaining wire kind the lane widens
 *  into as C-1's stages mature (ADR-011 Option C). */
export type SceneItem =
  | SceneTextItem
  | ScenePathItem
  | SceneImageItem
  | SceneStrokeItem
  | SceneGradientItem
  | SceneDropShadowItem;

/** A plugin-submitted vector layer in frame-content coordinates — the
 *  C-1 `SceneLayer` IR (the wire.d.ts shape). The bundle lowers this to
 *  the wire `SceneLayer` and submits it via `host.contribute.sceneLayer()`
 *  so core composes it inside the frame under `ItemTransform` +
 *  content-box clip (ADR-011 Option B). */
export interface SceneLayer {
  items: SceneItem[];
}

/**
 * The render request — everything the engine needs to lay out
 * and paint one web frame, and nothing host-specific. `vars` carries the
 * §6.2 deterministic template map (applied BEFORE layout, exactly as the
 * source-lane preview applies it); `dpi` lets the engine rasterize any
 * raster escape hatch at the page's true resolution. Geometry is in
 * POINTS (the document's native unit, frame-content space) so the result
 * needs no host transform — core applies the frame's `ItemTransform`.
 */
export interface WebRenderRequest {
  html: string;
  css: string;
  vars?: TemplateVars;
  /** Frame content-box width in points (the CSS layout viewport). */
  frameWidthPt: number;
  /** Frame content-box height in points. */
  frameHeightPt: number;
  /** Output resolution for any rasterized escape hatch (default 300). */
  dpi?: number;
}

/**
 * The render result — the engine-agnostic output. `sceneLayer` is the
 * C-1 IR when the engine painted, or `null` on the not-loaded path (and
 * when the engine threw). `diagnostics` carries the not-loaded note on
 * that path, and the template and overflow findings otherwise.
 */
export interface WebRenderResult {
  sceneLayer: SceneLayer | null;
  diagnostics: WebDiagnostic[];
}

/** The single, stable diagnostic the not-loaded path emits — kept as a
 *  constant so the bundle + tests assert it exactly. */
export const ENGINE_NOT_LOADED_MESSAGE =
  "web rendering engine not loaded — source-lane preview only (W-01)";

/**
 * Render a web frame to the C-1 scene IR WITHOUT an engine: the honest
 * not-loaded result the bundle falls back to when its Blitz engine wasm
 * cannot load (no artifact, or a realm that cannot fetch it) — no scene
 * layer, plus the not-loaded diagnostic. The loaded engine
 * (web-bundle `engine-loader.ts`) answers the same result type. Pure +
 * total: same request → same result, never throws.
 */
export function renderWebFrame(_request: WebRenderRequest): WebRenderResult {
  return {
    sceneLayer: null,
    diagnostics: [
      {
        severity: "info",
        message: ENGINE_NOT_LOADED_MESSAGE,
        source: "render",
      },
    ],
  };
}

/** Whether a render result carries a real scene layer (the engine
 *  painted). False on the not-loaded path — the bake path branches on
 *  this to keep the honest source-lane preview. */
export function isRendered(result: WebRenderResult): boolean {
  return result.sceneLayer !== null;
}

// ===================================================================
// Threaded FLOW contract (ADR-020 rung 2 — one flow across N frames)
// ===================================================================
// The renderer-neutral flow concept ADR-020 / the engine spec Q#6 name:
// one HTML/CSS source threaded through an ORDERED chain of recipient
// frames, re-line-broken at each frame's width, like an IDML story
// through linked text frames. This is `renderWebFrame` generalised to a
// chain; the engine entry is `render_web_flow` (web-render). Same honesty
// rule — never fake a layer; the not-loaded path returns null per frame.

/** A stable identifier for a threaded web flow — shared in SHAPE with an
 *  IDML story's thread. A flow's SOURCE (the HTML/CSS) lives on its first
 *  frame; content threads through the chain. The id is the source frame's
 *  host element id, so a flow is addressable without a separate registry. */
export type FlowId = string;

/** One recipient frame in a flow's region chain: the host element id, the
 *  chain position (`order`; 0 = the source/first frame), and the frame's
 *  content-box size in POINTS (frame-content space — the bundle converts to
 *  the engine's CSS px, exactly as the single-frame bake path does). */
export interface WebFlowFrame {
  frameId: string;
  order: number;
  frameWidthPt: number;
  frameHeightPt: number;
}

/**
 * The flow render request — one HTML/CSS source threaded through an ordered
 * region chain. `frames` is the chain; it need not be pre-sorted (the lane
 * sorts by `order`). Mirrors {@link WebRenderRequest} but for N frames.
 */
export interface WebRenderFlowRequest {
  flowId: FlowId;
  html: string;
  css: string;
  vars?: TemplateVars;
  frames: WebFlowFrame[];
  dpi?: number;
}

/** One recipient frame's slot in the flow result: the frame id + the C-1
 *  layer to submit for it (`null` on the not-loaded path / a frame the flow
 *  left empty). */
export interface WebFlowFrameResult {
  frameId: string;
  sceneLayer: SceneLayer | null;
}

/**
 * The flow render result — one layer per recipient frame in chain order,
 * plus `overset` (content remained past the LAST frame — the CSS-Regions /
 * IDML-story status the host surfaces) and `diagnostics` (the not-loaded
 * note on that path).
 */
export interface WebRenderFlowResult {
  flowId: FlowId;
  frames: WebFlowFrameResult[];
  overset: boolean;
  diagnostics: WebDiagnostic[];
}

/**
 * Render a threaded web flow WITHOUT an engine: the not-loaded fallback
 * for the flow lane (the loaded engine's `render_web_flow` answers the same
 * type). Every frame's `sceneLayer` is `null`, `overset` is `false`, and the
 * not-loaded diagnostic is attached. Pure + total: same request → same
 * result, never throws, frames returned in chain order.
 */
export function renderWebFlow(request: WebRenderFlowRequest): WebRenderFlowResult {
  return {
    flowId: request.flowId,
    frames: [...request.frames]
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ frameId: f.frameId, sceneLayer: null })),
    overset: false,
    diagnostics: [
      {
        severity: "info",
        message: ENGINE_NOT_LOADED_MESSAGE,
        source: "render",
      },
    ],
  };
}

/** Whether a flow result carries ANY real scene layer (the engine painted
 *  at least one frame). False on the not-loaded path — the flow command
 *  branches on this to keep the honest source-lane preview. */
export function isFlowRendered(result: WebRenderFlowResult): boolean {
  return result.frames.some((f) => f.sceneLayer !== null);
}

export { ENGINE_PIN, type EnginePin };

/** Scene-layer keys that carry frame-content geometry (points). Colours,
 *  gradient-stop offsets, blend modes and an image's PIXEL size are not
 *  geometry and are never in this set. */
const GEOMETRY_KEYS = new Set([
  "x", "y", "w", "h",
  "cx1", "cy1", "cx2", "cy2",
  "x0", "y0", "x1", "y1", "cx", "cy", "radius",
  "size", "offset_x", "offset_y", "blur_radius",
]);

/** Item kinds whose `width` is a stroke width (an `image`'s `width` is its
 *  pixel width and stays). */
const STROKE_KINDS = new Set(["strokePath", "strokePathGradient"]);

function scaleNode(node: unknown, s: number): unknown {
  if (Array.isArray(node)) return node.map((n) => scaleNode(n, s));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const isStroke = STROKE_KINDS.has(obj.kind as string);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "rgba") out[k] = v;
    else if (typeof v === "number" && (GEOMETRY_KEYS.has(k) || (k === "width" && isStroke))) {
      out[k] = v * s;
    } else out[k] = scaleNode(v, s);
  }
  return out;
}

/** Scale a scene layer about the frame-content origin by `factor` — the
 *  shrink-to-fit overflow policy lays the content out in a larger box and
 *  scales the painted result down into the frame. Every geometry field of
 *  every C-1 item kind scales (path points, text origin and size, image
 *  boxes, stroke widths, gradient geometry, shadow offsets and blur);
 *  colours and image pixels do not. Pure; factor 1 returns the layer. */
export function scaleSceneLayer(layer: SceneLayer, factor: number): SceneLayer {
  if (factor === 1) return layer;
  return scaleNode(layer, factor) as SceneLayer;
}
