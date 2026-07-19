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

// The ENGINE LOADER — the bundle-side half of ADR-011 Option B's "HTML/CSS
// in, scene layer out". It loads the Blitz/WASM engine artifact (manifest
// `capabilities.wasm` ∋ `blitz`, purpose:"engine"; built by
// `scripts/build-wasm.sh --engine`) and exposes the single render call the
// bake path needs: `render(html, widthPx, heightPx) -> SceneLayer | null`.
//
// HONESTY: this never fakes a render. `loadWebEngine` returns `null` (and
// the bake path stays on the "engine not loaded" diagnostic) whenever the
// artifact can't be loaded — no glue resolvable, instantiation failed, or
// the host didn't run in a realm that can fetch the sibling asset. A
// loaded engine that paints nothing yields an empty `{ items: [] }` layer,
// which the bake path treats as "rendered, nothing to show" — still real,
// never invented.
//
// The wasm artifact is wasm-bindgen `--target web` glue (`bin/blitz_web.js`
// + `bin/blitz_web_bg.wasm`, gitignored generated output). The glue owns
// the wasm memory + the string marshaling for `render_web_frame(string) ->
// string`. We import it two RELATIVE ways — never a computed
// `new URL(import.meta.url)` — so the contract-import lint stays satisfied
// AND the load survives Vite's dep-optimizer (below); the bundle can only
// load a module it ships. The glue is imported LAZILY (on first real
// render) so the source lane never pays the engine's load cost.
//
// WHY relative + `?url` (the fix, matching sheet-bundle's engine.ts): a
// `new URL("../bin/blitz_web.js", import.meta.url)` + `@vite-ignore` import
// 404s in the editor the moment Vite pre-bundles this bundle into
// `node_modules/.vite/deps` — `import.meta.url` moves, so `../bin` points at
// `.vite/bin/…` which doesn't exist. Instead we `import("../bin/blitz_web.js")`
// (esbuild bundles the glue as a sibling dist chunk, so its `import.meta.url`
// stays valid wherever the bundle lands) and hand the `_bg.wasm` bytes in via
// the bundler's `?url` import (Vite-native — resolves to a real served asset;
// wasm-bindgen's bare-relative default fetch would hit Vite's SPA fallback and
// fail with "expected magic word 00 61 73 6d, found 3c …").

import type { BundleHost } from "@paged-media/plugin-api";

import type { SceneLayer } from "../../web-model/src";

/** The minimal surface of the wasm-bindgen `--target web` glue we use —
 *  declared locally so typecheck never depends on the GENERATED (and
 *  gitignored) `bin/blitz_web.d.ts`. `default` is `__wbg_init`; `initSync`
 *  takes a compiled module or bytes. */
interface BlitzGlue {
  default: (
    init?: { module_or_path: unknown } | unknown,
  ) => Promise<unknown>;
  render_web_frame: (
    html: string,
    widthPx: number,
    heightPx: number,
  ) => string;
  /** Thread a flow across N frames (ADR-020 rung 2). `framesJson` is
   *  `[{"widthPx":N,"heightPx":M}, …]` in chain order; `flowRoot` is a CSS
   *  `flow-into` selector (Regions syntax) or "" for the whole body; returns
   *  `{ frames: [{ layer, emitted }], overset }` as JSON. */
  render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
}

/** A rendered flow: one C-1 layer per recipient frame (chain order) plus
 *  whether content remained past the last frame. */
export interface WebFlowRender {
  frames: SceneLayer[];
  overset: boolean;
}

/** A loaded engine: pure-ish render calls. Each returns the C-1
 *  `SceneLayer`(s) the engine painted (possibly empty), or `null` if the
 *  wasm itself threw — the caller then reports the honest failure. */
export interface WebEngine {
  render(html: string, widthPx: number, heightPx: number): SceneLayer | null;
  /** Thread one flow across the given frames (content-box CSS px, chain
   *  order) → one layer per frame + overset, or `null` on a wasm failure.
   *  `flowRoot` is an optional CSS `flow-into` selector (only that subtree
   *  flows); omit / "" flows the whole body. */
  renderFlow(
    html: string,
    frames: { widthPx: number; heightPx: number }[],
    flowRoot?: string,
  ): WebFlowRender | null;
}

/** Inject the glue module (tests pass a stub / a disk-loaded module);
 *  production resolves it from the bundle's own asset base. */
export interface LoadEngineOptions {
  /** Resolve + import the wasm-bindgen glue. Defaults to the bundle-
   *  relative `bin/blitz_web.js` via `import.meta.url`. */
  importGlue?: () => Promise<BlitzGlue>;
}

/** True when running under Node (vitest / headless conformance), false in
 *  the browser (the editor). Branches the glue's wasm-instantiation path. */
function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    !!(process as { versions?: { node?: string } }).versions?.node
  );
}

