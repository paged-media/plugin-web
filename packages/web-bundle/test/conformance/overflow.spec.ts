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

// Overflow policies against the real host and the real Blitz engine: a
// source taller than its frame is clipped, shrunk to fit, grows the frame,
// or (thread) is reported as continuing past an unthreaded frame.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BundleHost, CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type OverflowPolicy, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { bakeWebFrame } from "../../src/bake";
import { writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { blitzPresent, layerText, maxTextY, primeBlitz, recordScene, requireBlitz, type SceneRecord } from "./blitz";
import { openHost } from "./host";
import type { WebEngine } from "../../src/engine-loader";

requireBlitz("web conformance — overflow policies");

const PARAS = Array.from({ length: 12 }, (_, i) => `Para${i + 1} lorem ipsum`);
const tall = (overflow: OverflowPolicy): WebFrameSource => ({
  ...DEFAULT_SOURCE,
  html: PARAS.map((p) => `<p>${p}</p>`).join(""),
  css: "body{margin:0} p{margin:0 0 8px;font-size:16px;line-height:20px}",
  options: { media: "print", overflow },
});

const FRAME_H_PT = 120;

describe.skipIf(!blitzPresent)("web conformance — overflow policies (real host + real Blitz)", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let engine: WebEngine;
  let rec: SceneRecord;

  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    rec = recordScene(h);
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    engine = await primeBlitz(host);
  });
  afterAll(() => h?.dispose());

  async function frameWith(source: WebFrameSource): Promise<ElementId> {
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 60 + FRAME_H_PT, 300] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame created");
    const id = out.createdId as ElementId;
    const w = await writeWebSource(host, id, source);
    if (!w.applied) throw new Error(`source not written: ${w.reason}`);
    return id;
  }
  const idOf = (id: ElementId) => (id as { id: string }).id;
  const heightOf = async (id: ElementId) => {
    const [g] = await host.document.elementGeometry([id]);
    return g.bounds[2] - g.bounds[0];
  };

  it("clip: the frame shows the first paragraphs only", async () => {
    const id = await frameWith(tall("clip"));
    const out = await bakeWebFrame(host, id, engine);
    expect(out.submitted).toBe(true);
    const text = layerText(rec.layers.get(idOf(id)));
    expect(text).toContain("Para1 ");
    expect(text).not.toContain("Para12");
    expect(await heightOf(id)).toBeCloseTo(FRAME_H_PT, 3);
  });

  it("shrink: every paragraph is painted, inside the frame, smaller", async () => {
    const id = await frameWith(tall("shrink"));
    await bakeWebFrame(host, id, engine);
    const layer = rec.layers.get(idOf(id));
    for (const p of PARAS) expect(layerText(layer)).toContain(p.split(" ")[0]);
    expect(maxTextY(layer)).toBeLessThanOrEqual(FRAME_H_PT);
    const size = (layer!.items.find((i) => i.kind === "text") as { size: number }).size;
    expect(size).toBeLessThan(12); // 16px = 12pt unscaled
    expect(await heightOf(id)).toBeCloseTo(FRAME_H_PT, 3);
  });

  it("shrink: content that already fits is not scaled", async () => {
    const id = await frameWith({ ...tall("shrink"), html: "<p>Short</p>" });
    await bakeWebFrame(host, id, engine);
    const size = (rec.layers.get(idOf(id))!.items.find((i) => i.kind === "text") as { size: number }).size;
    expect(size).toBeCloseTo(12, 1);
  });

  it("grow: the frame's height becomes the content's, and every paragraph shows", async () => {
    const id = await frameWith(tall("grow"));
    await bakeWebFrame(host, id, engine);
    const grown = await heightOf(id);
    expect(grown).toBeGreaterThan(FRAME_H_PT);
    const layer = rec.layers.get(idOf(id));
    for (const p of PARAS) expect(layerText(layer)).toContain(p.split(" ")[0]);
    expect(maxTextY(layer)).toBeLessThanOrEqual(grown);
    // Stable: rendering again does not move the frame.
    await bakeWebFrame(host, id, engine);
    expect(await heightOf(id)).toBeCloseTo(grown, 3);
  });

  it("grow: the resize is one undo step", async () => {
    const id = await frameWith(tall("grow"));
    await bakeWebFrame(host, id, engine);
    expect(await heightOf(id)).toBeGreaterThan(FRAME_H_PT);
    await host.document.undo();
    expect(await heightOf(id)).toBeCloseTo(FRAME_H_PT, 3);
  });

  it("grow: a frame taller than its content shrinks to it", async () => {
    const id = await frameWith({ ...tall("grow"), html: "<p>One line</p>" });
    await bakeWebFrame(host, id, engine);
    const h1 = await heightOf(id);
    expect(h1).toBeLessThan(FRAME_H_PT);
    expect(h1).toBeGreaterThan(10);
  });

  it("thread on an unthreaded frame: clipped, and a warning says to thread it", async () => {
    const id = await frameWith(tall("thread"));
    const out = await bakeWebFrame(host, id, engine);
    expect(layerText(rec.layers.get(idOf(id)))).not.toContain("Para12");
    expect(out.diagnostics.some((d) => d.severity === "warning" && /thread/i.test(d.message))).toBe(true);
  });

  it("the render command honours the policy too", async () => {
    const id = await frameWith(tall("shrink"));
    await host.selection.set([id]);
    const c = h.contributions.find((x) => x.kind === "command" && x.id === "media.paged.web.command.renderWebFrame");
    await (c!.value as CommandContribution).handler(undefined);
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Para12");
  });

  // DEFECT (web-render flow.rs, last-frame overset): the remainder's bottom
  // includes the transparent canvas background that fills the whole
  // measuring viewport, so a one-frame flow of one short paragraph reports
  // overset. overflow.ts measures from the paint instead. Flips when the
  // flow ignores viewport-filling items.
  it("a one-frame flow of content that fits is not overset (was a pinned defect)", () => {
    const html =
      "<!doctype html><html><head><style>body{margin:0}</style></head><body><p>Short</p></body></html>";
    const flow = engine.renderFlow(html, [{ widthPx: 320, heightPx: 160 }]);
    expect(flow?.overset).toBe(false);
  });
});
