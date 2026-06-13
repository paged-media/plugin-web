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
// string`; we resolve it as a bundle-relative asset (`import.meta.url`,
// the same `/@fs/`-allowed sibling path the worker/asset doors use) so the
// contract-import lint stays satisfied (a relative path, never a bare
// specifier) and the bundle can only load a module it ships. The glue is
// imported LAZILY (on first real render) so the source lane never pays the
// engine's load cost.

import type { BundleHost } from "@paged-media/plugin-api";

import type { SceneLayer } from "@paged-media/web-model";

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
}

/** A loaded engine: a single pure-ish render call. `render` returns the
 *  C-1 `SceneLayer` the engine painted (possibly empty), or `null` if the
 *  wasm itself threw — the caller then reports the honest failure. */
export interface WebEngine {
  render(html: string, widthPx: number, heightPx: number): SceneLayer | null;
}

/** Inject the glue module (tests pass a stub / a disk-loaded module);
 *  production resolves it from the bundle's own asset base. */
export interface LoadEngineOptions {
  /** Resolve + import the wasm-bindgen glue. Defaults to the bundle-
   *  relative `bin/blitz_web.js` via `import.meta.url`. */
  importGlue?: () => Promise<BlitzGlue>;
}

/** The default glue importer: the bundle-relative wasm-bindgen ESM,
 *  resolved through the bundle's asset base. A bare dynamic `import()` of a
 *  computed URL — `tsc` does not resolve it, so the gitignored generated
 *  file need not exist at typecheck time. */
async function importBundledGlue(): Promise<BlitzGlue> {
  const url = new URL("../bin/blitz_web.js", import.meta.url).href;
  return (await import(/* @vite-ignore */ url)) as unknown as BlitzGlue;
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
      // wasm-bindgen `--target web`: `default` (== `__wbg_init`) fetches +
      // instantiates `blitz_web_bg.wasm` relative to the glue module. After
      // it resolves, `render_web_frame` is callable.
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

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
