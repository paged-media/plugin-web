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

// W-01 — the BAKE PATH (render contract → C-1 sceneLayer rail). The
// HONEST not-loaded slice: `bakeWebFrame` reads the selected web frame's
// source + geometry, calls the render contract, and — because no Blitz
// engine is loaded — surfaces the not-loaded diagnostic WITHOUT
// submitting any scene layer. These specs pin the honest behavior:
//   · a web frame: rendered:false, submitted:false, the not-loaded note,
//     and NO `contribute.sceneLayer` touch (no fake render);
//   · a non-web-frame / no source: a guiding diagnostic, never a throw;
//   · the render command publishes the diagnostic + never crashes.

import { describe, expect, it, vi } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  DEFAULT_SOURCE,
  ENGINE_NOT_LOADED_MESSAGE,
  envelopeFor,
  withRecipient,
  type WebFrameSource,
} from "@paged-media/web-model";

import { bakeWebFlow, bakeWebFlows, bakeWebFrame } from "../src/bake";
import type { WebEngine } from "../src/engine-loader";
import { renderSelectedWebFrame } from "../src/render-command";

const WEB_ID: ElementId = { kind: "rectangle", id: "uWEB1" } as ElementId;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A host whose document returns `meta` for getMetadata and a fixed
 *  geometry. `sceneLayer` is a spy so we can assert it is NEVER called on
 *  the not-loaded path. */
function makeHost(opts: { metadata: unknown; supportsSceneLayer?: boolean }): {
  host: BundleHost;
  sceneLayer: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  diags: Array<{ key: string; items: unknown }>;
} {
  const submit = vi.fn(async () => {});
  const dispose = vi.fn();
  const sceneLayer = vi.fn(() => ({ submit, clear: async () => {}, dispose }));
  const diags: Array<{ key: string; items: unknown }> = [];
  const host = {
    log: silent,
    selection: { get: () => [WEB_ID] },
    document: {
      getMetadata: async () => opts.metadata,
      elementGeometry: async () => [
        { id: WEB_ID, pageId: "p1", bounds: [60, 60, 240, 300] },
      ],
    },
    diagnostics: {
      set: (key: string, items: unknown) => diags.push({ key, items }),
    },
    contribute: { sceneLayer },
    supports: (f: string) =>
      f === "rendering.sceneLayer@1" ? !!opts.supportsSceneLayer : false,
  } as unknown as BundleHost;
  return { host, sceneLayer, submit, diags };
}

describe("bakeWebFrame — the not-loaded path (W-01)", () => {
  it("a web frame: rendered:false, submitted:false, the honest note", async () => {
    const { host } = makeHost({
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: true,
    });
    const out = await bakeWebFrame(host, WEB_ID);
    expect(out.rendered).toBe(false);
    expect(out.submitted).toBe(false);
    expect(out.sceneLayer).toBeNull();
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0].message).toBe(ENGINE_NOT_LOADED_MESSAGE);
  });

  it("NEVER touches contribute.sceneLayer on the not-loaded path (no fake render)", async () => {
    const { host, sceneLayer, submit } = makeHost({
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: true,
    });
    await bakeWebFrame(host, WEB_ID);
    expect(sceneLayer).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("a non-web-frame selection: a guiding diagnostic, never a throw", async () => {
    const { host } = makeHost({ metadata: null });
    const out = await bakeWebFrame(host, WEB_ID);
    expect(out.rendered).toBe(false);
    expect(out.diagnostics[0].message).toContain("not a web frame");
  });

  it("a structured (non-string-id) element id: reports, never throws", async () => {
    const { host } = makeHost({ metadata: envelopeFor(DEFAULT_SOURCE) });
    const structured = {
      kind: "storyRange",
      id: { storyId: "s", start: 0 },
    } as unknown as ElementId;
    const out = await bakeWebFrame(host, structured);
    expect(out.rendered).toBe(false);
    expect(out.diagnostics[0].message).toContain("single web frame");
  });
});

