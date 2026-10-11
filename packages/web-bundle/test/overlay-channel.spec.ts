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

// The bundle's two persistent overlays — the in-frame caret and the
// outline highlight — each draw on a retained overlay layer of their own
// where the host renders layers (`overlay.layers@1`), so one never erases
// the other and neither erases the active tool's preview. A host without
// layers gets the shared tool-preview slot, as before.

import { describe, expect, it } from "vitest";

import type { BundleHost, ToolPreviewShape } from "@paged-media/plugin-api";

import { overlayChannel, releaseOverlayLayers } from "../src/overlay-channel";

const shape = (y: number): ToolPreviewShape => ({ pageId: "p1", points: [[0, y], [10, y]] }) as ToolPreviewShape;

function modelHost(layers: boolean) {
  const created: string[] = [];
  const live = new Map<string, readonly ToolPreviewShape[]>();
  const previews: (readonly ToolPreviewShape[] | null)[] = [];
  const host = {
    supports: (f: string) => layers && f === "overlay.layers@1",
    overlay: {
      setToolPreviews: (s: readonly ToolPreviewShape[] | null) => void previews.push(s),
      layer: (id: string) => {
        if (live.has(id)) throw new Error(`layer ${id} is live`);
        created.push(id);
        live.set(id, []);
        return {
          id,
          set: (s: readonly ToolPreviewShape[]) => void live.set(id, s),
          clear: () => void live.set(id, []),
          dispose: () => void live.delete(id),
        };
      },
    },
  } as unknown as BundleHost;
  return { host, created, live, previews };
}

describe("overlay channels", () => {
  it("each channel draws on its own layer and clears only itself", () => {
    const m = modelHost(true);
    const caret = overlayChannel(m.host, "caret");
    const outline = overlayChannel(m.host, "outline");
    outline([shape(1), shape(2)]);
    caret([shape(3)]);
    expect(m.live.get("outline")).toHaveLength(2);
    expect(m.live.get("caret")).toHaveLength(1);
    caret(null);
    expect(m.live.get("caret")).toEqual([]);
    expect(m.live.get("outline")).toHaveLength(2);
    outline(null);
    expect(m.live.get("outline")).toEqual([]);
    expect(m.previews).toEqual([]); // the tool-preview slot is never touched
  });

  it("the layers stack in a fixed order — the caret above the outline — whichever draws first", () => {
    const m = modelHost(true);
    overlayChannel(m.host, "caret")([shape(1)]);
    overlayChannel(m.host, "outline")([shape(2)]);
    expect(m.created).toEqual(["outline", "caret"]);
  });

  it("a layer is created once per activation and released with it", () => {
    const m = modelHost(true);
    overlayChannel(m.host, "caret")([shape(1)]);
    overlayChannel(m.host, "caret")([shape(2)]);
    expect(m.created).toEqual(["outline", "caret"]);
    releaseOverlayLayers(m.host);
    expect(m.live.size).toBe(0);
    // A new activation on the same host makes fresh layers (no duplicate id).
    overlayChannel(m.host, "caret")([shape(3)]);
    expect(m.live.get("caret")).toHaveLength(1);
  });

  it("without overlay.layers@1 both share the tool-preview slot, as before", () => {
    const m = modelHost(false);
    overlayChannel(m.host, "caret")([shape(1)]);
    overlayChannel(m.host, "outline")([]);
    expect(m.created).toEqual([]);
    expect(m.previews).toEqual([[shape(1)], null]);
  });

  it("a host with no overlay grant never throws", () => {
    const host = {
      supports: () => false,
      overlay: {
        setToolPreviews: () => {
          throw new Error("rendering must include overlay");
        },
      },
    } as unknown as BundleHost;
    expect(() => overlayChannel(host, "caret")([shape(1)])).not.toThrow();
  });
});
