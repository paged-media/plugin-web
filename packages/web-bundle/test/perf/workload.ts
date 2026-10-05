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

// The paged.web perf workloads: the sources (built in code, mirroring
// web-render's tests/common/workloads.rs), the web-frame inserter, and the
// REAL engine wasm wrapped so every call across the wasm boundary — and the
// bytes it carries — is counted on the TS side.
//
// Two artifacts can answer:
//   · the BUNDLED engine `bin/blitz_web*` (`scripts/build-wasm.sh --engine`)
//     — what the gated budgets need;
//   · the COUNTING engine `packages/web-render/target/perf-wasm/`
//     (`scripts/build-wasm-perf.sh`, feature `perf-counters`) — when present
//     it is used instead and its engine-internal counters (parses,
//     resolves, paint captures, …) join the PERF_SHOW line. Same code, same
//     output, so the gated counts do not depend on which one answered.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { envelopeFor, type WebFrameSource } from "@paged-media/web-model";

import {
  _resetWebEngineCache,
  loadWebEngine,
  type WebEngine,
} from "../../src/engine-loader";

const binDir = fileURLToPath(new URL("../../bin/", import.meta.url));
const perfDir = fileURLToPath(
  new URL("../../../web-render/target/perf-wasm/", import.meta.url),
);

export const bundledWasm = binDir + "blitz_web_bg.wasm";
export const bundledPresent =
  existsSync(binDir + "blitz_web.js") && existsSync(bundledWasm);
const countingPresent =
  existsSync(perfDir + "blitz_web.js") && existsSync(perfDir + "blitz_web_bg.wasm");

interface Glue {
  default: (init?: unknown) => Promise<unknown>;
  initSync: (m: { module: Uint8Array }) => unknown;
  render_web_frame: (html: string, w: number, h: number) => string;
  render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
  perf_counters?: () => string;
  perf_counters_reset?: () => void;
}

/** What crossed the wasm boundary, counted on the TS side. */
export interface BoundaryStats {
  /** Wasm instantiations (`initSync`) — the cold boots. */
  boots: number;
  /** Engine loads the bundle's loader asked for (`importGlue`). */
  loaderImports: number;
  frameCalls: number;
  flowCalls: number;
  /** UTF-8 bytes handed in (html + frames JSON + flow root). */
  bytesIn: number;
  /** UTF-8 bytes of JSON handed back. */
  bytesOut: number;
  /** Wall-clock of the cold boot, ms (info, not gated). */
  bootMs: number;
  /** The last JSON the engine handed back — what the command would submit
   *  (the headless host wires no scene channel, so `submit` is not reached;
   *  the behaviour assertions read the layer here instead). */
  lastOutput: string;
}

export interface EngineLane {
  /** The engine as the bundle sees it (also primed into `loadWebEngine`). */
  engine: WebEngine;
  stats: BoundaryStats;
  /** Which artifact answered. */
  artifact: "bundled" | "counting";
  /** Zero the boundary counts (boots/loaderImports are kept). */
  resetCalls(): void;
  /** Engine-internal counters (counting artifact only), else null. */
  engineCounters(): Record<string, number> | null;
}

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Boot the real engine ONCE, wrap it, and prime the bundle's memoized loader
 * with the wrapped glue — so the commands under test (which call
 * `loadWebEngine(host)` themselves) go through the counted boundary.
 */
