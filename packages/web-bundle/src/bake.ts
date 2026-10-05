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

// The RENDER PATH — "Render web frame to canvas" and the flow render. The
// bundle-side wiring of the render contract to the C-1 `sceneLayer` rail
// (ADR-011 Option B: lower Blitz's paint to the plugin scene layer, never a
// core paint hook). It reads the web frame's source + geometry, builds a
// render request and —
//   · with the engine loaded (engine-loader.ts): renders it and submits
//     the C-1 SceneLayer via `host.contribute.sceneLayer().submit(...)`,
//     which core composes inside the frame under `ItemTransform` +
//     content-box clip (a flow: one layer per frame of the chain);
//   · without it: web-model's not-loaded result — the "engine not
//     loaded" diagnostic, the sandboxed source-lane preview stays the only
//     preview, and NOTHING is faked (no empty layer is submitted).
//
// Baking a rendered scene into native page items (so a foreign open and
// IDML/PDF export see the content) is bake-plan.ts + bake-to-document.ts.

import type {
  BundleHost,
  ElementId,
  SceneLayerSurface,
} from "@paged-media/plugin-api";
import {
  asFrameTarget,
  composeSrcdoc,
  flowGroups,
  flowRootSelector,
  flowSelectorFor,
  isRendered,
  namedFlowDiagnostics,
  renderWebFrame,
  renderWebFrameSource,
  ENGINE_NOT_LOADED_MESSAGE,
  type SceneLayer,
  type TemplateVars,
  type WebDiagnostic,
  type WebFrameSource,
  type WebRenderResult,
} from "../../web-model/src";

import { resolveBindings } from "./bindings";
import { engineDocument } from "./engine-document";
import { faceDiagnostics, prepareEngineInputs, resourceDiagnostics } from "./engine-inputs";
import type { WebEngine } from "./engine-loader";
import { renderWithPolicy } from "./overflow";
import { describeRefusal, loadWebSource } from "./source-part";

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

/** The frame ids that hold a layer this bundle submitted, per host — so
 *  the auto renderer (auto-render.ts) can clear a frame that left a flow
 *  or was deleted. */
const submittedFrames = new WeakMap<BundleHost, Set<string>>();

/** The frames currently holding a layer this bundle submitted. */
export function framesWithLayers(host: BundleHost): Set<string> {
  let set = submittedFrames.get(host);
  if (!set) {
    set = new Set();
    submittedFrames.set(host, set);
  }
  return set;
}

/** Get (or lazily create) the host's persistent scene-layer surface, or
 *  `null` when the host wires no scene channel. Never disposed here — it
 *  lives for the host's lifetime so the submitted layer persists. Submits
 *  and clears are recorded in {@link framesWithLayers}. */
export function persistentSceneSurface(host: BundleHost): SceneLayerSurface | null {
  if (!host.supports("rendering.sceneLayer@1")) return null;
  let surface = sceneSurfaces.get(host);
  if (!surface) {
    const inner = host.contribute.sceneLayer();
    const held = framesWithLayers(host);
    surface = Object.assign(Object.create(inner) as SceneLayerSurface, {
      submit: async (id: string, layer: Parameters<SceneLayerSurface["submit"]>[1]) => {
        // From protocol 68 the reply names the faces drawn in the default
        // font (`{ fontFallbacks }`); an older host answers nothing.
        const reply: unknown = await inner.submit(id, layer);
        held.add(id);
        return reply as void;
      },
      clear: async (id: string) => {
        await inner.clear(id);
        held.delete(id);
      },
      dispose: () => {
        held.clear();
        inner.dispose();
      },
    });
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
  /** The render contract's diagnostics — the not-loaded note when the
   *  engine is absent; template and overflow findings otherwise. */
  diagnostics: WebDiagnostic[];
  /** The scene layer, when one was produced (else null) — exposed for
   *  the B2 IDML-bake step (engine-gated) and for tests. */
  sceneLayer: SceneLayer | null;
}

/** Read a frame's source + geometry and render it under its overflow
 *  policy. Side effects: a `sceneLayer.submit` when the engine produced a
 *  layer, and — for `grow`, when `opts.allowGrow` is not false — one
 *  undoable `resizeFrame`. Returns the honest outcome either way; never
 *  throws (a missing target / non-web-frame selection reports
 *  `rendered:false` with a diagnostic, not an error). */
export async function bakeWebFrame(
  host: BundleHost,
  id: ElementId,
  engine?: WebEngine | null,
  opts?: { allowGrow?: boolean },
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

  const source = await loadWebSource(host, id);
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
  const bound = (await resolveBindings(host, id, source)).vars;
  const result: WebRenderResult = engine
    ? await renderWithEngine(host, id, engine, source, bounds ?? null, opts?.allowGrow ?? true, bound)
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
    const reply: unknown = await surface.submit(target.id, result.sceneLayer as never);
    submitted = true;
    result.diagnostics.push(...faceDiagnostics(reply));
  }

  return {
    rendered: true,
    submitted,
    diagnostics: result.diagnostics,
    sceneLayer: result.sceneLayer,
  };
}

