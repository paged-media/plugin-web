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

import { bakeWebFlow, bakeWebFrame } from "../src/bake";
import {
  loadWebEngine,
  parseFlowResult,
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
    renderFlow: () => null,
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
    const throwing: WebEngine = { render: () => null, renderFlow: () => null };
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
// DUAL-GATED on the artifact being present (it's gitignored generated
// output; build it with `bash scripts/build-wasm.sh --engine`): locally a
// missing artifact SKIPS with a clear note rather than failing the default
// gate, but in CI the vitest workflow builds the artifact and sets
// REQUIRE_REAL_ENGINE=1, under which a missing artifact FAILS instead of
// skipping — so the real-engine smoke can never silently fall out of CI.

const binDir = fileURLToPath(new URL("../bin/", import.meta.url));
const gluePath = binDir + "blitz_web.js";
const wasmPath = binDir + "blitz_web_bg.wasm";
const artifactPresent = existsSync(gluePath) && existsSync(wasmPath);

// The CI half of the dual gate: fail-not-skip when the artifact is absent.
if (process.env.REQUIRE_REAL_ENGINE === "1" && !artifactPresent) {
  describe("real Blitz engine wasm — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the engine artifact is missing", () => {
      throw new Error(
        `REQUIRE_REAL_ENGINE=1 but ${wasmPath} (or its glue) is missing — ` +
          "build it with `bash scripts/build-wasm.sh --engine` (CI must " +
          "build the artifact before running vitest; skipping is not allowed here)",
      );
    });
  });
}

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
        renderFlow: () => null,
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

    it("threads a real MIXED-tag flow across 3 frames — a real C-1 layer per frame (render_web_flow)", async () => {
      // The ADR-020 rung-2 END-TO-END proof at the WASM boundary: load the
      // real engine, thread a multi-block (h2/p/div) source across three
      // frames, and assert each frame carries real, DISTINCT recovered text —
      // i.e. the flow actually fragmented mixed content across frames in wasm.
      const glue = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      const engine: WebEngine = {
        render: () => null,
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? "")),
      };

      // A 12-block MIXED-tag source (h2/p/div — the flow now recognises any
      // block child of <body>, not just <p>), each a unique MARKnn token so we
      // can see document order per frame.
      const flowSource = {
        html: Array.from({ length: 12 }, (_v, i) => {
          const tag = ["h2", "p", "div"][i % 3];
          return `<${tag}>MARK${String(i).padStart(2, "0")}</${tag}>`;
        }).join(""),
        css: "body{margin:0}h2,p,div{margin:0;font-size:16px;line-height:24px}",
        options: { media: "print", overflow: "clip" } as const,
      };
      const chain = [
        { kind: "rectangle", id: "f0" },
        { kind: "rectangle", id: "f1" },
        { kind: "rectangle", id: "f2" },
      ] as unknown as ElementId[];
      const submit = vi.fn(async (_id: string, _layer: unknown) => {});
      const host = {
        log: silent,
        document: {
          // No parts → readSourcePart falls back to this label source.
          getMetadata: async () => envelopeFor(flowSource),
          elementGeometry: async (ids: ElementId[]) =>
            ids.map((id) => ({ id, pageId: "p1", bounds: [0, 0, 120, 240] })),
        },
        contribute: {
          sceneLayer: () => ({ submit, clear: async () => {}, dispose() {} }),
        },
        supports: (f: string) => f === "rendering.sceneLayer@1",
      } as unknown as BundleHost;

      const out = await bakeWebFlow(host, chain, engine);
      expect(out.rendered).toBe(true);
      // Every frame received a (real) layer; three 120px frames over ~288px
      // of content thread the whole flow.
      expect(out.submittedCount).toBe(3);
      expect(submit).toHaveBeenCalledTimes(3);

      // Per-frame recovered text; at least two frames must carry text (the
      // content genuinely spread across the chain), in forward document order.
      const markersPerFrame = out.layers.map((l) =>
        (l?.items ?? [])
          .filter((i) => (i as { kind: string }).kind === "text")
          .map((i) => (i as { text: string }).text)
          .join(" "),
      );
      const framesWithText = markersPerFrame.filter((t) => t.includes("MARK")).length;
      expect(framesWithText).toBeGreaterThanOrEqual(2);
      // Frame 0 holds the top of the flow.
      expect(markersPerFrame[0]).toContain("MARK00");
    });

    it("splits ONE tall paragraph MID-BLOCK across two frames (rung 3, real wasm)", async () => {
      // The rung-3 end-to-end proof in real wasm: a single long paragraph
      // taller than frame A is split at a LINE boundary — head in A, tail
      // re-wrapped in B, no whole-paragraph duplication.
      const glue = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      const engine: WebEngine = {
        render: () => null,
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? "")),
      };

      const words = Array.from({ length: 40 }, (_v, i) => `w${i}`).join(" ");
      const source = {
        html: `<p>${words}</p>`,
        css: "body{margin:0}p{margin:0;font-size:16px;line-height:24px}",
        options: { media: "print", overflow: "clip" } as const,
      };
      const chain = [
        { kind: "rectangle", id: "a" },
        { kind: "rectangle", id: "b" },
      ] as unknown as ElementId[];
      const submit = vi.fn(async (_id: string, _layer: unknown) => {});
      const host = {
        log: silent,
        document: {
          getMetadata: async () => envelopeFor(source),
          elementGeometry: async (ids: ElementId[]) =>
            ids.map((id, i) => ({
              id,
              pageId: "p1",
              // Frame A narrow + short (~2 lines); frame B tall.
              bounds: i === 0 ? [0, 0, 48, 200] : [0, 0, 4096, 200],
            })),
        },
        contribute: {
          sceneLayer: () => ({ submit, clear: async () => {}, dispose() {} }),
        },
        supports: (f: string) => f === "rendering.sceneLayer@1",
      } as unknown as BundleHost;

      const out = await bakeWebFlow(host, chain, engine);
      expect(out.rendered).toBe(true);
      const textOf = (i: number) =>
        (out.layers[i]?.items ?? [])
          .filter((it) => (it as { kind: string }).kind === "text")
          .map((it) => (it as { text: string }).text)
          .join(" ");
      const a = textOf(0);
      const b = textOf(1);
      expect(a).toContain("w0");
      expect(b).toContain("w39");
      // The cut is MID-paragraph: A lacks the tail, B lacks the head.
      expect(a).not.toContain("w39");
      expect(b).not.toContain("w0");
    });

    it("fragments a tall LIST between its items across frames (Phase B, real wasm)", async () => {
      // Phase B end-to-end in real wasm: a <ul> taller than frame A is a
      // CONTAINER (no inline text of its own), so it fragments BETWEEN its
      // <li> children — fitting items in A, the rest in B, no whole-list move.
      const glue = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      const engine: WebEngine = {
        render: () => null,
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? "")),
      };

      const items = Array.from(
        { length: 10 },
        (_v, i) => `<li>MARK${String(i).padStart(2, "0")}</li>`,
      ).join("");
      const source = {
        html: `<ul>${items}</ul>`,
        css: "body{margin:0}ul{margin:0;padding:0;list-style:none}li{margin:0;font-size:16px;line-height:24px}",
        options: { media: "print", overflow: "clip" } as const,
      };
      const chain = [
        { kind: "rectangle", id: "a" },
        { kind: "rectangle", id: "b" },
      ] as unknown as ElementId[];
      const submit = vi.fn(async (_id: string, _layer: unknown) => {});
      const host = {
        log: silent,
        document: {
          getMetadata: async () => envelopeFor(source),
          elementGeometry: async (ids: ElementId[]) =>
            ids.map((id, i) => ({
              id,
              pageId: "p1",
              // Frame A ~72px holds ~3 items; frame B (tall) holds the rest.
              bounds: i === 0 ? [0, 0, 72, 200] : [0, 0, 4096, 200],
            })),
        },
        contribute: {
          sceneLayer: () => ({ submit, clear: async () => {}, dispose() {} }),
        },
        supports: (f: string) => f === "rendering.sceneLayer@1",
      } as unknown as BundleHost;

      const out = await bakeWebFlow(host, chain, engine);
      expect(out.rendered).toBe(true);
      const textOf = (i: number) =>
        (out.layers[i]?.items ?? [])
          .filter((it) => (it as { kind: string }).kind === "text")
          .map((it) => (it as { text: string }).text)
          .join(" ");
      const a = textOf(0);
      const b = textOf(1);
      expect(a).toContain("MARK00"); // first item in A
      expect(a).not.toContain("MARK09"); // A lacks the last → a genuine split, not a whole-list move
      expect(b).toContain("MARK09"); // remainder flows to B
    });

    it("fragments a tall TABLE between rows, repeating the header (Phase B, real wasm)", async () => {
      // Phase B end-to-end in real wasm: a <table> taller than frame A splits
      // between its <tbody> rows; the <thead> is never consumed, so it repeats
      // at the top of frame B. Row bands come from the cells (Taffy lays out no
      // <tr> box) — this proves that path through the real artifact.
      const glue = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      const engine: WebEngine = {
        render: () => null,
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? "")),
      };

      const rows = Array.from(
        { length: 10 },
        (_v, i) => `<tr><td>MARK${String(i).padStart(2, "0")}</td></tr>`,
      ).join("");
      const source = {
        html: `<table><thead><tr><th>HEADER</th></tr></thead><tbody>${rows}</tbody></table>`,
        css: "body{margin:0}table{margin:0}th,td{padding:0;font-size:16px;line-height:24px}",
        options: { media: "print", overflow: "clip" } as const,
      };
      const chain = [
        { kind: "rectangle", id: "a" },
        { kind: "rectangle", id: "b" },
      ] as unknown as ElementId[];
      const submit = vi.fn(async (_id: string, _layer: unknown) => {});
      const host = {
        log: silent,
        document: {
          getMetadata: async () => envelopeFor(source),
          elementGeometry: async (ids: ElementId[]) =>
            ids.map((id, i) => ({
              id,
              pageId: "p1",
              bounds: i === 0 ? [0, 0, 96, 200] : [0, 0, 4096, 200],
            })),
        },
        contribute: {
          sceneLayer: () => ({ submit, clear: async () => {}, dispose() {} }),
        },
        supports: (f: string) => f === "rendering.sceneLayer@1",
      } as unknown as BundleHost;

      const out = await bakeWebFlow(host, chain, engine);
      expect(out.rendered).toBe(true);
      const textOf = (i: number) =>
        (out.layers[i]?.items ?? [])
          .filter((it) => (it as { kind: string }).kind === "text")
          .map((it) => (it as { text: string }).text)
          .join(" ");
      const a = textOf(0);
      const b = textOf(1);
      expect(a).toContain("MARK00"); // first body row in A
      expect(a).not.toContain("MARK09"); // A lacks the last row → a genuine split
      expect(b).toContain("MARK09"); // remainder flows to B
      expect(a).toContain("HEADER"); // header on A
      expect(b).toContain("HEADER"); // header REPEATS on B (thead never consumed)
    });

    it("CSS Regions flow-into: only the named subtree flows (real wasm)", async () => {
      // End-to-end CSS Regions syntax: the source CSS names `#story` as the
      // flow root, so the sibling <nav> does NOT flow — bakeWebFlow parses
      // flow-into and passes the selector to the real engine.
      const glue = (await import(new URL("../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      const engine: WebEngine = {
        render: () => null,
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? "")),
      };

      const story = Array.from({ length: 10 }, (_v, i) => `<p>MARK${i}</p>`).join("");
      const source = {
        html: `<nav><p>NAVLINK</p></nav><section id="story">${story}</section>`,
        css: "body{margin:0}*{margin:0}p{font-size:16px;line-height:24px} #story{flow-into:main}",
        options: { media: "print", overflow: "clip" } as const,
      };
      const chain = [
        { kind: "rectangle", id: "a" },
        { kind: "rectangle", id: "b" },
      ] as unknown as ElementId[];
      const submit = vi.fn(async (_id: string, _layer: unknown) => {});
      const host = {
        log: silent,
        document: {
          getMetadata: async () => envelopeFor(source),
          elementGeometry: async (ids: ElementId[]) =>
            ids.map((id) => ({ id, pageId: "p1", bounds: [0, 0, 96, 200] })),
        },
        contribute: { sceneLayer: () => ({ submit, clear: async () => {}, dispose() {} }) },
        supports: (f: string) => f === "rendering.sceneLayer@1",
      } as unknown as BundleHost;

      const out = await bakeWebFlow(host, chain, engine);
      expect(out.rendered).toBe(true);
      const all = out.layers
        .flatMap((l) => l?.items ?? [])
        .filter((it) => (it as { kind: string }).kind === "text")
        .map((it) => (it as { text: string }).text)
        .join(" ");
      expect(all).toContain("MARK0");
      expect(all).not.toContain("NAVLINK");
      // The flow-into note is surfaced honestly.
      expect(
        out.diagnostics.some((d) => d.message.includes("flows into") || d.message.includes("main")),
      ).toBe(true);
    });
  },
);
