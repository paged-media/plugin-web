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

// OVERLAY CHANNELS — where the bundle's two persistent overlays draw: the
// in-frame caret (in-frame-edit.ts) and the outline highlight
// (outline-highlight.ts).
//
// Where the host renders retained overlay layers (`overlay.layers@1`) each
// channel is a layer of its own, so drawing or clearing one never touches
// the other or the active tool's preview. The layers are made together on
// first use, in a fixed order (the caret above the outline), and released
// when the bundle deactivates. A host without layers gets the shared
// tool-preview slot (`overlay.setToolPreviews`) — there the two still
// share one slot, the behaviour before layers existed.

import type { BundleHost, OverlayLayer, ToolPreviewShape } from "@paged-media/plugin-api";

/** The channels, bottom-most first. */
const CHANNELS = ["outline", "caret"] as const;
export type OverlayChannelId = (typeof CHANNELS)[number];

/** Shapes for a channel; `null` or `[]` clears it. */
export type OverlayShapes = readonly ToolPreviewShape[] | null;

const layersByHost = new WeakMap<BundleHost, Map<string, OverlayLayer>>();

function layersOf(host: BundleHost): Map<string, OverlayLayer> | null {
  const existing = layersByHost.get(host);
  if (existing) return existing;
  // An older host has no `layer` door at all; a newer one without a layer
  // sink answers false.
  if (typeof host.overlay?.layer !== "function" || !host.supports("overlay.layers@1")) return null;
  const made = new Map<string, OverlayLayer>();
  for (const id of CHANNELS) made.set(id, host.overlay.layer(id));
  layersByHost.set(host, made);
  return made;
}

/** A setter for channel `id` of `host`. Never throws: without an overlay
 *  grant the shapes are dropped and the caller works without them. */
export function overlayChannel(host: BundleHost, id: OverlayChannelId): (shapes: OverlayShapes) => void {
  return (shapes) => {
    const drawn = shapes && shapes.length > 0 ? shapes : null;
    try {
      const layer = layersOf(host)?.get(id);
      if (layer) {
        if (drawn) layer.set(drawn);
        else layer.clear();
        return;
      }
      host.overlay.setToolPreviews(drawn);
    } catch {
      // no overlay channel granted
    }
  };
}

/** Dispose this host's layers (bundle deactivation); a later activation
 *  on the same host makes new ones. */
export function releaseOverlayLayers(host: BundleHost): void {
  const layers = layersByHost.get(host);
  layersByHost.delete(host);
  for (const l of layers?.values() ?? []) l.dispose();
}
