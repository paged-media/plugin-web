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

// The BAKE PATH — "Render to frame". The bundle-side wiring of the
// W-01 render contract to the C-1 `sceneLayer` rail (ADR-011 Option B:
// lower Blitz's paint to the plugin scene layer, never a core paint
// hook). It is STRUCTURED end-to-end and ENGINE-GATED: it reads the
// selected web frame's source + geometry, builds a `WebRenderRequest`,
// calls `renderWebFrame`, and —
//   · WHEN the engine paints (future): submits the C-1 SceneLayer via
//     `host.contribute.sceneLayer().submit(...)` so core composes it
//     inside the frame under `ItemTransform` + content-box clip;
//   · TODAY: `renderWebFrame` returns the honest not-loaded path
//     (`sceneLayer: null`), so this surfaces the "engine not loaded"
//     diagnostic and leaves the sandboxed source-lane preview as the
//     only preview. NOTHING is faked — no empty layer is submitted.
//
// The B2 baking (a real SceneLayer → IDML vector+text fallback, so a
// foreign open sees baked content) is the documented downstream step:
// it lowers WHATEVER scene the engine produced and is therefore equally
// engine-gated. It is named here as the next seam, not implemented.

import type {
  BundleHost,
  ElementId,
  SceneLayerSurface,
} from "@paged-media/plugin-api";
import {
  asFrameTarget,
  composeSrcdoc,
  isRendered,
  renderWebFrame,
  renderWebFrameSource,
  sourceFromEnvelope,
  ENGINE_NOT_LOADED_MESSAGE,
  type SceneLayer,
  type WebDiagnostic,
  type WebFrameSource,
  type WebRenderResult,
} from "../../web-model/src";

import type { WebEngine } from "./engine-loader";
import { readSourcePart } from "./source-part";

/** Points per inch — frame bounds are in points already; `dpi` only
 *  drives a raster escape hatch, defaulted at the page's print
 *  resolution. */
const DEFAULT_DPI = 300;

/** CSS px per point. 1 pt = 1/72 in, 1 px = 1/96 in → px = pt × 96/72.
 *  The frame's content box is in points; the engine lays out in CSS px and
 *  the capture converts px→pt internally, so feeding the px-equivalent
 *  size brings the lowered geometry back into frame-content points. */
const PX_PER_PT = 96 / 72;

/** The bundle's PERSISTENT scene-layer surface, memoized per host.
 *
 *  A baked web render is a PERSISTENT layer: it stays painted in the frame
 *  until the source changes or the frame is removed (unlike sheet's
 *  ephemeral in-frame grid, but the same surface-lifetime discipline). The
 *  surface MUST therefore outlive a single `bakeWebFrame` call — its
 *  `dispose()` clears every id it submitted (`host-impl.ts` interprets
 *  disposing a contribution as releasing it, i.e. `clear()` per submitted
 *  element). The earlier code created a surface, submitted, and disposed it
 *  in the SAME call's `finally`, so the submit was immediately followed by a
 *  fire-and-forget `clearSceneLayer(id)` that wiped the layer — the frame
 *  rendered 0 visible pixels. Caching one surface per host (like the sheet
 *  session caches `sceneSurface`) keeps the submitted layer alive. */
const sceneSurfaces = new WeakMap<BundleHost, SceneLayerSurface>();

/** Get (or lazily create) the host's persistent scene-layer surface, or
 *  `null` when the host wires no scene channel. Never disposed here — it
 *  lives for the host's lifetime so the submitted layer persists. */
function persistentSceneSurface(host: BundleHost): SceneLayerSurface | null {
  if (!host.supports("rendering.sceneLayer@1")) return null;
  let surface = sceneSurfaces.get(host);
  if (!surface) {
    surface = host.contribute.sceneLayer();
    sceneSurfaces.set(host, surface);
  }
  return surface;
}

/** The outcome of a bake attempt — surfaced to the caller (the command
 *  handler / panel) so it can show the honest diagnostic or report a
 *  real submission. */
export interface BakeOutcome {
  /** Whether a real SceneLayer was produced AND submitted to the host. */
  rendered: boolean;
  /** Whether the host actually accepted the layer (`sceneLayer`
   *  capability wired + submit applied). False on the not-loaded path
   *  and when the host has no scene channel. */
  submitted: boolean;
  /** The render contract's diagnostics — at minimum the not-loaded note
   *  today; engine layout/paint findings once the lane lands. */
  diagnostics: WebDiagnostic[];
  /** The scene layer, when one was produced (else null) — exposed for
   *  the B2 IDML-bake step (engine-gated) and for tests. */
  sceneLayer: SceneLayer | null;
}

/** Read the selected frame's source + geometry and run the render
 *  contract. Pure-ish: the only side effect (a `sceneLayer.submit`) is
 *  reached ONLY when the engine produced a real layer — i.e. never
 *  today. Returns the honest outcome either way; never throws (a missing
 *  target / non-web-frame selection reports `rendered:false` with a
 *  diagnostic, not an error). */