/** Run the loaded engine over a frame's source → a {@link WebRenderResult},
 *  under the source's overflow policy (overflow.ts). Composes the document
 *  the engine lays out (template vars applied first, then html+css → one
 *  document, exactly the preview's `composeSrcdoc`) and feeds the content
 *  size in CSS px. `grow` resizes the frame to the content (one undoable
 *  `resizeFrame`) when `allowGrow`; the auto renderer withholds it after an
 *  undo so undoing a grow sticks. On a wasm-side failure it falls back to
 *  the honest not-loaded result so the command never crashes. */
async function renderWithEngine(
  host: BundleHost,
  id: ElementId,
  engine: WebEngine,
  source: WebFrameSource,
  bounds: [number, number, number, number] | null,
  allowGrow: boolean,
  bound: TemplateVars = {},
): Promise<WebRenderResult> {
  const notLoaded: WebRenderResult = {
    sceneLayer: null,
    diagnostics: [
      { severity: "info", message: ENGINE_NOT_LOADED_MESSAGE, source: "render" },
    ],
  };
  const frameWidthPt = bounds ? Math.max(0, bounds[3] - bounds[1]) : 0;
  const frameHeightPt = bounds ? Math.max(0, bounds[2] - bounds[0]) : 0;
  // Apply the §6.2 deterministic template pass (with the bound values),
  // then compose the document.
  const rendered = renderWebFrameSource(source, bound);
  const html = composeSrcdoc({ ...source, html: rendered.html, css: rendered.css });
  const widthPx = Math.round(frameWidthPt * PX_PER_PT);
  const heightPx = Math.round(frameHeightPt * PX_PER_PT);
  const policy = source.options.overflow;
  // The faces the source names and the resources it points at, from the
  // document (never the network).
  await prepareEngineInputs(host, engine, html);
  // A threaded source's policy is its flow (render-flow-command.ts); a
  // single-frame render of it shows its own frame, clipped.
  const fit = renderWithPolicy(engine, html, widthPx, heightPx, policy);
  // The engine loaded but the render threw — honest not-loaded result (no
  // fake layer). The loader already logged the wasm error.
  if (fit === null) return notLoaded;
  const diagnostics: WebDiagnostic[] = [...rendered.diagnostics, ...resourceDiagnostics(engine)];

  if (policy === "grow" && fit.contentHeightPx !== null && bounds) {
    const contentPt = fit.contentHeightPx / PX_PER_PT;
    if (allowGrow && Math.abs(contentPt - frameHeightPt) > GROW_TOLERANCE_PT) {
      const target = asFrameTarget(id);
      const out = target
        ? await host.document.mutate({
            op: "resizeFrame",
            args: { frameId: target.id, bounds: [bounds[0], bounds[1], bounds[0] + contentPt, bounds[3]] },
          })
        : { applied: false, error: "not a page item" };
      if (!out.applied) {
        diagnostics.push({
          severity: "warning",
          message: `overflow grow: the frame could not be resized (${describeRefusal(out.error)})`,
          source: "render",
        });
      }
    }
  }
  if (fit.overset) {
    diagnostics.push({
      severity: "warning",
      message:
        policy === "thread" && !source.flow
          ? "content continues past the frame — thread it into more frames (Thread web flow into frames)"
          : policy === "shrink"
            ? "content does not fit even at 5 % — it is clipped"
            : "content does not fit the frame — it is clipped",
      source: "render",
    });
  }
  return { sceneLayer: fit.layer, diagnostics };
}

