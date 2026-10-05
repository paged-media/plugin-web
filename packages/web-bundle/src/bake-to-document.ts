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

// The BAKE ORCHESTRATOR (Phase C) — the IMPURE half of "flatten a rendered
// web frame into NATIVE Paged content". It renders the frame's source to a
// C-1 SceneLayer, plans the native content (`sceneLayerToBakePlan`), measures
// every text run, and applies the whole bake as ONE `batch` mutation
// (`bakeBatchOps`): swatches, a native rectangle per solid fill, a native path
// per single-subpath fill, and a native text frame per run — inserted, poured,
// sized and coloured through `bindCreated` handles. One bake is one undo step,
// and the created ids come back in the outcome's `minted` list, so nothing is
// re-discovered by reading the stories collection. A flow bake is one batch
// across all its frames. So a foreign IDML open — or core's own PDF/IDML
// export — sees REAL content, with no plugin engine.
//
// Colours go through the swatch layer (`colorRef` is a swatch id, not raw
// rgba) with deterministic `Color/wb-…` self-ids; the swatches collection is
// read once per bake so an already-present swatch is not created again (the
// engine refuses a duplicate id, which would roll the whole batch back).
//
// What bakes is listed in bake-plan.ts: text in its own face (family +
// style per run, sized to the engine's shaped advance), fills, strokes,
// gradients, opacity, drop shadows and images (PNG-encoded here, inline in
// the batch). Every other kind is reported (never faked) via the plan's
// `deferred` counts. Vertical text placement is baseline-exact when
// `host.text.measureString` is available, else estimated. A refused batch
// bakes nothing and says why.

import type { BundleHost, ElementId, PageId } from "@paged-media/plugin-api";
import { asFrameTarget, type WebDiagnostic } from "../../web-model/src";

import { bakeWebFlow } from "./bake";
import {
  bakeBatchOps,
  sceneLayerToBakePlan,
  type BakeText,
  type PlacedBakePlan,
  type RunMetrics,
} from "./bake-plan";
import { engineDocument } from "./engine-document";
import { prepareEngineInputs, resourceDiagnostics } from "./engine-inputs";
import { encodePng } from "./png";
import { loadWebEngine, type WebEngine } from "./engine-loader";
import { publishRenderReport } from "./render-report";
import { resolveFlowChain } from "./render-flow-command";
import { describeRefusal, loadWebSource } from "./source-part";

/** CSS px per point (the engine lays out in px; frame geometry is in pt). */
const PX_PER_PT = 96 / 72;

/** The outcome of a bake-to-document — surfaced to the command handler. */
export interface FrameBakeToDocOutcome {
  /** Whether any native content was created. */
  baked: boolean;
  /** How many native page items (rects, paths and text frames) were created. */
  createdCount: number;
  /** How many swatches were minted. */
  swatchCount: number;
  /** Un-baked SceneItem kinds, counted honestly. */
  deferred: Record<string, number>;
  /** Diagnostics (the not-loaded note, a refused bake, or the
   *  unsupported-items warning). */
  diagnostics: WebDiagnostic[];
}

/** Measure a run for exact frame bounds, or estimate when the host wires no
 *  text surface (advance ≈ 0.5em/char; ascender 0.8em; descender −0.2em). */
async function measureRun(
  host: BundleHost,
  t: BakeText,
): Promise<RunMetrics> {
  const text = (host as { text?: { measureString?: unknown } }).text;
  if (text && typeof (text as { measureString?: unknown }).measureString === "function") {
    try {
      return await (
        text as {
          measureString: (
            family: string,
            style: string | null,
            text: string,
            sizePt: number,
          ) => Promise<RunMetrics>;
        }
      ).measureString(t.family ?? "", t.fontStyle ?? null, t.text, t.sizePt);
    } catch {
      // fall through to the estimate
    }
  }
  return {
    advance: t.text.length * t.sizePt * 0.5,
    ascender: t.sizePt * 0.8,
    descender: -t.sizePt * 0.2,
  };
}

/**
 * Render the selected web frame and MATERIALISE it as native Paged content.
 * Never throws: a non-web-frame selection, a missing engine, or a not-loaded
 * render all return `baked:false` with an honest diagnostic (never a fake
 * bake). When the engine is loaded, creates swatches + native rectangles +
 * native text frames and reports the created + deferred counts.
 */