export async function bakeWebFrame(
  host: BundleHost,
  id: ElementId,
  engine?: WebEngine | null,
): Promise<BakeOutcome> {
  const notRendered = (diagnostics: WebDiagnostic[]): BakeOutcome => ({
    rendered: false,
    submitted: false,
    diagnostics,
    sceneLayer: null,
  });

  const target = asFrameTarget(id);
  if (!target) {
    return notRendered([
      {
        severity: "info",
        message: "select a single web frame to render",
        source: "render",
      },
    ]);
  }

  // Prefer the portable .paged container part (the uncapped source-of-truth),
  // falling back to the metadata label for documents written before the part
  // migration (or a host with no container writer).
  const source =
    (await readSourcePart(host, id)) ??
    sourceFromEnvelope(await host.document.getMetadata(id));
  if (!source) {
    return notRendered([
      {
        severity: "info",
        message:
          "the selected frame is not a web frame — make it one in the Web frame panel",
        source: "render",
      },
    ]);
  }

  // Frame content-box geometry → the CSS layout viewport. Bounds are
  // page-local pt `[top, left, bottom, right]`; the engine lays out
  // against width/height in points (frame-content space — core applies
  // the frame's ItemTransform, so the bundle never compensates).
  const [geo] = await host.document.elementGeometry([id]);
  const bounds = geo?.bounds;
  const frameWidthPt = bounds ? Math.max(0, bounds[3] - bounds[1]) : 0;
  const frameHeightPt = bounds ? Math.max(0, bounds[2] - bounds[0]) : 0;

  // With the engine LOADED: compose the document the engine lays out
  // (html + css → a single document, with the §6.2 template vars applied
  // first, exactly as the preview composes), feed it the frame's content
  // size in CSS px, and take the REAL C-1 layer the engine painted. With
  // the engine NOT loaded (or it threw): the honest not-loaded path.
  const result: WebRenderResult = engine
    ? renderWithEngine(engine, source, frameWidthPt, frameHeightPt)
    : renderWebFrame({
        html: source.html,
        css: source.css,
        vars: source.vars,
        frameWidthPt,
        frameHeightPt,
        dpi: DEFAULT_DPI,
      });

  // The not-loaded path: no engine wasm (or it failed), so no scene layer.
  // Surface the honest diagnostic; the source-lane preview stays the only
  // preview. The B2 IDML bake (scene → vector+text) is downstream of a
  // real layer, so it too is engine-gated and not reached here.
  if (!isRendered(result) || result.sceneLayer === null) {
    return {
      rendered: false,
      submitted: false,
      diagnostics: result.diagnostics,
      sceneLayer: null,
    };
  }

  // A real SceneLayer lowers to the C-1 rail. Gated on the host wiring a
  // scene channel (`rendering.sceneLayer@1`); when it doesn't, the layer is
  // produced but not submitted (honest no-op).
  //
  // CRITICAL: the surface is the host-PERSISTENT one (see
  // `persistentSceneSurface`) and is NOT disposed after submit. A baked
  // render must STAY painted in the frame; disposing the surface would
  // `clear()` the just-submitted layer (the 0-visible-pixels defect).
  let submitted = false;
  const surface = persistentSceneSurface(host);
  if (surface) {
    // The local SceneLayer twin is the C-1 IR by construction
    // (fillPath/text + ScenePathSeg) — the wire `SceneLayer` shape, so
    // the submit is a structural pass-through.
    await surface.submit(target.id, result.sceneLayer as never);
    submitted = true;
  }

  return {
    rendered: true,
    submitted,
    diagnostics: result.diagnostics,
    sceneLayer: result.sceneLayer,
  };
}

/** Run the loaded engine over a frame's source → a {@link WebRenderResult}.
 *  Composes the document the engine lays out (template vars applied first,
 *  then html+css → one document, exactly the preview's `composeSrcdoc`),
 *  feeds the content size in CSS px, and returns the REAL C-1 layer. On a
 *  wasm-side failure (`engine.render` → null) it falls back to the honest
 *  not-loaded result so the command never crashes. */
function renderWithEngine(
  engine: WebEngine,
  source: WebFrameSource,
  frameWidthPt: number,
  frameHeightPt: number,
): WebRenderResult {
  // Apply the §6.2 deterministic template pass, then compose the document.
  const rendered = renderWebFrameSource(source);
  const composed: WebFrameSource = {
    ...source,
    html: rendered.html,
    css: rendered.css,
  };
  const html = composeSrcdoc(composed);
  const widthPx = Math.round(frameWidthPt * PX_PER_PT);
  const heightPx = Math.round(frameHeightPt * PX_PER_PT);

  const layer = engine.render(html, widthPx, heightPx);
  if (layer === null) {
    // The engine loaded but the render threw — honest not-loaded result
    // (no fake layer). The loader already logged the wasm error.
    return {
      sceneLayer: null,
      diagnostics: [
        {
          severity: "info",
          message: ENGINE_NOT_LOADED_MESSAGE,
          source: "render",
        },
      ],
    };
  }
  return {
    sceneLayer: layer,
    diagnostics: [...rendered.diagnostics],
  };
}
