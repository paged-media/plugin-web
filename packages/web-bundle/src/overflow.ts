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

// Overflow policies for ONE frame — what happens to content taller than the
// frame it renders into:
//
//   · clip    one layout at the frame's size; what does not fit is cut.
//   · shrink  lay the content out in a larger box (W/s × H/s, as browser
//             zoom does) and scale the painted layer by s, the largest s
//             at which everything fits.
//   · grow    find the content's height at the frame's width; the caller
//             resizes the frame to it (one `resizeFrame`, one undo step).
//   · thread  the flow chain carries the rest (render-flow-command.ts);
//             for a frame with no recipients this is clip plus a warning.
//
// "Fits" is measured from the paint: the content's bottom is the lowest
// painted item of a layout in a very tall viewport (an invisible item, or
// one that fills the whole viewport — the canvas background — is not
// content). The engine's flow `overset` is correct for a flow chain (it once
// counted that background; conformance/overflow.spec.ts keeps the case), but
// it answers only "fits or not". The engine has no content-height export, so
// shrink searches (about ten layouts) and grow and thread measure once.

import { scaleSceneLayer, type OverflowPolicy, type SceneLayer } from "../../web-model/src";

import type { WebEngine } from "./engine-loader";

/** The outcome of rendering one frame under a policy. */
export interface FitRender {
  layer: SceneLayer;
  /** The scale applied to the painted layer (1 unless shrink scaled it). */
  scale: number;
  /** grow: the content's height in CSS px at the frame's width. */
  contentHeightPx: number | null;
  /** Content remains past the frame (clip is not measured: `null`). */
  overset: boolean | null;
}

/** Smallest scale shrink goes to; content that does not fit at it is
 *  painted at it and reported as overset. */
const MIN_SCALE = 0.05;
/** Largest height grow sets, in CSS px (the measuring viewport). */
const MAX_GROW_PX = 16384;
/** Binary-search rounds for shrink (2^-9 ≈ 0.2 % scale resolution). */
const SHRINK_ROUNDS = 9;

/** The viewport height (CSS px) content is measured in. */
const MEASURE_PX = MAX_GROW_PX;
const PT_PER_PX = 72 / 96;

type Bounds = { top: number; bottom: number } | null;

function itemBounds(item: Record<string, unknown>): Bounds {
  const ys: number[] = [];
  const collect = (path: unknown) => {
    if (!Array.isArray(path)) return;
    for (const seg of path as Record<string, unknown>[]) {
      for (const k of ["y", "cy1", "cy2"]) if (typeof seg[k] === "number") ys.push(seg[k] as number);
    }
  };
  if (item.kind === "text") {
    const y = item.y as number;
    const size = (item.size as number) ?? 0;
    return { top: y - size, bottom: y + size * 0.3 };
  }
  if (item.kind === "image") {
    return { top: item.y as number, bottom: (item.y as number) + (item.h as number) };
  }
  collect(item.path);
  if (ys.length === 0) return null;
  let top = Math.min(...ys);
  let bottom = Math.max(...ys);
  if (typeof item.offset_y === "number") {
    const blur = typeof item.blur_radius === "number" ? item.blur_radius : 0;
    top += Math.min(0, item.offset_y) - blur;
    bottom += Math.max(0, item.offset_y) + blur;
  }
  if (typeof item.width === "number" && item.kind !== "image") bottom += item.width / 2;
  return { top, bottom };
}

/** The lowest painted point of a layer (points), ignoring invisible items
 *  and items that fill the whole measuring viewport. */
export function contentBottomPt(layer: SceneLayer, viewportPt: number): number {
  let bottom = 0;
  for (const raw of layer.items) {
    const item = raw as unknown as Record<string, unknown>;
    const paint = item.paint as { a?: number } | undefined;
    if (paint && paint.a === 0) continue;
    const b = itemBounds(item);
    if (!b) continue;
    if (b.top <= 0.5 && b.bottom >= viewportPt - 0.5) continue;
    bottom = Math.max(bottom, b.bottom);
  }
  return bottom;
}

/** The content's height in CSS px at `widthPx`, or `null` when the engine
 *  threw. */
function measure(engine: WebEngine, html: string, widthPx: number): number | null {
  const layer = engine.render(html, widthPx, MEASURE_PX);
  if (layer === null) return null;
  return contentBottomPt(layer, MEASURE_PX * PT_PER_PX) / PT_PER_PX;
}

/** Whether the content fits a box, or `null` when the engine threw. */
function fits(engine: WebEngine, html: string, widthPx: number, heightPx: number): boolean | null {
  const h = measure(engine, html, widthPx);
  return h === null ? null : h <= heightPx + 0.5;
}

/** Render `html` into a frame of `widthPx × heightPx` under `policy`, or
 *  `null` when the engine threw. */
export function renderWithPolicy(
  engine: WebEngine,
  html: string,
  widthPx: number,
  heightPx: number,
  policy: OverflowPolicy,
): FitRender | null {
  if (policy === "shrink") return shrink(engine, html, widthPx, heightPx);
  if (policy === "grow") return grow(engine, html, widthPx);
  const layer = engine.render(html, widthPx, heightPx);
  if (layer === null) return null;
  if (policy === "thread") {
    const ok = fits(engine, html, widthPx, heightPx);
    return { layer, scale: 1, contentHeightPx: null, overset: ok === null ? null : !ok };
  }
  return { layer, scale: 1, contentHeightPx: null, overset: null };
}

function shrink(engine: WebEngine, html: string, w: number, h: number): FitRender | null {
  const atFull = fits(engine, html, w, h);
  if (atFull === null) return null;
  let scale = 1;
  let overset = false;
  if (!atFull && w > 0 && h > 0) {
    let lo = MIN_SCALE;
    let hi = 1;
    const atMin = fits(engine, html, Math.round(w / lo), Math.round(h / lo));
    if (atMin === null) return null;
    if (!atMin) {
      overset = true;
    } else {
      for (let i = 0; i < SHRINK_ROUNDS; i++) {
        const mid = (lo + hi) / 2;
        const ok = fits(engine, html, Math.round(w / mid), Math.round(h / mid));
        if (ok === null) return null;
        if (ok) lo = mid;
        else hi = mid;
      }
    }
    scale = lo;
  }
  const layer = engine.render(html, Math.round(w / scale), Math.round(h / scale));
  if (layer === null) return null;
  return { layer: scaleSceneLayer(layer, scale), scale, contentHeightPx: null, overset };
}

function grow(engine: WebEngine, html: string, w: number): FitRender | null {
  const measured = measure(engine, html, w);
  if (measured === null) return null;
  const overset = measured > MAX_GROW_PX;
  const height = Math.max(1, Math.min(MAX_GROW_PX, Math.ceil(measured)));
  const layer = engine.render(html, w, height);
  if (layer === null) return null;
  return { layer, scale: 1, contentHeightPx: height, overset };
}