export async function bakeWebFrameToDocument(
  host: BundleHost,
  id: ElementId,
  engineIn?: WebEngine | null,
): Promise<FrameBakeToDocOutcome> {
  const fail = (message: string): FrameBakeToDocOutcome => ({
    baked: false,
    createdCount: 0,
    swatchCount: 0,
    deferred: {},
    diagnostics: [{ severity: "info", message, source: "render" }],
  });

  const target = asFrameTarget(id);
  if (!target) return fail("select a single web frame to bake to the document");

  const source = await loadWebSource(host, id);
  if (!source) return fail("the selected frame is not a web frame");

  const [geo] = await host.document.elementGeometry([id]);
  if (!geo?.bounds || !geo.pageId) {
    return fail("could not resolve the frame's page geometry");
  }
  const [top, left, bottom, right] = geo.bounds;
  const pageId = geo.pageId as PageId;
  const frameWidthPt = Math.max(0, right - left);
  const frameHeightPt = Math.max(0, bottom - top);

  const engine = engineIn ?? (await loadWebEngine(host));
  if (!engine) {
    return fail("web rendering engine not loaded — the bake needs the engine");
  }

  const { html } = engineDocument(source);
  await prepareEngineInputs(host, engine, html);
  const layer = engine.render(
    html,
    Math.round(frameWidthPt * PX_PER_PT),
    Math.round(frameHeightPt * PX_PER_PT),
  );
  if (layer === null) {
    return fail("web rendering engine not loaded — the bake needs the engine");
  }

  const missing = resourceDiagnostics(engine);
  const advances = engine.takeTextAdvances?.()[0] ?? [];
  const plan = sceneLayerToBakePlan(layer, advances);
  const placed = await placePlan(host, plan, pageId, top, left);
  const applied = await applyBake(host, [placed]);
  if ("refused" in applied) return fail(applied.refused);

  return {
    baked: applied.created > 0,
    createdCount: applied.created,
    swatchCount: applied.swatchCount,
    deferred: plan.deferred,
    diagnostics: [...missing, ...deferredDiagnostics(applied.created, plan.deferred)],
  };
}

/** Measure every text run of a plan (all requests in flight at once) and
 *  place the plan at its frame's page origin. */
async function placePlan(
  host: BundleHost,
  plan: PlacedBakePlan["plan"],
  pageId: PageId,
  top: number,
  left: number,
): Promise<PlacedBakePlan> {
  const metrics = await Promise.all(plan.texts.map((t) => measureRun(host, t)));
  const imageBytes = await Promise.all(
    plan.images.map(async (img) => {
      try {
        return await encodePng(img.rgba, img.width, img.height);
      } catch {
        return null;
      }
    }),
  );
  for (const b of imageBytes) if (b === null) plan.deferred["image.encode"] = (plan.deferred["image.encode"] ?? 0) + 1;
  return { plan, pageId, top, left, metrics, imageBytes };
}

/** The swatch ids the document already holds (one read per bake). A failed
 *  read answers "none", and the batch then reports a duplicate honestly. */
