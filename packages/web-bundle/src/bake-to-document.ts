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
// C-1 SceneLayer, plans the native content (`sceneLayerToBakePlan`), and
// executes it as host mutations: create swatches, then a native rectangle per
// solid fill and a native text frame per text run. So a foreign IDML open — or
// core's own PDF/IDML export — sees REAL content, with no plugin engine.
//
// Follows plugin-sheets' `sheet-bundle/src/lower.ts`: multi-phase, resolving
// ids between phases (a text frame's minted story is found by DIFFING the
// stories collection — an empty frame's story is not hit-test-visible). Colours
// go through the swatch layer (`colorRef` is a swatch id, not raw rgba); we mint
// each swatch with a deterministic `Color/wb-…` self-id so we reference it
// without a read-back.
//
// HONEST v0: text (position + size + fill colour, in the document default face
// — `SceneTextItem.family` is a hint core renders in the default font) and
// solid axis-aligned fill rectangles. Every other kind is reported (never
// faked) via the plan's `deferred` counts. Vertical text placement is
// baseline-exact when `host.text.measureString` is available, else estimated.

import type { BundleHost, ElementId, PageId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  composeSrcdoc,
  renderWebFrameSource,
  sourceFromEnvelope,
  type WebDiagnostic,
} from "../../web-model/src";

import { bakeWebFlow } from "./bake";
import { sceneLayerToBakePlan, type BakePlan, type BakeText } from "./bake-plan";
import { loadWebEngine, type WebEngine } from "./engine-loader";
import { resolveFlowChain } from "./render-flow-command";
import { readSourcePart } from "./source-part";

/** CSS px per point (the engine lays out in px; frame geometry is in pt). */
const PX_PER_PT = 96 / 72;

/** A little width slack on a baked text frame so the run never clips at the
 *  right edge (points). */
const TEXT_PAD_PT = 2;

/** The outcome of a bake-to-document — surfaced to the command handler. */
export interface FrameBakeToDocOutcome {
  /** Whether any native content was created. */
  baked: boolean;
  /** How many native page items (rects + text frames) were created. */
  createdCount: number;
  /** How many swatches were minted. */
  swatchCount: number;
  /** Un-baked SceneItem kinds, counted honestly. */
  deferred: Record<string, number>;
  /** Diagnostics (the not-loaded note, or the unsupported-items warning). */
  diagnostics: WebDiagnostic[];
}

/** Snapshot the document's story ids (to diff a freshly inserted frame's
 *  minted story — an empty frame's story is not hit-test-visible). */
async function storyIdSnapshot(host: BundleHost): Promise<Set<string>> {
  const stories = await host.document.collection<{ selfId: string }>("stories");
  return new Set(stories.map((s) => s.selfId));
}

/** The single story id present now but not in `before`, or null when the diff
 *  is ambiguous (0 or >1 new). */
async function newStoryId(
  host: BundleHost,
  before: ReadonlySet<string>,
): Promise<string | null> {
  const after = await host.document.collection<{ selfId: string }>("stories");
  const fresh = after.map((s) => s.selfId).filter((id) => !before.has(id));
  return fresh.length === 1 ? fresh[0] : null;
}

/** Measure a run for exact frame bounds, or estimate when the host wires no
 *  text surface (advance ≈ 0.5em/char; ascender 0.8em; descender −0.2em). */
async function measureRun(
  host: BundleHost,
  t: BakeText,
): Promise<{ advance: number; ascender: number; descender: number }> {
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
          ) => Promise<{ advance: number; ascender: number; descender: number }>;
        }
      ).measureString("", null, t.text, t.sizePt);
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

const storyRange = (storyId: string, len: number): ElementId =>
  ({
    kind: "storyRange",
    id: { story_id: storyId, start: 0, end: len },
  }) as unknown as ElementId;

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

  const source =
    (await readSourcePart(host, id)) ??
    sourceFromEnvelope(await host.document.getMetadata(id));
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

  const composed = renderWebFrameSource(source);
  const html = composeSrcdoc({ ...source, html: composed.html, css: composed.css });
  const layer = engine.render(
    html,
    Math.round(frameWidthPt * PX_PER_PT),
    Math.round(frameHeightPt * PX_PER_PT),
  );
  if (layer === null) {
    return fail("web rendering engine not loaded — the bake needs the engine");
  }

  const plan = sceneLayerToBakePlan(layer);
  const created = await materializePlan(host, plan, pageId, top, left);

  return {
    baked: created > 0,
    createdCount: created,
    swatchCount: plan.swatches.length,
    deferred: plan.deferred,
    diagnostics: deferredDiagnostics(created, plan.deferred),
  };
}

