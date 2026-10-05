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

// The auto renderer's discovery and its bounds, on a modelled host: on an
// engine that reports plugin labels on scene-tree rows a pass costs one tree
// read and one geometry read (no per-frame metadata read); an unchanged
// document renders nothing; a layer nobody keeps is cleared; without an
// engine nothing is cleared.

import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, envelopeFor } from "@paged-media/web-model";

import { startAutoRender } from "../src/auto-render";
import { framesWithLayers } from "../src/bake";
import type { WebEngine } from "../src/engine-loader";

const KEY = "x-paged:media.paged.web";
const label = (html: string) => JSON.stringify(envelopeFor({ ...DEFAULT_SOURCE, html }));

function modelHost(rows: { id: string; label?: string }[]) {
  const calls: Record<string, number> = {};
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const submits: string[] = [];
  const clears: string[] = [];
  const labels = new Map(rows.filter((r) => r.label).map((r) => [r.id, r.label!]));
  const host = {
    supports: (f: string) => f === "rendering.sceneLayer@1",
    contribute: {
      sceneLayer: () => ({
        submit: async (id: string) => void submits.push(id),
        clear: async (id: string) => void clears.push(id),
        dispose() {},
      }),
    },
    document: {
      tree: async () => {
        count("tree");
        return [
          {
            id: null,
            kind: "Spread",
            label: "s",
            children: rows.map((r) => ({
              id: { kind: "rectangle", id: r.id },
              kind: "Rectangle",
              label: r.id,
              children: [],
              pluginMetadata: labels.has(r.id) ? [{ key: KEY, value: labels.get(r.id)! }] : [],
            })),
          },
        ];
      },
      getMetadata: async (id: ElementId) => {
        count("getMetadata");
        const l = labels.get((id as { id: string }).id);
        return l ? JSON.parse(l) : null;
      },
      elementGeometry: async (ids: ElementId[]) => {
        count("elementGeometry");
        return ids.map((id) => ({ id, bounds: [0, 0, 100, 200] }));
      },
      mutate: async () => ({ applied: true }),
      onDidChange: () => ({ dispose() {} }),
    },
    parts: { read: async () => null },
    editor: { client: { subscribe: () => () => {} } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as BundleHost;
  return { host, calls, submits, clears, labels };
}

const engine: WebEngine = {
  render: () => ({ items: [] }),
  renderFlow: () => ({ frames: [], overset: false }),
};

describe("auto render — discovery and bounds", () => {
  it("one tree read per pass and no discovery reads when the tree carries labels", async () => {
    const m = modelHost([{ id: "a", label: label("<p>A</p>") }, { id: "b" }, { id: "c", label: '{"v":1,"data":{}}' }]);
    const auto = startAutoRender(m.host, { engine: async () => engine, debounceMs: 1 });
    await auto.idle();
    expect(m.calls.tree).toBe(1);
    // One for the pass, one inside the render of "a".
    expect(m.calls.elementGeometry).toBe(2);
    // No discovery reads: the two are "a"'s source (parsed once per label)
    // and the render's own read.
    expect(m.calls.getMetadata).toBe(2);
    expect(m.submits).toEqual(["a"]);
    expect([...auto.labels().keys()]).toEqual(["a"]);
    auto.dispose();
  });

  it("an unchanged document renders nothing on the next pass", async () => {
    const m = modelHost([{ id: "a", label: label("<p>A</p>") }]);
    const auto = startAutoRender(m.host, { engine: async () => engine, debounceMs: 1 });
    await auto.idle();
    await auto.reconcile("change");
    expect(m.submits).toEqual(["a"]);
    // Nothing re-read: a label names one source, and nothing re-rendered.
    expect(m.calls.getMetadata).toBe(2);
    auto.dispose();
  });

  it("a frame holding a layer nobody keeps is cleared", async () => {
    const m = modelHost([{ id: "a", label: label("<p>A</p>") }]);
    const auto = startAutoRender(m.host, { engine: async () => engine, debounceMs: 1 });
    await auto.idle();
    framesWithLayers(m.host).add("stale");
    await auto.reconcile("change");
    expect(m.clears).toEqual(["stale"]);
    auto.dispose();
  });

  it("without an engine nothing is rendered or cleared", async () => {
    const m = modelHost([{ id: "a", label: label("<p>A</p>") }]);
    const auto = startAutoRender(m.host, { engine: async () => null, debounceMs: 1 });
    await auto.idle();
    framesWithLayers(m.host).add("stale");
    await auto.reconcile("change");
    expect(m.submits).toEqual([]);
    expect(m.clears).toEqual([]);
    auto.dispose();
  });

  it("an engine without labels on tree rows falls back to one metadata read per page item", async () => {
    const m = modelHost([{ id: "a", label: label("<p>A</p>") }, { id: "b" }]);
    const tree = m.host.document.tree;
    (m.host.document as { tree: unknown }).tree = async () =>
      JSON.parse(JSON.stringify(await tree(), (k, v) => (k === "pluginMetadata" ? undefined : v)));
    const auto = startAutoRender(m.host, { engine: async () => engine, debounceMs: 1 });
    await auto.idle();
    expect(m.submits).toEqual(["a"]);
    expect(m.calls.getMetadata).toBe(4); // a, b (discovery) + a (source) + a (render)
    auto.dispose();
  });
});
