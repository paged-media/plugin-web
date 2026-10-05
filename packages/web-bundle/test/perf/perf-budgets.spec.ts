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

// Count budgets for the paged.web bundle — every host door call, every wasm
// call and every byte across the wasm boundary, per command, against the
// REAL headless host (createHeadlessHost + real canvas-wasm) and the REAL
// Blitz engine wasm. Budgets are the MEASURED counts (2026-10-05), each
// beside a behaviour assertion; an optimisation lowers a pin in the commit
// that earns it, and a pin is never raised. Wall-clock is printed, not
// gated. `PERF_SHOW=1` prints one `PERF` line per scenario.
//
// The baseline shows Wave 2's targets on the host side: a bake spends ~7
// awaited door calls per text run, two of them full `stories` reads (rows
// read grow with the SQUARE of the runs), one `mutate` per item; the panel's
// font watch re-reads the whole `fonts` collection on EVERY document change.
//
// Engine artifact: skipped with a reason when `bin/blitz_web*` is absent,
// FAILED when REQUIRE_REAL_ENGINE=1 (CI builds it first).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { webBundle } from "../../src";
import { bakeSelectedWebFrame } from "../../src/bake-to-document";
import { renderSelectedWebFrame } from "../../src/render-command";
import { renderSelectedWebFlow } from "../../src/render-flow-command";
import { watchDocumentFonts } from "../../src/panels/font-watch";
import { openHost } from "../conformance/host";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { BUDGET_TIMEOUT_MS, countingHost, report, settle } from "./counting-host";
import {
  ARTICLE_WORDS_PER_PARA,
  article,
  articleMarker,
  bootEngine,
  bundledPresent,
  bundledWasm,
  insertWebFrameAt,
  layerWords,
  runGrid,
  type EngineLane,
} from "./workload";

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS, hookTimeout: BUDGET_TIMEOUT_MS });

if (process.env.REQUIRE_REAL_ENGINE === "1" && !bundledPresent) {
  describe("web perf budgets — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the engine artifact is missing", () => {
      throw new Error(
        `REQUIRE_REAL_ENGINE=1 but ${bundledWasm} (or its glue) is missing — ` +
          "build it with `bash scripts/build-wasm.sh --engine`",
      );
    });
  });
}
if (!bundledPresent) {
  // eslint-disable-next-line no-console
  console.info(
    "web perf budgets SKIPPED: no engine artifact (bash scripts/build-wasm.sh --engine)",
  );
}

const PAGE = W1_EMPTY_PAGE.pageId;
const ARTICLE_PARAS = 40;
const FLOW_FRAMES = 12;
const RUNS = 200;
const CHANGES = 1000;

/** The full article wraps to ~6 000 px at 400 px; 12 frames of 375 pt
 *  (500 px) hold it — the same geometry as the Rust flow budget. */
const FLOW_FRAME_W_PT = 300;
const FLOW_FRAME_H_PT = 375;


const eachOnce = (ws: string[], markers: string[]): void => {
  for (const m of markers) {
    expect(ws.filter((w) => w === m).length, `marker ${m}`).toBe(1);
  }
};