/**
 * Execute a {@link BakePlan} as native host mutations at a frame's page origin
 * (`top`/`left`, points): create the swatches, a rectangle per fill, and a text
 * frame per run. Returns how many native page items were created. Shared by the
 * single-frame and flow bakes — the per-frame content geometry is already in
 * frame-content points, offset here by the frame's page position.
 */
async function materializePlan(
  host: BundleHost,
  plan: BakePlan,
  pageId: PageId,
  top: number,
  left: number,
): Promise<number> {
  let created = 0;

  // Phase 1 — swatches (one batch; deterministic self-ids so later ops
  // reference them by id, no read-back).
  if (plan.swatches.length > 0) {
    await host.document.mutate({
      op: "batch",
      args: {
        ops: plan.swatches.map((s) => ({
          op: "createSwatch",
          args: {
            spec: {
              selfId: s.id,
              name: s.id,
              space: "RGB",
              value: [s.r, s.g, s.b],
              model: "Process",
            },
          },
        })),
      },
    });
  }

  // Phase 2 — a native rectangle per solid fill (insert + fill in one 2-op
  // batch via the `$created` sentinel = one undo step).
  for (const rect of plan.rects) {
    const [rt, rl, rb, rr] = rect.bounds;
    const outcome = await host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "insertFrame",
            args: { pageId, bounds: [rt + top, rl + left, rb + top, rr + left] },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "rectangle", id: "$created" } as unknown as ElementId,
              path: "frameFillColor",
              value: { type: "colorRef", value: rect.fillColorId },
            },
          },
        ],
      },
    });
    if (outcome.applied) created += 1;
  }

  // Phase 2b — a native PATH per non-rect solid fill (rounded rects,
  // decorative shapes). `insertPath` with `open:false` mints a filled polygon;
  // the anchors are offset from frame-content points to page points.
  for (const p of plan.paths) {
    const anchors = p.anchors.map((a) => ({
      anchor: [a.anchor[0] + left, a.anchor[1] + top] as [number, number],
      left: [a.left[0] + left, a.left[1] + top] as [number, number],
      right: [a.right[0] + left, a.right[1] + top] as [number, number],
    }));
    const outcome = await host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertPath", args: { pageId, anchors, open: false } },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "polygon", id: "$created" } as unknown as ElementId,
              path: "frameFillColor",
              value: { type: "colorRef", value: p.fillColorId },
            },
          },
        ],
      },
    });
    if (outcome.applied) created += 1;
  }

  // Phase 3 — a native text frame per run: measure → insert (resolve the
  // minted story via a stories-diff) → pour → size + colour.
  for (const t of plan.texts) {
    const m = await measureRun(host, t);
    const pageLeft = t.left + left;
    const pageBaseline = t.baseline + top;
    const bounds: [number, number, number, number] = [
      pageBaseline - m.ascender,
      pageLeft,
      pageBaseline - m.descender,
      pageLeft + Math.max(1, m.advance) + TEXT_PAD_PT,
    ];
    const before = await storyIdSnapshot(host);
    const ins = await host.document.mutate({
      op: "insertTextFrame",
      args: { pageId, bounds },
    });
    if (!ins.applied || !ins.createdId) continue;
    const storyId = await newStoryId(host, before);
    if (!storyId) continue;
    await host.document.mutate({
      op: "insertText",
      args: { storyId, offset: 0, text: t.text },
    });
    const range = storyRange(storyId, t.text.length);
    await host.document.mutate({
      op: "setElementProperty",
      args: { elementId: range, path: "characterFontSize", value: { type: "length", value: t.sizePt } },
    });
    await host.document.mutate({
      op: "setElementProperty",
      args: { elementId: range, path: "characterFillColor", value: { type: "colorRef", value: t.fillColorId } },
    });
    created += 1;
  }

  return created;
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

  // Each frame's page origin, chain order.
  const geos = await host.document.elementGeometry(chain);

  let created = 0;
  let swatchCount = 0;
  const deferred: Record<string, number> = {};
  for (let i = 0; i < chain.length; i += 1) {
    const layer = flow.layers[i];
    const geo = geos[i];
    if (!layer || !geo?.bounds || !geo.pageId) continue;
    const plan = sceneLayerToBakePlan(layer);
    created += await materializePlan(
      host,
      plan,
      geo.pageId as PageId,
      geo.bounds[0],
      geo.bounds[1],
    );
    swatchCount += plan.swatches.length;
    for (const [k, v] of Object.entries(plan.deferred)) {
      deferred[k] = (deferred[k] ?? 0) + v;
    }
  }

  return {
    baked: created > 0,
    createdCount: created,
    swatchCount,
    deferred,
    diagnostics: deferredDiagnostics(created, deferred),
  };
}
