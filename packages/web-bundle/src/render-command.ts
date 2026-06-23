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

// The "Render to frame" command handler — the bake-path affordance.
// Loads the Blitz/WASM engine, runs `bakeWebFrame` over the single
// selected element, and surfaces the outcome HONESTLY: a loaded engine
// submits a real C-1 SceneLayer to the rail (inside `bakeWebFrame`) and
// this reports the submission; an engine that can't load falls back to
// the "engine not loaded — source-lane preview only" note published
// through `host.diagnostics` (the editor's Problems panel) + the log.
// Never a fake render — an empty layer is real, a missing engine is said.

import type { BundleHost } from "@paged-media/plugin-api";
import { sourceKeyFor, asFrameTarget } from "../../web-model/src";

import { bakeWebFrame } from "./bake";
import { loadWebEngine } from "./engine-loader";

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
  // Load the Blitz/WASM engine (memoized; null when it can't be loaded —
  // the bake path then stays on the honest not-loaded diagnostic). This is
  // the EXPERIMENTAL render affordance turning real: a loaded engine
  // produces a real C-1 sceneLayer that core composes inside the frame.
  const engine = await loadWebEngine(host);
  const outcome = await bakeWebFrame(host, id, engine);

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
