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
} from "@paged-media/web-model";

import { bakeWebFrame } from "../src/bake";
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

describe("bakeWebFrame — the engine-LOADED submit path", () => {
  /** An engine that paints one solid fill — a real (non-null) C-1 layer. */
  function solidEngine(): WebEngine {
    return {
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