async function existingIds(
  host: BundleHost,
  name: "swatches" | "gradients",
): Promise<Set<string>> {
  try {
    const rows = await host.document.collection<{ selfId?: unknown }>(name);
    return new Set(rows.map((r) => r.selfId).filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

async function applyBake(
  host: BundleHost,
  placed: readonly PlacedBakePlan[],
): Promise<{ created: number; swatchCount: number } | { refused: string }> {
  const items = placed.reduce(
    (n, p) =>
      n + p.plan.rects.length + p.plan.paths.length + p.plan.texts.length + p.plan.images.length,
    0,
  );
  const anySwatch = placed.some((p) => p.plan.swatches.length > 0);
  if (items === 0 && !anySwatch) return { created: 0, swatchCount: 0 };

  // Swatch and gradient self-ids already in the document are not created
  // again (a duplicate refuses — and rolls back — the whole batch).
  const anyGradient = placed.some((p) => p.plan.gradients.length > 0);
  const existing = new Set([
    ...(anySwatch ? await existingIds(host, "swatches") : []),
    ...(anyGradient ? await existingIds(host, "gradients") : []),
  ]);
  const batch = bakeBatchOps(placed, existing);
  if (batch.ops.length === 0) return { created: 0, swatchCount: 0 };
  const outcome = await host.document.mutate({ op: "batch", args: { ops: batch.ops } });
  if (!outcome.applied) {
    return { refused: `the document refused the bake: ${describeRefusal(outcome.error)}` };
  }
  const named = new Set([
    ...batch.handles.rects,
    ...batch.handles.paths,
    ...batch.handles.images,
    ...batch.handles.texts,
  ]);
  // `minted` is additive on the wire; an engine that omits it applied the
  // whole batch all the same (a batch is all-or-nothing).
  // An inserted PATH comes back with no handle (core 0.67 names the mints of
  // insertFrame / insertTextFrame but not of insertPath), so an unnamed mint
  // counts too: the batch only mints what it inserts.
  const created = outcome.minted
    ? outcome.minted.filter((m) => m.handle === null || named.has(m.handle)).length
    : named.size;
  return { created, swatchCount: batch.swatchIds.length };
}

/** The unsupported-items warning for a bake (empty when nothing was deferred). */
function deferredDiagnostics(
  created: number,
  deferred: Record<string, number>,
): WebDiagnostic[] {
  const total = Object.values(deferred).reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const detail = Object.entries(deferred)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  return [
    {
      severity: "warning",
      message: `baked ${created} native item(s); ${total} unsupported item(s) not baked (${detail})`,
      source: "render",
    },
  ];
}

/** The command handler: bake the SELECTED web frame — or, when the selection
 *  resolves to a threaded FLOW, the whole flow — to native content, then report
 *  the outcome. One command, the right behaviour for either shape. */
export async function bakeSelectedWebFrame(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.info("bakeWebFrame: select a web frame to bake to the document");
    return;
  }
  // A persisted flow on the first frame (or a ≥2-frame selection) bakes the
  // whole flow, frame by frame; a lone web frame bakes just itself.
  const chain = await resolveFlowChain(host, selection);
  const outcome =
    chain && chain.length >= 2
      ? await bakeWebFlowToDocument(host, chain)
      : await bakeWebFrameToDocument(host, selection[0]);
  publishRenderReport({
    op: "bake",
    rendered: outcome.baked,
    submitted: outcome.createdCount,
    overset: null,
    deferred: outcome.deferred,
    messages: outcome.diagnostics.map((d) => d.message),
  });
  if (outcome.baked) {
    host.log.info(
      `bakeWebFrame: baked ${outcome.createdCount} native item(s)` +
        (outcome.diagnostics[0] ? ` (${outcome.diagnostics[0].message})` : ""),
    );
  } else {
    host.log.info(`bakeWebFrame: ${outcome.diagnostics[0]?.message ?? "nothing baked"}`);
  }
}

/**
 * Bake a whole FLOW to native content: thread the source across `chain`, then
 * MATERIALISE each recipient frame's fragment as native content in THAT frame.
 * The per-frame layers come from {@link bakeWebFlow} with the ephemeral submit
 * OFF (native content replaces the live render, not draws over it). Aggregates
 * the created + deferred counts across frames. Never throws; the not-loaded
 * path bakes nothing and reports it.
 */
export async function bakeWebFlowToDocument(
  host: BundleHost,
  chain: ElementId[],
  engineIn?: WebEngine | null,
): Promise<FrameBakeToDocOutcome> {
  const fail = (message: string): FrameBakeToDocOutcome => ({
    baked: false,
    createdCount: 0,
    swatchCount: 0,
    deferred: {},
    diagnostics: [{ severity: "info", message, source: "render" }],
  });

  if (chain.length < 2) return fail("select a web frame plus one or more target frames");

  const engine = engineIn ?? (await loadWebEngine(host));
  if (!engine) return fail("web rendering engine not loaded — the bake needs the engine");

  // Render the flow → one layer per chain frame (no ephemeral submit).
  const flow = await bakeWebFlow(host, chain, engine, { submit: false });
  if (!flow.rendered) return fail(flow.diagnostics[0]?.message ?? "flow render produced no layers");
  // The shaped advance of every text item, one list per frame.
  const advances = engine.takeTextAdvances?.() ?? [];

  // Each frame's page origin, chain order.
  const geos = await host.document.elementGeometry(chain);

  const deferred: Record<string, number> = {};
  const placed: PlacedBakePlan[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const layer = flow.layers[i];
    const geo = geos[i];
    if (!layer || !geo?.bounds || !geo.pageId) continue;
    const plan = sceneLayerToBakePlan(layer, advances[i] ?? []);
    placed.push(await placePlan(host, plan, geo.pageId as PageId, geo.bounds[0], geo.bounds[1]));
    for (const [k, v] of Object.entries(plan.deferred)) {
      deferred[k] = (deferred[k] ?? 0) + v;
    }
  }

  // The whole flow — every frame's content — as ONE batch: one undo step.
  const applied = await applyBake(host, placed);
  if ("refused" in applied) return fail(applied.refused);
  const { created, swatchCount } = applied;

  return {
    baked: created > 0,
    createdCount: created,
    swatchCount,
    deferred,
    diagnostics: deferredDiagnostics(created, deferred),
  };
}
