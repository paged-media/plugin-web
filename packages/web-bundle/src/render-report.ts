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

// The flow/render READOUT store. The render/flow/bake commands have always
// computed honest outcomes — submitted frame counts, the overset flag, the
// bake's deferred-kind counts, diagnostics — and reported them only to the
// log + Problems lane. This module retains the LAST outcome so the source
// panel can show it (the ADR-020 readout): one bundle-scoped slot, a plain
// subscribe/notify pair, no host involvement.

export type RenderOp = "renderFrame" | "renderFlow" | "bake";

export interface RenderReport {
  op: RenderOp;
  /** Whether the engine produced real output at all. */
  rendered: boolean;
  /** Frames that actually received a layer / native content. */
  submitted: number;
  /** Flow only: content remained past the last frame. Null elsewhere. */
  overset: boolean | null;
  /** Bake only: un-baked SceneItem kinds, counted honestly. */
  deferred: Record<string, number>;
  /** The outcome's diagnostic messages (already user-worded). */
  messages: string[];
  /** Monotonic sequence — lets the panel show "report #n" without
   *  wall-clock state. */
  seq: number;
}

let current: RenderReport | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function publishRenderReport(
  report: Omit<RenderReport, "seq">,
): void {
  current = { ...report, seq: ++seq };
  for (const l of [...listeners]) l();
}

export function lastRenderReport(): RenderReport | null {
  return current;
}

export function subscribeRenderReport(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam — clears the slot + sequence. */
export function resetRenderReport(): void {
  current = null;
  seq = 0;
  listeners.clear();
}

/** `{"text":3,"image":1}` → `"text ×3 · image ×1"` (empty → ""). */
export function formatDeferred(deferred: Record<string, number>): string {
  return Object.entries(deferred)
    .map(([kind, n]) => `${kind} ×${n}`)
    .join(" · ");
}