/** grow leaves a frame alone when it is within this of the content height
 *  (points) — a re-render after the resize must not resize again. */
const GROW_TOLERANCE_PT = 0.5;

// ===================================================================
// The FLOW bake path — one source threaded across a chain of frames
// (ADR-020 rung 2). The flow analogue of bakeWebFrame: it lays the
// SOURCE frame's HTML/CSS out across the chain's content-box sizes and
// submits one C-1 SceneLayer per frame. Same honesty rule — engine-gated,
// never a fake layer; the not-loaded path submits nothing and reports it.
// ===================================================================

/** The outcome of a flow bake — surfaced to the command handler. */
export interface FlowBakeOutcome {
  /** Whether the engine produced real layers for the chain. */
  rendered: boolean;
  /** How many frames actually had a layer submitted to the host. */
  submittedCount: number;
  /** Whether content remained past the last frame (the flow overset). */
  overset: boolean;
  /** The render diagnostics — the not-loaded note when the engine is absent. */
  diagnostics: WebDiagnostic[];
  /** The per-frame layers (chain order), for the B2 IDML-bake step +
   *  tests; `null` where a frame got no layer or on the not-loaded path. */
  layers: (SceneLayer | null)[];
}

/** The content-box size of one frame in points, read from host geometry. */
interface FrameSizePt {
  widthPt: number;
  heightPt: number;
}

/**
 * Thread the source frame's HTML/CSS across `chain` (chain[0] = the source
 * web frame; chain[1..] = the recipient frames, in order) and submit one
 * C-1 SceneLayer per frame. Engine-gated and honest: without a loaded engine
 * it returns the not-loaded flow result (a `null` layer per frame + the
 * diagnostic) and submits nothing; it never fakes a layer. Never throws — a
 * short chain / non-web-frame source reports `rendered:false` with a
 * diagnostic.
 */
