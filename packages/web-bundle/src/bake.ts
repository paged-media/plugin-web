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

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  isRendered,
  renderWebFrame,
  sourceFromEnvelope,
  type SceneLayer,
  type WebDiagnostic,
  type WebRenderResult,
} from "@paged-media/web-model";

/** Points per inch — frame bounds are in points already; `dpi` only
 *  drives a raster escape hatch, defaulted at the page's print
 *  resolution. */
const DEFAULT_DPI = 300;

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

  const source = sourceFromEnvelope(await host.document.getMetadata(id));
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

  const result: WebRenderResult = renderWebFrame({
    html: source.html,
    css: source.css,
    vars: source.vars,
    frameWidthPt,
    frameHeightPt,
    dpi: DEFAULT_DPI,
  });

  // The not-loaded path (today): no engine wasm, so no scene layer.
  // Surface the honest diagnostic; the source-lane preview stays the
  // only preview. The B2 IDML bake (scene → vector+text) is downstream
  // of a real layer, so it too is engine-gated and not reached here.
  if (!isRendered(result) || result.sceneLayer === null) {
    return {
      rendered: false,
      submitted: false,
      diagnostics: result.diagnostics,
      sceneLayer: null,
    };
  }

  // The future lane: a real SceneLayer lowers to the C-1 rail. Gated on
  // the host wiring a scene channel (`rendering.sceneLayer@1`); when it
  // doesn't, the layer is produced but not submitted (honest no-op).
  let submitted = false;
  if (host.supports("rendering.sceneLayer@1")) {
    const surface = host.contribute.sceneLayer();
    try {
      // The local SceneLayer twin is the C-1 IR by construction
      // (fillPath/text + ScenePathSeg) — the wire `SceneLayer` shape, so
      // the submit is a structural pass-through.
      await surface.submit(target.id, result.sceneLayer as never);
      submitted = true;
    } finally {
      surface.dispose();
    }
  }

  return {
    rendered: true,
    submitted,
    diagnostics: result.diagnostics,
    sceneLayer: result.sceneLayer,
  };
}
