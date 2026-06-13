// W-01 — the ENGINE render path (ADR-011 Option B end-to-end). These
// specs prove the bundle LOADS the Blitz/WASM engine, parses its JSON C-1
// SceneLayer, and SUBMITS it via host.contribute.sceneLayer — the
// experimental render affordance turning real. Two lanes:
//
//   1. injected-glue lane — a stub glue returning a CAPTURED real-engine
//      fixture (test/fixtures/engine-scene-layer.json, produced by the
//      actual wasm). Deterministic, no wasm boot: proves parse + bake +
//      submit without depending on the gitignored artifact.
//   2. real-wasm SMOKE lane — when the built artifact is present
//      (bin/blitz_web.js + _bg.wasm), loads the REAL wasm in Node via the
//      wasm-bindgen glue's initSync, renders a fragment, and asserts real
//      C-1 items (rects + a text run with the RECOVERED text). Skipped
//      with a clear note when the artifact isn't built (default gate).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach, vi } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  DEFAULT_SOURCE,
  envelopeFor,
  type SceneLayer,
} from "@paged-media/web-model";

import { bakeWebFrame } from "../src/bake";
import {
  loadWebEngine,
  parseSceneLayer,
  _resetWebEngineCache,
  type WebEngine,
} from "../src/engine-loader";

// The captured real-engine output (a flexbox card + a paragraph): solid
// fills + one text run carrying recovered DOM text.
import engineFixture from "./fixtures/engine-scene-layer.json";

const WEB_ID: ElementId = { kind: "rectangle", id: "uWEB1" } as ElementId;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function makeHost(opts: { supportsSceneLayer?: boolean }): {
  host: BundleHost;
  submit: ReturnType<typeof vi.fn>;
  sceneLayer: ReturnType<typeof vi.fn>;
} {
  const submit = vi.fn(async () => {});
  const dispose = vi.fn();
  const sceneLayer = vi.fn(() => ({ submit, clear: async () => {}, dispose }));
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
    supports: (f: string) =>
      f === "rendering.sceneLayer@1" ? !!opts.supportsSceneLayer : false,
  } as unknown as BundleHost;
  return { host, submit, sceneLayer };
}

beforeEach(() => {
  _resetWebEngineCache();
});

describe("parseSceneLayer", () => {
  it("parses a well-formed C-1 layer", () => {
    const layer = parseSceneLayer(
      JSON.stringify({ items: [{ kind: "text", text: "hi" }] }),
    );
    expect(layer.items).toHaveLength(1);
  });

  it("reads garbage / non-{items} JSON as an empty layer, never throws", () => {
    expect(parseSceneLayer("not json").items).toEqual([]);
    expect(parseSceneLayer("{}").items).toEqual([]);
    expect(parseSceneLayer("[1,2,3]").items).toEqual([]);
  });
});

describe("loadWebEngine — honest not-loaded", () => {
  it("returns null (not a throw) when the glue import fails", async () => {
    const { host } = makeHost({ supportsSceneLayer: true });
    const engine = await loadWebEngine(host, {
      importGlue: async () => {
        throw new Error("no glue here");
      },
    });
    expect(engine).toBeNull();
  });

  it("memoizes the load (one boot per process)", async () => {
    const { host } = makeHost({ supportsSceneLayer: true });
    const importGlue = vi.fn(async () => {
      throw new Error("boom");
    });
    await loadWebEngine(host, { importGlue });
    await loadWebEngine(host, { importGlue });
    expect(importGlue).toHaveBeenCalledTimes(1);
  });
});

describe("bakeWebFrame with the engine — parse + submit (injected fixture)", () => {
  // A WebEngine backed by the captured real-engine fixture.
  const fixtureEngine: WebEngine = {
    render: () => engineFixture as SceneLayer,
  };

  it("submits the engine's real C-1 layer to host.contribute.sceneLayer", async () => {
    const { host, submit, sceneLayer } = makeHost({ supportsSceneLayer: true });
    const out = await bakeWebFrame(host, WEB_ID, fixtureEngine);
    expect(out.rendered).toBe(true);
    expect(out.submitted).toBe(true);
    expect(out.sceneLayer).not.toBeNull();
    expect(out.sceneLayer!.items.length).toBeGreaterThan(0);
    // The fixture carries a recovered text run.
    const texts = out.sceneLayer!.items
      .filter((i) => (i as { kind: string }).kind === "text")
      .map((i) => (i as { text: string }).text);
    expect(texts.join(" ")).toContain("hello");
    expect(sceneLayer).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(WEB_ID.id, expect.anything());
  });

  it("produces the layer but does NOT submit when the host wires no scene channel", async () => {
    const { host, sceneLayer } = makeHost({ supportsSceneLayer: false });
    const out = await bakeWebFrame(host, WEB_ID, fixtureEngine);
    expect(out.rendered).toBe(true);
    expect(out.submitted).toBe(false);
    expect(sceneLayer).not.toHaveBeenCalled();
  });

  it("falls back to the honest not-loaded result when the engine render throws", async () => {
    const throwing: WebEngine = { render: () => null };
    const { host, submit } = makeHost({ supportsSceneLayer: true });
    const out = await bakeWebFrame(host, WEB_ID, throwing);
    expect(out.rendered).toBe(false);
    expect(out.submitted).toBe(false);
    expect(out.sceneLayer).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------
// Real-wasm SMOKE lane — loads the ACTUAL built engine artifact in Node.
// Gated on the artifact being present (it's gitignored generated output;
// build it with `bash scripts/build-wasm.sh --engine`). When absent, the
// suite skips with a clear note rather than failing the default gate.

const binDir = fileURLToPath(new URL("../bin/", import.meta.url));
const gluePath = binDir + "blitz_web.js";
const wasmPath = binDir + "blitz_web_bg.wasm";
const artifactPresent = existsSync(gluePath) && existsSync(wasmPath);

describe.skipIf(!artifactPresent)(
  "real Blitz engine wasm — end-to-end smoke (artifact present)",
  () => {
    it("loads the real wasm, renders a fragment, and submits real C-1 items", async () => {
      const { host, submit } = makeHost({ supportsSceneLayer: true });
      // Load the real glue, init it with the on-disk wasm bytes (Node has
      // no relative fetch), and adapt it to a WebEngine.
      const glue = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_frame: (h: string, w: number, ht: number) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      const engine: WebEngine = {
        render: (html, w, h) => parseSceneLayer(glue.render_web_frame(html, w, h)),
      };

      const out = await bakeWebFrame(host, WEB_ID, engine);
      expect(out.rendered).toBe(true);
      expect(out.submitted).toBe(true);
      const items = out.sceneLayer!.items;
      // The DEFAULT_SOURCE (<h1> + <p>) must paint real C-1 content: at
      // least one text run with recovered text, lowered to the wire.
      const texts = items
        .filter((i) => (i as { kind: string }).kind === "text")
        .map((i) => (i as { text: string }).text);
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.join(" ").trim().length).toBeGreaterThan(0);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  },
);