export async function bakeWebFlow(
  host: BundleHost,
  chain: ElementId[],
  engine?: WebEngine | null,
  opts?: { submit?: boolean },
): Promise<FlowBakeOutcome> {
  // The flow bake-to-native reuses this render but wants the per-frame layers
  // WITHOUT the ephemeral SceneLayer submit (native content replaces it, not
  // draws over it). Default: submit (the "Render web flow" behaviour).
  const doSubmit = opts?.submit ?? true;
  const notRendered = (message: string): FlowBakeOutcome => ({
    rendered: false,
    submittedCount: 0,
    overset: false,
    diagnostics: [{ severity: "info", message, source: "render" }],
    layers: [],
  });

  if (chain.length < 2) {
    return notRendered(
      "select a web frame plus one or more target frames to thread the flow",
    );
  }

  const sourceId = chain[0];
  const source = await loadWebSource(host, sourceId);
  if (!source) {
    return notRendered(
      "the first selected frame is not a web frame — make it one in the Web frame panel",
    );
  }

  // Every frame's content-box size (points), chain order. Bounds are
  // page-local pt `[top, left, bottom, right]`.
  const geos = await host.document.elementGeometry(chain);
  const framesPt: FrameSizePt[] = chain.map((_, i) => {
    const b = geos[i]?.bounds;
    return {
      widthPt: b ? Math.max(0, b[3] - b[1]) : 0,
      heightPt: b ? Math.max(0, b[2] - b[0]) : 0,
    };
  });

  // The not-loaded path: no engine wasm → honest per-frame nulls, submit
  // nothing. NOTHING is faked. (The engine-loaded path below submits by
  // `ElementId` + chain index; the string-keyed web-model `renderWebFlow`
  // contract is the seam for host-agnostic callers, not this ElementId path.)
  if (!engine) {
    return {
      rendered: false,
      submittedCount: 0,
      overset: false,
      diagnostics: [
        { severity: "info", message: ENGINE_NOT_LOADED_MESSAGE, source: "render" },
      ],
      layers: chain.map(() => null),
    };
  }

  // Compose the document once (template vars first, then html+css → one
  // doc), and feed the engine each frame's content size in CSS px.
  const bound = (await resolveBindings(host, sourceId, source)).vars;
  const rendered = renderWebFrameSource(source, bound);
  const html = composeSrcdoc({
    ...source,
    html: rendered.html,
    css: rendered.css,
  });
  const framesPx = framesPt.map((f) => ({
    widthPx: Math.round(f.widthPt * PX_PER_PT),
    heightPx: Math.round(f.heightPt * PX_PER_PT),
  }));

  // CSS Regions `flow-into`: if the source names a flow root, only that
  // subtree flows across the chain (Stylo ignores the property, so the plugin
  // parses it). Absent → the whole body flows.
  const flowRoot = flowRootSelector(rendered.css);
  await prepareEngineInputs(host, engine, html);
  const flow = engine.renderFlow(html, framesPx, flowRoot);
  const missing = resourceDiagnostics(engine);
  if (flow === null) {
    // The engine loaded but the flow render threw — honest not-loaded.
    return {
      rendered: false,
      submittedCount: 0,
      overset: false,
      diagnostics: [
        { severity: "info", message: ENGINE_NOT_LOADED_MESSAGE, source: "render" },
      ],
      layers: chain.map(() => null),
    };
  }

  // Submit each frame's layer to its frame via the host-PERSISTENT surface
  // (the same lifetime discipline bakeWebFrame relies on — a baked layer must
  // stay painted). A frame with no layer (the engine halted early) is left
  // untouched, not cleared.
  const surface = persistentSceneSurface(host);
  const layers: (SceneLayer | null)[] = [];
  const faces: WebDiagnostic[] = [];
  let submittedCount = 0;
  for (let i = 0; i < chain.length; i += 1) {
    const layer = flow.frames[i] ?? null;
    layers.push(layer);
    // `submit` keys by the frame's STRING id; a chain element that isn't a
    // string-id page item (asFrameTarget → null) can't receive a layer.
    const target = asFrameTarget(chain[i]);
    if (doSubmit && surface && layer && target) {
      faces.push(...faceDiagnostics(await surface.submit(target.id, layer as never)));
      submittedCount += 1;
    }
  }

  // Surface flow overset (content that didn't fit the chain) as an honest
  // warning in the Problems panel — alongside the render findings and any
  // CSS Regions (flow-into/flow-from) notes.
  const diagnostics = [
    ...rendered.diagnostics,
    ...namedFlowDiagnostics(rendered.css),
    ...missing,
    ...dedupe(faces),
  ];
  if (flow.overset) {
    diagnostics.push({
      severity: "warning",
      message:
        "web flow overset — content does not fit the frame chain; add a frame or enlarge the last",
      source: "render",
    });
  }

  return {
    rendered: true,
    submittedCount,
    overset: flow.overset,
    diagnostics,
    layers,
  };
}

/**
 * Render ALL of a source's flow groups (CSS multi-flow): the primary flow plus
 * each named `flow-into` flow, each across ITS own frames with ITS own
 * `flow-into` selector. Subsumes the single-flow case (a source with no named
 * flows = one primary group). Reads the source from `sourceId`; the frame
 * groups come from its persisted `flowGroups`. Honest + engine-gated like
 * `bakeWebFlow`.
 */
