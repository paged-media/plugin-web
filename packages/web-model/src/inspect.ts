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

// The INSPECTED render's maps (web-render `inspect.rs`), and the pure
// questions in-frame editing and the outline highlight ask of them: which
// text node and offset a point falls on, where a caret at a node offset is
// drawn, which painted boxes an outline tag owns. All coordinates are
// frame-content points, the scene layer's space.

import type { SceneLayer } from "./render";
import type { TagOutlineEntry } from "./outline";

/** A cluster: `[x, width, node ordinal (-1 = none), UTF-16 offset in the
 *  node, UTF-16 length]`. */
export type InspectCluster = [number, number, number, number, number];

export interface InspectLine {
  top: number;
  bottom: number;
  baseline: number;
  c: InspectCluster[];
}

export interface InspectTextMap {
  nodes: { n: number; text: string }[];
  lines: InspectLine[];
}

export interface InspectBox {
  tag: string;
  /** Occurrence among the elements of `tag`, document order. */
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InspectedRender {
  layer: SceneLayer;
  text: InspectTextMap;
  boxes: InspectBox[];
}

/** Parse the engine's inspect JSON defensively: anything malformed reads
 *  as an empty render, never a throw. */
export function parseInspected(json: string): InspectedRender {
  const empty: InspectedRender = { layer: { items: [] }, text: { nodes: [], lines: [] }, boxes: [] };
  try {
    const p = JSON.parse(json) as Partial<InspectedRender> | null;
    if (!p || typeof p !== "object") return empty;
    const layer =
      p.layer && Array.isArray((p.layer as { items?: unknown }).items) ? (p.layer as SceneLayer) : { items: [] };
    const nodes = Array.isArray(p.text?.nodes) ? p.text.nodes : [];
    const lines = Array.isArray(p.text?.lines) ? p.text.lines.filter((l) => Array.isArray(l?.c)) : [];
    const boxes = Array.isArray(p.boxes) ? p.boxes : [];
    return { layer, text: { nodes, lines }, boxes };
  } catch {
    return empty;
  }
}

/** A position in a DOM text node. */
export interface TextPosition {
  node: number;
  offset: number;
}

/**
 * The text position under a frame-content point: the line whose band holds
 * `y` (else the nearest line), then the cluster under `x` — left half before
 * the character, right half after it. Clusters of no node (generated
 * content, list markers) are skipped. `null` when the frame has no text.
 */
export function hitText(map: InspectTextMap, x: number, y: number): TextPosition | null {
  let best: InspectLine | null = null;
  let bestD = Infinity;
  for (const line of map.lines) {
    if (!line.c.some((c) => c[2] >= 0)) continue;
    const d = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0;
    if (d < bestD) {
      bestD = d;
      best = line;
    }
  }
  if (!best) return null;
  const clusters = best.c.filter((c) => c[2] >= 0);
  let pick = clusters[0];
  let pickD = Infinity;
  for (const c of clusters) {
    const d = x < c[0] ? c[0] - x : x > c[0] + c[1] ? x - (c[0] + c[1]) : 0;
    if (d < pickD) {
      pickD = d;
      pick = c;
    }
  }
  const after = x > pick[0] + pick[1] / 2;
  return { node: pick[2], offset: after ? pick[3] + pick[4] : pick[3] };
}

/** Where a caret at `pos` is drawn: `x` and the line's band. Prefers the
 *  cluster that STARTS at the offset; else the one that ends there; else the
 *  nearest cluster of the node. `null` when the node is not painted. */
export function caretAt(
  map: InspectTextMap,
  pos: TextPosition,
): { x: number; top: number; bottom: number } | null {
  let ends: { x: number; top: number; bottom: number } | null = null;
  let nearest: { x: number; top: number; bottom: number; d: number } | null = null;
  for (const line of map.lines) {
    for (const c of line.c) {
      if (c[2] !== pos.node || c[4] === 0) continue;
      if (c[3] === pos.offset) return { x: c[0], top: line.top, bottom: line.bottom };
      if (c[3] + c[4] === pos.offset && !ends) ends = { x: c[0] + c[1], top: line.top, bottom: line.bottom };
      const d = Math.min(Math.abs(c[3] - pos.offset), Math.abs(c[3] + c[4] - pos.offset));
      if (!nearest || d < nearest.d) {
        const right = pos.offset >= c[3] + c[4];
        nearest = { x: right ? c[0] + c[1] : c[0], top: line.top, bottom: line.bottom, d };
      }
    }
  }
  if (ends) return ends;
  return nearest ? { x: nearest.x, top: nearest.top, bottom: nearest.bottom } : null;
}

/** The painted boxes of an outline entry: the box of the same tag at the
 *  same occurrence, counted over `outline` in source order. */
export function boxesForOutline(
  boxes: readonly InspectBox[],
  outline: readonly TagOutlineEntry[],
  index: number,
): InspectBox[] {
  const entry = outline[index];
  if (!entry) return [];
  let n = 0;
  for (let i = 0; i < index; i += 1) if (outline[i].tag === entry.tag) n += 1;
  return boxes.filter((b) => b.tag === entry.tag && b.n === n && b.w > 0 && b.h > 0);
}

/** The outline entry of the innermost painted box under a point (the box
 *  with the smallest area that contains it; on a tie the later one in
 *  document order, a descendant), or -1. */
export function outlineIndexAt(
  boxes: readonly InspectBox[],
  outline: readonly TagOutlineEntry[],
  x: number,
  y: number,
): number {
  let hit: InspectBox | null = null;
  for (const b of boxes) {
    if (b.w <= 0 || b.h <= 0) continue;
    if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
    if (!hit || b.w * b.h <= hit.w * hit.h) hit = b;
  }
  if (!hit) return -1;
  let n = 0;
  for (let i = 0; i < outline.length; i += 1) {
    if (outline[i].tag !== hit.tag) continue;
    if (n === hit.n) return i;
    n += 1;
  }
  return -1;
}
