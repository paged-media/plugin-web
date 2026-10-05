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

// The AUTO RENDERER — the canvas follows the document without a command.
//
// One reconcile pass: find every web frame (one `tree()` read; on an engine
// that reports plugin metadata on tree rows that is the whole discovery,
// otherwise one `getMetadata` per page item), resolve each source's flow
// groups to the frames that still exist, read their sizes (one
// `elementGeometry`), and re-render a source only when its KEY changed —
// the label text (which names the source, inline or by content hash) plus
// the content-box sizes of every frame it renders into. A move changes no
// size (core applies the frame transform to the layer), so it renders
// nothing. Then every frame that holds a layer from this bundle but should
// not — it left a flow, was deleted, or held an ad-hoc flow render — is
// cleared.
//
// When it runs:
//   · on activation, and when the editor announces a newly loaded document
//     (`documentLoaded` on the raw client — the plugin contract has no
//     document-opened event; sheets reads the same message);
//   · after document changes (`document.onDidChange`), debounced, so a
//     save, an undo/redo of one, a resize, a thread/unthread or a delete
//     shows on the canvas.
//
// grow (overflow.ts) resizes a frame; it is allowed only when a pass was
// caused by an edit (not an undo/redo, not an open) and the frame's source
// or width changed since it last grew — so undoing a grow sticks.

import type { BundleHost, ElementId, SceneTreeNode } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  flowGroups,
  isWebFrameEnvelope,
  type FrameTarget,
  type WebFrameSource,
  type WebSourceEnvelope,
} from "../../web-model/src";

import { bakeWebFlows, bakeWebFrame, framesWithLayers, persistentSceneSurface } from "./bake";
import { loadWebEngine, type WebEngine } from "./engine-loader";
import { loadWebSource, readWebLabel } from "./source-part";

/** Why a pass runs. Only `change` may grow a frame. */
export type ReconcileReason = "open" | "change" | "undo";

export interface AutoRenderer {
  /** Run a pass now (after any pass in flight). */
  reconcile(reason: ReconcileReason): Promise<void>;
  /** Resolves once no pass is scheduled or running. */
  idle(): Promise<void>;
  /** The labels of every web frame the last pass found, by frame id. */
  labels(): ReadonlyMap<string, string>;
  /** Subscribe to the end of every pass (the parts collector uses it). */
  onDidReconcile(listener: (labels: ReadonlyMap<string, string>) => void): { dispose(): void };
  dispose(): void;
}

export interface AutoRenderOptions {
  /** Debounce for document-change bursts, ms. */
  debounceMs?: number;
  /** The engine (tests inject one); defaults to the bundle's loader. */
  engine?: () => Promise<WebEngine | null>;
}

const METADATA_KEY = "x-paged:media.paged.web";
const DEFAULT_DEBOUNCE_MS = 120;

const renderers = new WeakMap<BundleHost, AutoRenderer>();

/** The auto renderer started for `host` (by `activate`), if any. */
export function autoRendererFor(host: BundleHost): AutoRenderer | undefined {
  return renderers.get(host);
}

/** One web frame found by discovery. */
interface Found {
  id: ElementId;
  label: string;
}

/** Walk the scene tree: every string-id page item, and its plugin label
 *  when the engine reports labels on tree rows (`null` = not reported). */
function pageItems(roots: readonly SceneTreeNode[]): { items: ElementId[]; labels: Map<string, string> | null } {
  const items: ElementId[] = [];
  let labels: Map<string, string> | null = null;
  const walk = (nodes: readonly SceneTreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.id && typeof (n.id as { id?: unknown }).id === "string") {
        items.push(n.id);
        if (Array.isArray(n.pluginMetadata)) {
          labels ??= new Map();
          const entry = n.pluginMetadata.find((e) => e.key === METADATA_KEY);
          if (entry) labels.set((n.id as { id: string }).id, entry.value);
        }
      }
      walk(n.children ?? undefined);
    }
  };
  walk(roots);
  return { items, labels };
}

function parseLabel(text: string): WebSourceEnvelope | null {
  try {
    return JSON.parse(text) as WebSourceEnvelope;
  } catch {
    return null;
  }
}