export async function bootEngine(host: BundleHost): Promise<EngineLane> {
  const dir = countingPresent ? perfDir : binDir;
  const glue = (await import(new URL(dir + "blitz_web.js", "file://").href)) as Glue;
  const stats: BoundaryStats = {
    boots: 0,
    loaderImports: 0,
    frameCalls: 0,
    flowCalls: 0,
    bytesIn: 0,
    bytesOut: 0,
    bootMs: 0,
    lastOutput: "",
  };
  const t0 = performance.now();
  glue.initSync({ module: readFileSync(dir + "blitz_web_bg.wasm") });
  stats.bootMs = performance.now() - t0;
  stats.boots += 1;

  const counted = {
    default: glue.default,
    render_web_frame: (html: string, w: number, h: number): string => {
      stats.frameCalls += 1;
      stats.bytesIn += utf8(html);
      const out = glue.render_web_frame(html, w, h);
      stats.bytesOut += utf8(out);
      stats.lastOutput = out;
      return out;
    },
    render_web_flow: (html: string, framesJson: string, flowRoot: string): string => {
      stats.flowCalls += 1;
      stats.bytesIn += utf8(html) + utf8(framesJson) + utf8(flowRoot);
      const out = glue.render_web_flow(html, framesJson, flowRoot);
      stats.bytesOut += utf8(out);
      stats.lastOutput = out;
      return out;
    },
  };

  _resetWebEngineCache();
  const engine = await loadWebEngine(host, {
    importGlue: async () => {
      stats.loaderImports += 1;
      return counted as never;
    },
  });
  if (!engine) throw new Error("the real engine failed to load through the bundle loader");

  return {
    engine,
    stats,
    artifact: countingPresent ? "counting" : "bundled",
    resetCalls: () => {
      stats.frameCalls = 0;
      stats.flowCalls = 0;
      stats.bytesIn = 0;
      stats.bytesOut = 0;
      stats.lastOutput = "";
      glue.perf_counters_reset?.();
    },
    engineCounters: () =>
      glue.perf_counters ? (JSON.parse(glue.perf_counters()) as Record<string, number>) : null,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const FILLER =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod " +
  "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim " +
  "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.";

const source = (html: string, css: string): WebFrameSource => ({
  html,
  css,
  options: { media: "print", overflow: "clip" },
});

/** A 40-paragraph article; paragraph `i` opens with the marker `Pnn X`. */
export function article(paragraphs = 40): WebFrameSource {
  let html = "";
  for (let i = 0; i < paragraphs; i++) {
    html += `<p>P${String(i).padStart(2, "0")}X ${FILLER}</p>`;
  }
  return source(html, "body{margin:0;font-size:16px;line-height:24px}p{margin:0 0 8px 0}");
}
export const articleMarker = (i: number): string => `P${String(i).padStart(2, "0")}X`;
export const ARTICLE_WORDS_PER_PARA = 1 + FILLER.split(/\s+/).length;

/** `n` small blocks in a wrapping flex grid — each its own inline formatting
 *  context, so each paints (and bakes) as exactly one text run `Wnnn`. */
export function runGrid(n = 200): WebFrameSource {
  let html = '<div class="g">';
  for (let i = 0; i < n; i++) html += `<span>W${String(i).padStart(3, "0")}</span>`;
  html += "</div>";
  return source(
    html,
    "body{margin:0;font-size:10px;line-height:14px}" +
      ".g{display:flex;flex-wrap:wrap}.g span{width:56px}",
  );
}
export const runMarker = (i: number): string => `W${String(i).padStart(3, "0")}`;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Must equal the host's derived key (`x-paged:<manifest.id>`). */
const METADATA_KEY = "x-paged:media.paged.web";

/**
 * Insert a web frame at `bounds` (page pt, [top, left, bottom, right]) with
 * `src` attached — the same one-batch shape the insert command uses, at a
 * chosen size. Through the UNCOUNTED host: setup is not the workload.
 */
export async function insertWebFrameAt(
  host: BundleHost,
  pageId: string,
  bounds: [number, number, number, number],
  src: WebFrameSource,
): Promise<ElementId> {
  const out = await host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op: "insertFrame", args: { pageId, bounds } },
        {
          op: "setPluginMetadata",
          args: {
            elementId: { kind: "rectangle", id: "$created" },
            key: METADATA_KEY,
            value: JSON.stringify(envelopeFor(src)),
          },
        },
      ],
    },
  } as never);
  if (!out.applied || !out.createdId) {
    throw new Error(`insertWebFrameAt rejected: ${JSON.stringify(out)}`);
  }
  return out.createdId;
}

/** Every C-1 text item's words in a submitted layer. */
export function layerWords(layer: unknown): string[] {
  const items = (layer as { items?: unknown[] } | null)?.items ?? [];
  const words: string[] = [];
  for (const it of items) {
    const t = (it as { kind?: string; text?: unknown }).text;
    if ((it as { kind?: string }).kind === "text" && typeof t === "string") {
      words.push(...t.split(/\s+/).filter((w) => w.length > 0));
    }
  }
  return words;
}