/** The default glue importer: the bundle-relative wasm-bindgen ESM. The
 *  relative `import()` lets tsup bundle the glue as a sibling dist chunk (so
 *  its `import.meta.url` survives Vite dep-optimization) while `tsc` still
 *  doesn't resolve it (the gitignored artifact need not exist at typecheck).
 *
 *  BROWSER: instantiate the wasm here from the bundler's `?url` asset URL
 *  (the reliable path — see the module header). NODE: leave the glue
 *  un-instantiated; the real-wasm Node path is the INJECTED `importGlue`
 *  (tests read the bytes + `initSync`), and the default path stays honestly
 *  not-loaded — `loadWebEngine`'s `glue.default()` (no args) fetch fails in
 *  Node, caught as the not-loaded diagnostic (the conformance suite asserts
 *  this). */
async function importBundledGlue(): Promise<BlitzGlue> {
  // @ts-ignore — the artifact (bin/blitz_web.js, the wasm-bindgen glue) is
  // gitignored generated output, intentionally absent from the source tree;
  // the dynamic import resolves at runtime once built. Typed via BlitzGlue.
  const glue = (await import("../bin/blitz_web.js")) as unknown as BlitzGlue;
  if (isNode()) return glue;
  // @ts-ignore — `?url` is a bundler affordance (untyped), kept external by
  // tsup so Vite resolves it to a served asset URL.
  const wasmUrl = (await import("../bin/blitz_web_bg.wasm?url")) as {
    default: string;
  };
  await glue.default({ module_or_path: wasmUrl.default });
  return glue;
}

/** Cache one loaded engine per bundle process — booting the wasm once. */
let cached: Promise<WebEngine | null> | undefined;

/**
 * Load the Blitz/WASM engine, or `null` when it cannot be loaded (no
 * artifact, instantiation failure, or a realm that can't fetch the sibling
 * asset). Idempotent + memoized: the first call boots the wasm; later calls
 * reuse it. Never throws — a load failure resolves to `null` (and is logged
 * through the host) so the bake path stays on the honest not-loaded
 * diagnostic instead of crashing the command.
 */
export async function loadWebEngine(
  host: BundleHost,
  options: LoadEngineOptions = {},
): Promise<WebEngine | null> {
  if (cached) return cached;
  cached = (async (): Promise<WebEngine | null> => {
    try {
      const glue = await (options.importGlue ?? importBundledGlue)();
      // Ensure the wasm is instantiated. `default` (== `__wbg_init`) is
      // idempotent (returns early once `wasm` is set), so this is a no-op
      // when the glue arrived pre-instantiated — the browser importer
      // (`?url` bytes) and the injected test glue (`initSync`) both do. In
      // the Node default path the glue is un-instantiated, so this no-arg
      // call attempts the bare-relative fetch, fails, and is caught below as
      // the honest not-loaded diagnostic.
      await glue.default();
      return {
        render(html, widthPx, heightPx): SceneLayer | null {
          try {
            const json = glue.render_web_frame(html, widthPx, heightPx);
            return parseSceneLayer(json);
          } catch (err) {
            host.log.warn(
              `web engine: render_web_frame threw — ${stringifyErr(err)}`,
            );
            return null;
          }
        },
        renderFlow(html, frames, flowRoot): WebFlowRender | null {
          try {
            const json = glue.render_web_flow(
              html,
              JSON.stringify(frames),
              flowRoot ?? "",
            );
            return parseFlowResult(json);
          } catch (err) {
            host.log.warn(
              `web engine: render_web_flow threw — ${stringifyErr(err)}`,
            );
            return null;
          }
        },
      };
    } catch (err) {
      host.log.info(
        `web engine: not loaded (${stringifyErr(err)}) — source-lane ` +
          `preview only`,
      );
      return null;
    }
  })();
  return cached;
}

/** Reset the memoized engine — for tests (each test loads fresh). */
export function _resetWebEngineCache(): void {
  cached = undefined;
}

/** Parse the engine's JSON output into a {@link SceneLayer}, defensively:
 *  a non-object / missing `items` reads as an empty layer (the engine
 *  produced nothing renderable), never a throw. The wire shape the wasm
 *  emits is exactly the C-1 `{ items: SceneItem[] }` the bundle submits. */
export function parseSceneLayer(json: string): SceneLayer {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return parsed as SceneLayer;
    }
  } catch {
    // fall through to the empty layer
  }
  return { items: [] };
}

/** Parse the engine's flow JSON (`{ frames: [{ layer, emitted }], overset }`)
 *  into per-frame {@link SceneLayer}s + `overset`, defensively — a malformed
 *  payload (or one missing `frames`) reads as an empty, non-overset flow,
 *  never a throw. Each frame's `layer` is validated to the C-1
 *  `{ items: [] }` shape (a bad entry reads as an empty layer). */
export function parseFlowResult(json: string): WebFlowRender {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object") {
      const p = parsed as { frames?: unknown; overset?: unknown };
      if (Array.isArray(p.frames)) {
        const frames = p.frames.map((entry): SceneLayer => {
          const layer = (entry as { layer?: unknown })?.layer;
          if (
            layer &&
            typeof layer === "object" &&
            Array.isArray((layer as { items?: unknown }).items)
          ) {
            return layer as SceneLayer;
          }
          return { items: [] };
        });
        return { frames, overset: p.overset === true };
      }
    }
  } catch {
    // fall through to the empty flow
  }
  return { frames: [], overset: false };
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