export function startAutoRender(host: BundleHost, opts: AutoRenderOptions = {}): AutoRenderer {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const engineOf = opts.engine ?? (() => loadWebEngine(host));

  // Per source frame: the key of its last render, the frames that got a
  // layer from it, and the (label|width) it last grew for.
  let renderedKey = new Map<string, string>();
  let layerFrames = new Map<string, string[]>();
  let grewFor = new Map<string, string>();
  let lastLabels = new Map<string, string>();
  // Parsed sources by label text (a label names one source exactly).
  let sources = new Map<string, WebFrameSource | null>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingReason: ReconcileReason | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<(labels: ReadonlyMap<string, string>) => void>();

  const merge = (a: ReconcileReason | null, b: ReconcileReason): ReconcileReason => {
    // An undo anywhere in a burst withholds grow for the whole pass.
    if (a === "undo" || b === "undo") return "undo";
    if (a === "open" || b === "open") return "open";
    return "change";
  };

  async function discover(): Promise<Found[]> {
    const roots = await host.document.tree();
    const { items, labels } = pageItems(roots);
    const found: Found[] = [];
    if (labels) {
      for (const id of items) {
        const text = labels.get((id as { id: string }).id);
        if (text !== undefined && isWebFrameEnvelope(parseLabel(text))) found.push({ id, label: text });
      }
      return found;
    }
    // An engine without labels on tree rows: one read per page item.
    for (const id of items) {
      const text = await readWebLabel(host, id);
      if (text !== null) found.push({ id, label: text });
    }
    return found;
  }

  async function sourceFor(f: Found): Promise<WebFrameSource | null> {
    if (sources.has(f.label)) return sources.get(f.label) ?? null;
    const src = await loadWebSource(host, f.id);
    sources.set(f.label, src);
    return src;
  }

  async function pass(reason: ReconcileReason): Promise<void> {
    const surface = persistentSceneSurface(host);
    if (!surface) return; // no scene channel: nothing can show
    const found = await discover();
    lastLabels = new Map(found.map((f) => [(f.id as { id: string }).id, f.label]));
    const engine = await engineOf();

    // Resolve every source's frames; one geometry read for all of them.
    const plans: { f: Found; source: WebFrameSource; frames: FrameTarget[] }[] = [];
    const wanted = new Map<string, ElementId>();
    for (const f of found) {
      const source = await sourceFor(f);
      const target = asFrameTarget(f.id);
      if (!source || !target) continue;
      const frames = flowGroups(source, target).flatMap((g) => g.frames);
      plans.push({ f, source, frames });
      for (const fr of frames) wanted.set(fr.id, fr as unknown as ElementId);
    }
    const geos = wanted.size > 0 ? await host.document.elementGeometry([...wanted.values()]) : [];
    const size = new Map<string, string>();
    for (const g of geos) {
      const b = g.bounds;
      const id = (g.id as { id?: unknown }).id;
      if (typeof id === "string" && b) size.set(id, `${(b[3] - b[1]).toFixed(2)}x${(b[2] - b[0]).toFixed(2)}`);
    }

    const keep = new Set<string>();
    const live = new Set<string>();
    for (const { f, source, frames } of plans) {
      const sid = (f.id as { id: string }).id;
      live.add(sid);
      const present = frames.filter((fr) => size.has(fr.id));
      const key = f.label + "|" + present.map((fr) => `${fr.id}:${size.get(fr.id)}`).join(",");
      if (engine && renderedKey.get(sid) !== key) {
        const threaded = (source.flow?.recipients.length ?? 0) > 0;
        if (threaded) {
          const out = await bakeWebFlows(host, f.id, engine);
          const got = present.filter((_, i) => out.layers[i] != null).map((fr) => fr.id);
          layerFrames.set(sid, got);
        } else {
          const width = size.get(sid)?.split("x")[0] ?? "";
          const growKey = `${f.label}|${width}`;
          const allowGrow = reason === "change" && grewFor.get(sid) !== growKey;
          grewFor.set(sid, growKey);
          const out = await bakeWebFrame(host, f.id, engine, { allowGrow });
          layerFrames.set(sid, out.submitted ? [sid] : []);
        }
        // A grow resizes the frame: its key is recomputed on the pass the
        // resize triggers.
        renderedKey.set(sid, key);
      }
      for (const id of layerFrames.get(sid) ?? []) keep.add(id);
    }

    // Forget sources that are gone, then clear every layer nobody keeps.
    for (const sid of [...renderedKey.keys()]) {
      if (!live.has(sid)) {
        renderedKey.delete(sid);
        layerFrames.delete(sid);
        grewFor.delete(sid);
      }
    }
    if (engine) {
      for (const id of [...framesWithLayers(host)]) {
        if (!keep.has(id)) await surface.clear(id);
      }
    }
    if (sources.size > 256) sources = new Map();
    for (const l of listeners) l(lastLabels);
  }

  function run(reason: ReconcileReason): Promise<void> {
    const prev = running ?? Promise.resolve();
    const next = prev
      .then(() => (disposed ? undefined : pass(reason)))
      .catch((err: unknown) => {
        host.log.warn(`auto render: ${err instanceof Error ? err.message : String(err)}`);
      });
    running = next;
    void next.then(() => {
      if (running === next) running = null;
    });
    return next;
  }

  function schedule(reason: ReconcileReason, delay = debounceMs): void {
    if (disposed) return;
    pendingReason = merge(pendingReason, reason);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const r = pendingReason ?? "change";
      pendingReason = null;
      void run(r);
    }, delay);
  }

  const docSub = host.document.onDidChange((e) => {
    schedule(e.kind === "mutationApplied" ? "change" : "undo");
  });

  // A newly loaded document: its layers start empty and its sources are new.
  let offLoaded: (() => void) | null = null;
  try {
    offLoaded = host.editor.client.subscribe((msg) => {
      if (msg.kind !== "documentLoaded") return;
      renderedKey = new Map();
      layerFrames = new Map();
      grewFor = new Map();
      lastLabels = new Map();
      sources = new Map();
      framesWithLayers(host).clear();
      schedule("open", 0);
    });
  } catch {
    // No raw client on this host: activation's pass is the only open pass.
  }

  schedule("open", 0);

  const renderer: AutoRenderer = {
    reconcile: (reason) => run(reason),
    async idle() {
      for (;;) {
        if (timer) {
          await new Promise((r) => setTimeout(r, debounceMs + 5));
          continue;
        }
        if (running) {
          await running;
          continue;
        }
        return;
      }
    },
    labels: () => lastLabels,
    onDidReconcile(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      docSub.dispose();
      offLoaded?.();
      listeners.clear();
      renderers.delete(host);
    },
  };
  renderers.set(host, renderer);
  return renderer;
}
