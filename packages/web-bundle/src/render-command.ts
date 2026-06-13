// The "Render to frame" command handler — the bake-path affordance.
// Runs `bakeWebFrame` over the single selected element and surfaces the
// outcome HONESTLY: today the engine is not loaded, so the render
// contract returns no scene layer and this publishes the "engine not
// loaded — source-lane preview only" note through `host.diagnostics`
// (the editor's Problems panel) + the log. When the Blitz engine lands
// behind the render contract, the SAME handler submits a real SceneLayer
// to the C-1 rail (inside `bakeWebFrame`) and reports the submission —
// no handler change needed (the door is wired; the engine drops in).

import type { BundleHost } from "@paged-media/plugin-api";
import { sourceKeyFor, asFrameTarget } from "@paged-media/web-model";

import { bakeWebFrame } from "./bake";

/** Diagnostics key for the render lane — distinct from the source
 *  panel's lint key so a render note doesn't clobber lint output. */
const RENDER_DIAG_SUFFIX = "#render";

export async function renderSelectedWebFrame(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length !== 1) {
    host.log.info("renderWebFrame: select a single web frame to render");
    return;
  }
  const id = selection[0];
  const outcome = await bakeWebFrame(host, id);

  // Publish the render diagnostics where the Problems panel sees them,
  // keyed off the target so they clear when the source key changes.
  const target = asFrameTarget(id);
  if (target) {
    host.diagnostics.set(
      sourceKeyFor(target) + RENDER_DIAG_SUFFIX,
      outcome.diagnostics,
    );
  }

  if (outcome.submitted) {
    host.log.info("renderWebFrame: scene layer submitted to canvas");
  } else if (outcome.rendered) {
    // A layer was produced but the host wired no scene channel — honest
    // no-op (the future case under a host without rendering.sceneLayer).
    host.log.info(
      "renderWebFrame: rendered, but the host wired no scene channel — not composited",
    );
  } else {
    host.log.info(
      "renderWebFrame: " +
        (outcome.diagnostics[0]?.message ?? "engine not loaded"),
    );
  }
}
