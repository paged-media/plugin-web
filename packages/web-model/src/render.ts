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
// "HTML/CSS in, scene layer out." This is the drop-in point for the
// Blitz/WASM rendering lane (base-idea §4; the W0 spike proved the
// Blitz/Stylo/Taffy/Parley stack compiles to wasm32 — ~2.2 MB brotli —
// and paints in core's exact vello/wgpu versions). It is NOT that lane:
// compiling Blitz to wasm is a multi-week fork, and this module never
// pretends to do it.
//
// ===================== LOUD SEAM — READ THIS =====================
// `renderWebFrame` today returns the HONEST not-loaded path:
//   { sceneLayer: null, diagnostics: [<engine not loaded — source-lane
//     preview only (W-01)>] }
// When the Blitz engine artifact (manifest `capabilities.wasm` ∋
// `blitz`, purpose:"engine") is built and loaded, the lane fills in a
// real SceneLayer (C-1 IR: filled paths + multi-run, transform-correct
// text + axis-aligned raster images), lowered from Blitz's display list.
// The CONTRACT shape never changes: the bundle's bake path (web-bundle) and
// the determinism envelope are written against THIS seam, so the engine
// drops in behind it without touching the caller. Per ADR-011 the paint
// output lowers to the plugin `sceneLayer` rail (C-1), NOT a core paint
// hook — the engine lives entirely in the plugin, behind the boundary.
// Do NOT fake a SceneLayer here; an empty/placeholder layer would be the
// exact dishonesty this seam exists to avoid.
// =================================================================

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
  family?: string;
  style?: string;
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

/** One drawable in a {@link SceneLayer} — the subset of the C-1
 *  `SceneItem` union the web render lane lowers to: filled paths,
 *  (multi-run, transform-correct) single-line text runs, and axis-aligned
 *  raster images. `strokePath` is the remaining wire kind the lane widens
 *  into as C-1's stages mature (ADR-011 Option C). */
export type SceneItem = SceneTextItem | ScenePathItem | SceneImageItem;

/** A plugin-submitted vector layer in frame-content coordinates — the
 *  C-1 `SceneLayer` IR (the wire.d.ts shape). The bundle lowers this to
 *  the wire `SceneLayer` and submits it via `host.contribute.sceneLayer()`
 *  so core composes it inside the frame under `ItemTransform` +
 *  content-box clip (ADR-011 Option B). */
export interface SceneLayer {
  items: SceneItem[];
}

/**
 * The render request — everything the (future) engine needs to lay out
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
 * on a future hard engine failure). `diagnostics` always carries at
 * least the not-loaded note today; the engine lane adds layout/paint
 * findings (unsupported-property warnings from the pinned compatibility
 * table — base-idea §9) alongside.
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
 * Render a web frame to the C-1 scene IR. **The drop-in seam for the
 * Blitz lane.** Today it is the HONEST not-loaded path: no engine wasm
 * is bundled (the `blitz` artifact is declared in the manifest but not
 * yet built — a multi-week Blitz/Stylo→wasm fork), so it returns no
 * scene layer and the not-loaded diagnostic. Pure + total: same request
 * → same result, never throws. When the engine lands it fills
 * `sceneLayer` and the caller (the bake path) is unchanged.
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

export { ENGINE_PIN, type EnginePin };
