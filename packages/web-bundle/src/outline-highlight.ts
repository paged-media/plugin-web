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

// OUTLINE ↔ CANVAS — the source outline's tags and the boxes the engine
// painted for them.
//
//   · panel → canvas: clicking a tag in the outline draws the painted
//     box(es) of that element on the canvas, through the host's overlay
//     channel (`overlay.setToolPreviews`, page-local outlines — the frame's
//     item transform applied, so a rotated frame is outlined correctly);
//   · canvas → panel: inside the frame's edit context a press reports the
//     innermost painted element under it (in-frame-edit.ts), and the panel
//     marks that tag in the outline.
//
// The boxes come from the inspected render (web-render `inspect.rs`), keyed
// by tag and occurrence — the outline's own key. An element the engine
// paints no box for (`display: none`, an implied element) has nothing to
// highlight.

import type { BundleHost, ElementGeometryItem, ElementId } from "@paged-media/plugin-api";
import { boxesForOutline, tagOutline, type InspectBox, type WebFrameSource } from "../../web-model/src";

import { resolveBindings } from "./bindings";
import { engineDocument } from "./engine-document";
import { loadWebEngine, type WebEngine } from "./engine-loader";

const PX_PER_PT = 96 / 72;

/** Frame-content point → page-local point. */
export function contentToPage(g: ElementGeometryItem, x: number, y: number): [number, number] {
  const bx = g.bounds[1] + x;
  const by = g.bounds[0] + y;
  const m = g.itemTransform;
  if (!m) return [bx, by];
  return [m[0] * bx + m[2] * by + m[4], m[1] * bx + m[3] * by + m[5]];
}

/** The page-local outlines of `boxes` in frame `g`. */
export function boxOutlines(g: ElementGeometryItem, boxes: readonly InspectBox[]) {
  if (!g.pageId) return [];
  const pageId = g.pageId;
  return boxes.map((b) => ({
    pageId,
    points: [
      contentToPage(g, b.x, b.y),
      contentToPage(g, b.x + b.w, b.y),
      contentToPage(g, b.x + b.w, b.y + b.h),
      contentToPage(g, b.x, b.y + b.h),
    ] as [number, number][],
    close: true,
  }));
}

function setOverlay(host: BundleHost, shapes: ReturnType<typeof boxOutlines> | null): void {
  try {
    host.overlay.setToolPreviews(shapes && shapes.length > 0 ? shapes : null);
  } catch {
    // no overlay channel granted
  }
}

/**
 * Draw the painted boxes of outline entry `index` of `source` (the frame
 * `id`). Answers how many boxes were drawn (0: the engine is not loaded, or
 * the element painted no box).
 */
export async function highlightOutlineEntry(
  host: BundleHost,
  id: ElementId,
  source: WebFrameSource,
  index: number,
  engineOf: () => Promise<WebEngine | null> = () => loadWebEngine(host),
): Promise<number> {
  const engine = await engineOf();
  if (!engine?.renderInspected) {
    setOverlay(host, null);
    return 0;
  }
  const [g] = await host.document.elementGeometry([id]);
  if (!g?.bounds) return 0;
  const widthPx = Math.round(Math.max(0, g.bounds[3] - g.bounds[1]) * PX_PER_PT);
  const heightPx = Math.round(Math.max(0, g.bounds[2] - g.bounds[0]) * PX_PER_PT);
  const bound = (await resolveBindings(host, id, source)).vars;
  const out = engine.renderInspected(engineDocument(source, bound).html, widthPx, heightPx);
  if (!out) return 0;
  const boxes = boxesForOutline(out.boxes, tagOutline(source.html), index);
  setOverlay(host, boxOutlines(g, boxes));
  return boxes.length;
}

/** Remove an outline highlight. */
export function clearOutlineHighlight(host: BundleHost): void {
  setOverlay(host, null);
}

// ------------------------------------------------- canvas → panel

type PickListener = (frameId: string, outlineIndex: number) => void;
const pickListeners = new WeakMap<BundleHost, Set<PickListener>>();

/** The panel follows presses on the canvas inside the frame's context. */
export function onCanvasPick(host: BundleHost, listener: PickListener): () => void {
  let set = pickListeners.get(host);
  if (!set) {
    set = new Set();
    pickListeners.set(host, set);
  }
  set.add(listener);
  return () => set!.delete(listener);
}

/** Report the outline entry under a press in frame `frameId`. */
export function reportCanvasPick(host: BundleHost, frameId: string, outlineIndex: number): void {
  for (const l of pickListeners.get(host) ?? []) l(frameId, outlineIndex);
}