describe.skipIf(!bundledPresent)("web perf budgets (real host + real Blitz)", () => {
  let h: HeadlessHost;
  let lane: EngineLane;

  const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
    const t0 = performance.now();
    const out = await f();
    return [out, Math.round(performance.now() - t0)];
  };

  const boundary = (): Record<string, unknown> => ({
    wasm: {
      frameCalls: lane.stats.frameCalls,
      flowCalls: lane.stats.flowCalls,
      bytesIn: lane.stats.bytesIn,
      bytesOut: lane.stats.bytesOut,
    },
    engine: lane.engineCounters(),
    artifact: lane.artifact,
  });

  const select = async (host: BundleHost, ids: ElementId[]): Promise<void> => {
    await host.selection.set(ids);
  };

  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    h.loadBundle(webBundle);
    lane = await bootEngine(h.host);
  });
  afterAll(() => h?.dispose());

  it(`render one frame (${ARTICLE_PARAS}-paragraph article) [plugin-web.perf-budgets]`, async () => {
    const frame = await insertWebFrameAt(h.host, PAGE, [36, 36, 756, 336], article(ARTICLE_PARAS));
    await select(h.host, [frame]);
    lane.resetCalls();
    const { host, work } = countingHost(h.host);

    const [, ms] = await timed(() => renderSelectedWebFrame(host));
    await settle();
    report("render-frame", work, { ...boundary(), ms });

    // Behaviour: the frame rendered to a layer carrying the article's top.
    // (The headless host wires no scene channel, so `submit` is not reached:
    // in the editor it adds ONE door call here.)
    expect(layerWords(JSON.parse(lane.stats.lastOutput))).toContain(articleMarker(0));

    expect(work.total()).toBe(BUDGET.renderFrame.doorCalls);
    expect(work.reads()).toBe(BUDGET.renderFrame.reads);
    expect(work.mutations.length).toBe(0);
    expect(lane.stats.frameCalls).toBe(1);
    expect(lane.stats.bytesIn).toBeLessThanOrEqual(BUDGET.renderFrame.bytesIn);
    expect(lane.stats.bytesOut).toBeLessThanOrEqual(BUDGET.renderFrame.bytesOut);
  });

  it(`render one flow into ${FLOW_FRAMES} frames [plugin-web.perf-budgets]`, async () => {
    const ids: ElementId[] = [];
    for (let i = 0; i < FLOW_FRAMES; i++) {
      const left = 36 + (i % 2) * 280;
      ids.push(
        await insertWebFrameAt(
          h.host,
          PAGE,
          [36, left, 36 + FLOW_FRAME_H_PT, left + FLOW_FRAME_W_PT],
          i === 0 ? article(ARTICLE_PARAS) : { html: "", css: "", options: { media: "print", overflow: "clip" } },
        ),
      );
    }
    // Thread the chain through the bundle's own command (setup, uncounted).
    await select(h.host, ids);
    const thread = h.contributions.find(
      (c) => c.kind === "command" && c.id === "media.paged.web.command.threadWebFlow",
    )!.value as { handler: (a: unknown) => unknown };
    await thread.handler(undefined);

    await select(h.host, [ids[0]]);
    lane.resetCalls();
    const { host, work } = countingHost(h.host);
    const [, ms] = await timed(() => renderSelectedWebFlow(host));
    await settle();
    report("render-flow-12", work, { ...boundary(), ms });

    // Behaviour: one layer per frame; every paragraph's words land exactly
    // once across the chain (text conserved, nothing duplicated or lost).
    // (No scene channel headlessly: in the editor each frame's layer adds
    // one `submit` door call, i.e. +12 here.)
    const flow = JSON.parse(lane.stats.lastOutput) as { frames: { layer: unknown }[] };
    expect(flow.frames.length).toBe(FLOW_FRAMES);
    const ws = flow.frames.flatMap((f) => layerWords(f.layer));
    expect(ws.length).toBe(ARTICLE_PARAS * ARTICLE_WORDS_PER_PARA);
    eachOnce(ws, Array.from({ length: ARTICLE_PARAS }, (_v, i) => articleMarker(i)));

    expect(work.total()).toBe(BUDGET.renderFlow.doorCalls);
    expect(work.reads()).toBe(BUDGET.renderFlow.reads);
    expect(work.mutations.length).toBe(0);
    expect(lane.stats.flowCalls).toBe(1);
    expect(lane.stats.bytesIn).toBeLessThanOrEqual(BUDGET.renderFlow.bytesIn);
    expect(lane.stats.bytesOut).toBeLessThanOrEqual(BUDGET.renderFlow.bytesOut);
  });

  it(`bake a frame of ${RUNS} text runs to native content [plugin-web.perf-budgets]`, async () => {
    const frame = await insertWebFrameAt(h.host, PAGE, [36, 36, 756, 576], runGrid(RUNS));
    await select(h.host, [frame]);
    const storiesBefore = (await h.host.document.collection("stories")).length;
    lane.resetCalls();
    const { host, work } = countingHost(h.host);

    const [, ms] = await timed(() => bakeSelectedWebFrame(host));
    await settle();
    report("bake-200-runs", work, { ...boundary(), ms });

    // Behaviour: one native story per run, carrying the run's text …
    const after = await h.host.document.collection<{ characterCount: number }>("stories");
    expect(after.length - storiesBefore).toBe(RUNS);
    expect(after.slice(-RUNS).every((s) => s.characterCount > 0)).toBe(true);

    const b = BUDGET.bake;
    expect(work.total()).toBe(b.doorCalls);
    expect(work.count("document.mutate")).toBe(b.mutates);
    expect(work.count("document.collection")).toBe(b.collections);
    expect(work.count("document.collection:stories")).toBe(b.storiesReads);
    expect(work.rowsRead.stories ?? 0).toBe(b.storyRowsRead);
    // The linear shape, stated: one measurement per run, everything else
    // a constant — the whole bake is ONE batch.
    expect(work.count("text.measureString")).toBe(RUNS);
    expect(work.mutations).toEqual([{ op: "batch", ops: b.batchOps }]);
    expect(lane.stats.frameCalls).toBe(1);

    // … and the whole bake is ONE undo step: one undo removes every story.
    await h.host.document.undo();
    expect((await h.host.document.collection("stories")).length).toBe(storiesBefore);
    await h.host.document.redo();
    expect((await h.host.document.collection("stories")).length).toBe(storiesBefore + RUNS);
  });

  it(`${CHANGES} document changes with the panel's font watch live [plugin-web.perf-budgets]`, async () => {
    const target = await insertWebFrameAt(h.host, PAGE, [700, 500, 740, 560], runGrid(1));
    const { host, work } = countingHost(h.host);
    let updates = 0;
    const sub = watchDocumentFonts(host, () => {
      updates += 1;
    });
    let changes = 0;
    const seen = h.host.document.onDidChange(() => {
      changes += 1;
    });

    const [, ms] = await timed(async () => {
      for (let i = 0; i < CHANGES; i++) {
        // Ordinary editing elsewhere in the document — through the
        // UNCOUNTED host: only the watch's own reads are the workload.
        await h.host.document.mutate({
          op: "setElementProperty",
          args: {
            elementId: target,
            path: "frameFillColor",
            value: { type: "colorRef", value: "Color/Black" },
          },
        } as never);
      }
      await settle();
    });
    seen.dispose();
    sub.dispose();
    report(`font-watch-${CHANGES}-changes`, work, { changes, updates, ms });

    // Behaviour: the watch delivered the families after every change.
    expect(changes).toBe(CHANGES);
    expect(updates).toBe(CHANGES + 1);

    expect(work.count("document.collection:fonts")).toBe(BUDGET.fontWatch.fontsReads);
    expect(work.total()).toBe(BUDGET.fontWatch.doorCalls);
  });

  it("cold boot: the engine instantiates once across every command [plugin-web.perf-budgets]", () => {
    report("cold-boot", countingHost(h.host).work, {
      boots: lane.stats.boots,
      loaderImports: lane.stats.loaderImports,
      bootMs: Math.round(lane.stats.bootMs),
    });
    expect(lane.stats.boots).toBe(BUDGET.coldBoot.boots);
    expect(lane.stats.loaderImports).toBe(BUDGET.coldBoot.loaderImports);
  });
});

// --- the pins (measured 2026-10-05) ----------------------------------------

const BUDGET = {
  renderFrame: { doorCalls: 8, reads: 2, bytesIn: 8936, bytesOut: 12788 },
  // 9 / 1 before the single source reader (ADR 409): it also reads the
  // pre-pointer part of a frame, so an old document's larger source wins.
  renderFlow: { doorCalls: 11, reads: 3, bytesIn: 9309, bytesOut: 78153 },
  // Was 1410 / 801 / 400 / 400 / 40000 (one story-diffing mutate chain per
  // run, 801 undo steps). Now ONE batch of 5 ops per run + 1 swatch, story
  // ids through `bindCreated` handles; the one collection read is the
  // swatches (an existing swatch is not re-created).
  bake: {
    doorCalls: 211,
    mutates: 1,
    batchOps: 1001,
    collections: 1,
    storiesReads: 0,
    storyRowsRead: 0,
  },
  fontWatch: { fontsReads: 1001, doorCalls: 1003 },
  coldBoot: { boots: 1, loaderImports: 1 },
} as const;