export async function bakeWebFlows(
  host: BundleHost,
  sourceId: ElementId,
  engine?: WebEngine | null,
): Promise<FlowBakeOutcome> {
  const notRendered = (message: string): FlowBakeOutcome => ({
    rendered: false,
    submittedCount: 0,
    overset: false,
    diagnostics: [{ severity: "info", message, source: "render" }],
    layers: [],
  });

  const sourceTarget = asFrameTarget(sourceId);
  if (!sourceTarget) {
    return notRendered("select a web frame to render its flow");
  }
  const source = await loadWebSource(host, sourceId);
  if (!source) {
    return notRendered(
      "the selected frame is not a web frame — make it one in the Web frame panel",
    );
  }

  // The template pass and composition run once for all groups (memoized
  // per source content across commands). The ENGINE still parses the
  // composed document once per group: `render_web_flow` takes one flow root
  // per call, so a source with N named flows costs N parses + N resolves
  // until the engine takes every group in one call (recorded for the
  // engine half, perf-baseline-2026-10-05 "after Wave 2 (host)").
  const bound = (await resolveBindings(host, sourceId, source)).vars;
  const doc = engineDocument(source, bound);
  const groups = flowGroups(source, sourceTarget);
  const diagnostics: WebDiagnostic[] = [
    ...doc.diagnostics,
    ...namedFlowDiagnostics(doc.css),
  ];

  if (!engine) {
    return {
      rendered: false,
      submittedCount: 0,
      overset: false,
      diagnostics,
      layers: groups.flatMap((g) => g.frames.map(() => null)),
    };
  }

  const surface = persistentSceneSurface(host);
  const layers: (SceneLayer | null)[] = [];
  const faces: WebDiagnostic[] = [];
  let submittedCount = 0;
  let anyOverset = false;
  await prepareEngineInputs(host, engine, doc.html);

  // Every group's frame geometry in ONE read (was one read per group).
  const allFrames = groups.flatMap((g) => g.frames as unknown as ElementId[]);
  const allGeos = await host.document.elementGeometry(allFrames);
  const geoById = new Map(allGeos.map((g) => [(g.id as { id?: unknown }).id, g]));

  for (const group of groups) {
    // A frame of the chain that no longer exists (deleted; undo can bring
    // it back, so the chain keeps naming it) is skipped, not laid out as a
    // 0×0 region. Geometry is matched by id, never by reply position.
    const present = group.frames.filter((f) => geoById.has(f.id));
    const groupFrames = present as unknown as ElementId[];
    const geos = present.map((f) => geoById.get(f.id));
    const framesPx = present.map((_, i) => {
      const b = geos[i]?.bounds;
      const widthPt = b ? Math.max(0, b[3] - b[1]) : 0;
      const heightPt = b ? Math.max(0, b[2] - b[0]) : 0;
      return {
        widthPx: Math.round(widthPt * PX_PER_PT),
        heightPx: Math.round(heightPt * PX_PER_PT),
      };
    });
    // The flow root for this group: `""` → the primary (first flow-into / whole
    // body); a named group → that flow-into's selector.
    const flowRoot = flowSelectorFor(doc.css, group.name);
    const flow = engine.renderFlow(doc.html, framesPx, flowRoot);
    diagnostics.push(...resourceDiagnostics(engine));
    if (flow === null) {
      present.forEach(() => layers.push(null));
      continue;
    }
    for (let i = 0; i < present.length; i += 1) {
      const layer = flow.frames[i] ?? null;
      layers.push(layer);
      const target = asFrameTarget(groupFrames[i]);
      if (surface && layer && target) {
        faces.push(...faceDiagnostics(await surface.submit(target.id, layer as never)));
        submittedCount += 1;
      }
    }
    if (flow.overset) anyOverset = true;
  }
  diagnostics.push(...dedupe(diagnostics.splice(0).concat(faces)));

  if (anyOverset) {
    diagnostics.push({
      severity: "warning",
      message:
        "web flow overset — content does not fit the frame chain; add a frame or enlarge the last",
      source: "render",
    });
  }

  return {
    rendered: layers.some((l) => l !== null),
    submittedCount,
    overset: anyOverset,
    diagnostics,
    layers,
  };
}

/** Diagnostics without repeats (several frames report the same face). */
function dedupe(list: WebDiagnostic[]): WebDiagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.severity}\u0000${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