// ADR-020 rung 2 — bakeWebFlow: one source threaded across a chain of
// frames, one C-1 SceneLayer submitted per frame. Same honesty rule.
describe("bakeWebFlow — the threaded-flow bake (ADR-020 rung 2)", () => {
  const CHAIN: ElementId[] = [
    { kind: "rectangle", id: "uF0" } as ElementId,
    { kind: "rectangle", id: "uF1" } as ElementId,
    { kind: "rectangle", id: "uF2" } as ElementId,
  ];

  /** A multi-frame host: `getMetadata` returns `metadata` (the source
   *  frame's), `elementGeometry` returns a box per requested id. */
  function makeFlowHost(
    chain: ElementId[],
    opts: { metadata: unknown; supportsSceneLayer?: boolean },
  ) {
    const submit = vi.fn(async (_id: string, _layer: unknown) => {});
    const sceneLayer = vi.fn(() => ({
      submit,
      clear: async () => {},
      dispose: vi.fn(),
    }));
    const host = {
      log: silent,
      selection: { get: () => chain },
      document: {
        getMetadata: async () => opts.metadata,
        elementGeometry: async (ids: ElementId[]) =>
          ids.map((id, i) => ({
            id,
            pageId: "p1",
            // vary height per frame so the chain is genuinely variable
            bounds: [0, 0, 180 + i * 40, 240],
          })),
      },
      diagnostics: { set: () => {} },
      contribute: { sceneLayer },
      supports: (f: string) =>
        f === "rendering.sceneLayer@1" ? !!opts.supportsSceneLayer : false,
    } as unknown as BundleHost;
    return { host, sceneLayer, submit };
  }

  /** An engine that paints one solid fill per frame + reports overset. */
  function flowEngine(): WebEngine {
    return {
      render: () => null,
      renderFlow: (_html, frames) => ({
        frames: frames.map(() => ({
          items: [
            {
              kind: "fillPath",
              path: [
                { op: "moveTo", x: 0, y: 0 },
                { op: "lineTo", x: 10, y: 0 },
                { op: "close" },
              ],
              paint: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        })),
        overset: true,
      }),
    };
  }

  it("not-loaded (no engine): rendered:false, submits nothing, honest note", async () => {
    const { host, sceneLayer, submit } = makeFlowHost(CHAIN, {
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: true,
    });
    const out = await bakeWebFlow(host, CHAIN);
    expect(out.rendered).toBe(false);
    expect(out.submittedCount).toBe(0);
    expect(out.layers).toEqual([null, null, null]);
    expect(out.diagnostics[0].message).toBe(ENGINE_NOT_LOADED_MESSAGE);
    expect(sceneLayer).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("a short chain (<2 frames): a guiding diagnostic, never a throw", async () => {
    const { host } = makeFlowHost([CHAIN[0]], {
      metadata: envelopeFor(DEFAULT_SOURCE),
    });
    const out = await bakeWebFlow(host, [CHAIN[0]]);
    expect(out.rendered).toBe(false);
    expect(out.diagnostics[0].message).toContain("target frames");
  });

  it("a non-web-frame source: reports, never throws", async () => {
    const { host } = makeFlowHost(CHAIN, { metadata: null });
    const out = await bakeWebFlow(host, CHAIN);
    expect(out.rendered).toBe(false);
    expect(out.diagnostics[0].message).toContain("not a web frame");
  });

  it("loaded engine: submits ONE layer per frame, by frame id, overset propagated", async () => {
    const { host, submit } = makeFlowHost(CHAIN, {
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: true,
    });
    const out = await bakeWebFlow(host, CHAIN, flowEngine());
    expect(out.rendered).toBe(true);
    expect(out.submittedCount).toBe(3);
    expect(out.overset).toBe(true);
    // Overset is surfaced as an honest warning diagnostic.
    expect(
      out.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("overset"),
      ),
    ).toBe(true);
    expect(out.layers.every((l) => l !== null)).toBe(true);
    // Each frame's layer submitted under its STRING id, in chain order.
    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls.map((c) => c[0])).toEqual(["uF0", "uF1", "uF2"]);
  });

  it("loaded engine but no scene channel: rendered:true, submits nothing (honest no-op)", async () => {
    const { host, submit } = makeFlowHost(CHAIN, {
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: false,
    });
    const out = await bakeWebFlow(host, CHAIN, flowEngine());
    expect(out.rendered).toBe(true);
    expect(out.submittedCount).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("bakeWebFlows renders each named flow with its OWN flow-into selector", async () => {
    const S = { kind: "rectangle", id: "S" } as ElementId;
    // #story → the primary ("main") flow; #notes → the "side" flow. F1 is the
    // primary's recipient; F2 is routed to "side".
    const multi: WebFrameSource = {
      html: "<section id=\"story\"><p>x</p></section><aside id=\"notes\"><p>y</p></aside>",
      css: "#story{flow-into:main} #notes{flow-into:side}",
      options: { media: "print", overflow: "clip" },
    };
    const src0 = withRecipient(multi, { kind: "rectangle", id: "S" }, { kind: "rectangle", id: "F1" });
    const src = withRecipient(src0, { kind: "rectangle", id: "S" }, { kind: "rectangle", id: "F2" }, "side");

    // An engine that records (flowRoot, frame count) per group + paints one item/frame.
    const calls: { flowRoot?: string; n: number }[] = [];
    const engine: WebEngine = {
      render: () => null,
      renderFlow: (_html, frames, flowRoot) => {
        calls.push({ flowRoot, n: frames.length });
        return {
          frames: frames.map(() => ({
            items: [
              {
                kind: "fillPath",
                path: [{ op: "moveTo", x: 0, y: 0 }, { op: "close" }],
                paint: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
          })),
          overset: false,
        };
      },
    };

    const submit = vi.fn(async (_id: string, _layer: unknown) => {});
    const host = {
      log: silent,
      selection: { get: () => [S] },
      document: {
        getMetadata: async () => envelopeFor(src),
        elementGeometry: async (ids: ElementId[]) =>
          ids.map((id) => ({ id, pageId: "p1", bounds: [0, 0, 180, 240] })),
      },
      contribute: { sceneLayer: () => ({ submit, clear: async () => {}, dispose: vi.fn() }) },
      supports: (f: string) => f === "rendering.sceneLayer@1",
    } as unknown as BundleHost;

    const out = await bakeWebFlows(host, S, engine);
    expect(out.rendered).toBe(true);
    // Primary group [S, F1] with #story; the "side" group [F2] with #notes.
    expect(calls).toEqual([
      { flowRoot: "#story", n: 2 },
      { flowRoot: "#notes", n: 1 },
    ]);
    // All three frames received a layer, by id.
    expect(out.submittedCount).toBe(3);
    expect(submit.mock.calls.map((c) => c[0])).toEqual(["S", "F1", "F2"]);
  });
});

describe("bakeWebFrame — the engine-LOADED submit path", () => {
  /** An engine that paints one solid fill — a real (non-null) C-1 layer. */
  function solidEngine(): WebEngine {
    return {
      renderFlow: () => null,
      render() {
        return {
          items: [
            {
              kind: "fillPath",
              path: [
                { op: "moveTo", x: 0, y: 0 },
                { op: "lineTo", x: 10, y: 0 },
                { op: "lineTo", x: 10, y: 10 },
                { op: "close" },
              ],
              paint: { r: 1, g: 0, b: 0, a: 1 },
            },
          ],
        } as never;
      },
    };
  }

  it("submits the real layer to the C-1 rail (rendered + submitted)", async () => {
    const { host, sceneLayer, submit } = makeHost({
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: true,
    });
    const out = await bakeWebFrame(host, WEB_ID, solidEngine());
    expect(out.rendered).toBe(true);
    expect(out.submitted).toBe(true);
    expect(out.sceneLayer).not.toBeNull();
    expect(sceneLayer).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(WEB_ID.id, out.sceneLayer);
  });

  it("does NOT dispose the surface after submit (the layer must PERSIST — the 0-pixel defect)", async () => {
    // Regression guard: disposing the surface clears every submitted id
    // (host-impl.ts treats dispose as release → clearSceneLayer), so a bake
    // that disposed right after submit wiped the just-painted layer and the
    // frame rendered blank. The surface is host-persistent + never disposed
    // by a bake, so `dispose` is never called for a one-shot render.
    const dispose = vi.fn();
    const submit = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const sceneLayer = vi.fn(() => ({ submit, clear, dispose }));
    const host = {
      log: silent,
      selection: { get: () => [WEB_ID] },
      document: {
        getMetadata: async () => envelopeFor(DEFAULT_SOURCE),
        elementGeometry: async () => [
          { id: WEB_ID, pageId: "p1", bounds: [60, 60, 240, 300] },
        ],
      },
      diagnostics: { set: () => {} },
      contribute: { sceneLayer },
      supports: (f: string) => f === "rendering.sceneLayer@1",
    } as unknown as BundleHost;

    await bakeWebFrame(host, WEB_ID, solidEngine());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("reuses ONE persistent surface across repeated bakes (host-scoped)", async () => {
    const { host, sceneLayer, submit } = makeHost({
      metadata: envelopeFor(DEFAULT_SOURCE),
      supportsSceneLayer: true,
    });
    const engine = solidEngine();
    await bakeWebFrame(host, WEB_ID, engine);
    await bakeWebFrame(host, WEB_ID, engine);
    // The surface is created once for the host and reused (no churn / no
    // intermediate dispose-clear between renders).
    expect(sceneLayer).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe("renderSelectedWebFrame — the command handler", () => {
  it("publishes the render diagnostic and does not throw", async () => {
    const { host, diags } = makeHost({
      metadata: envelopeFor(DEFAULT_SOURCE),
    });
    await expect(renderSelectedWebFrame(host)).resolves.toBeUndefined();
    expect(diags).toHaveLength(1);
    expect(diags[0].key).toContain("#render");
    expect(diags[0].items).toEqual([
      expect.objectContaining({ message: ENGINE_NOT_LOADED_MESSAGE }),
    ]);
  });

  it("no-ops with a guidance log when the selection isn't a single element", async () => {
    const { host } = makeHost({ metadata: envelopeFor(DEFAULT_SOURCE) });
    (host as unknown as { selection: { get(): ElementId[] } }).selection.get =
      () => [];
    await expect(renderSelectedWebFrame(host)).resolves.toBeUndefined();
  });
});
