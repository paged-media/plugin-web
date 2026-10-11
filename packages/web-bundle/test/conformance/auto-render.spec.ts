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

// The canvas follows the document by itself — against the real host and the
// real Blitz engine: web frames render on activation and on document open,
// re-render after a save, an undo and a resize (never after a move or an
// unrelated edit), and a frame that leaves a flow or is deleted is cleared.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { autoRendererFor } from "../../src/auto-render";
import { loadWebSource, writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { blitzPresent, layerText, primeBlitz, recordScene, requireBlitz, type SceneRecord } from "./blitz";
import { openHost } from "./host";

requireBlitz("web conformance — auto render");

const src = (html: string, extra: Partial<WebFrameSource> = {}): WebFrameSource => ({
  ...DEFAULT_SOURCE,
  html,
  css: "body{margin:0} p{margin:0 0 6px;font-size:16px;line-height:20px}",
  ...extra,
});
const idOf = (id: ElementId) => (id as { id: string }).id;

describe.skipIf(!blitzPresent)("web conformance — auto render (real host + real Blitz)", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let rec: SceneRecord;
  let bundle: { dispose(): void };

  async function boot(): Promise<void> {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    rec = recordScene(h);
    await primeBlitz(h.host as unknown as BundleHost);
    bundle = h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    // Let activation's open pass finish (an edit merged into it would not
    // be allowed to grow a frame, by design).
    await autoRendererFor(host)!.idle();
  }
  const idle = () => autoRendererFor(host)!.idle();

  async function webFrame(html: string, extra: Partial<WebFrameSource> = {}, top = 60): Promise<ElementId> {
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [top, 60, top + 120, 300] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    const id = out.createdId as ElementId;
    if (html) {
      const w = await writeWebSource(host, id, src(html, extra));
      if (!w.applied) throw new Error(`not written: ${w.reason}`);
    }
    await idle();
    return id;
  }
  const fire = async (cmd: string) => {
    const c = h.contributions.find((x) => x.kind === "command" && x.id === `media.paged.web.command.${cmd}`);
    await (c!.value as CommandContribution).handler(undefined);
    await idle();
  };
  const submitsOf = (id: ElementId) => rec.submits.filter((s) => s === idOf(id)).length;

  beforeEach(boot);
  afterEach(() => h?.dispose());

  it("a saved source renders without any command, and re-renders after the next save", async () => {
    const id = await webFrame("<p>First save</p>");
    expect(layerText(rec.layers.get(idOf(id)))).toContain("First");
    await writeWebSource(host, id, src("<p>Second save</p>"));
    await idle();
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Second");
  });

  it("undo of a save re-renders the previous source", async () => {
    const id = await webFrame("<p>Before</p>");
    await writeWebSource(host, id, src("<p>After</p>"));
    await idle();
    await host.document.undo();
    await idle();
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Before");
  });

  it("a resize re-renders; a move and an unrelated edit do not", async () => {
    const id = await webFrame("<p>Resize me</p>");
    const before = submitsOf(id);
    await host.document.mutate({ op: "moveFrame", args: { frameId: idOf(id), transform: [1, 0, 0, 1, 30, 40] } });
    await host.document.mutate({ op: "insertFrame", args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [400, 60, 450, 120] } } as never);
    await idle();
    expect(submitsOf(id)).toBe(before);
    const [g] = await host.document.elementGeometry([id]);
    const b = g.bounds;
    await host.document.mutate({ op: "resizeFrame", args: { frameId: idOf(id), bounds: [b[0], b[1], b[2], b[3] - 100] } });
    await idle();
    expect(submitsOf(id)).toBe(before + 1);
  });

  it("re-rendering is skipped when nothing the frame shows changed", async () => {
    const id = await webFrame("<p>Stable</p>");
    const before = submitsOf(id);
    await autoRendererFor(host)!.reconcile("change");
    expect(submitsOf(id)).toBe(before);
  });

  it("activation renders the web frames a document already has", async () => {
    const id = await webFrame("<p>Reopened</p>");
    // Deactivate (disposing the bundle clears its layers) and activate again.
    bundle.dispose();
    rec.layers.clear();
    bundle = h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    await idle();
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Reopened");
  });

  it("opening another document renders its web frames", async () => {
    // The host reports opens through document.onDidOpen, which the bundle
    // follows (test/auto-render.spec.ts covers the raw-broadcast fallback).
    expect(host.supports("document.onDidOpen@1")).toBe(true);
    await webFrame("<p>In doc one</p>");
    // A new document in the same session, opened for real.
    await h.load(W1_EMPTY_PAGE.bytes());
    await idle();
    expect(autoRendererFor(host)!.labels().size).toBe(0);
    rec.layers.clear();
    // The same frame again: what was rendered in the old document must not
    // count as rendered in this one.
    const id = await webFrame("<p>In doc one</p>");
    expect(layerText(rec.layers.get(idOf(id)))).toContain("In doc one");
  });

  it("a threaded recipient renders; unthreading clears it", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `<p>Line${i + 1} of the flow</p>`).join("");
    const source = await webFrame(many);
    const recipient = await webFrame("", {}, 300);
    await host.selection.set([source, recipient]);
    await fire("threadWebFlow");
    expect(layerText(rec.layers.get(idOf(recipient)))).toMatch(/Line\d+/);
    await host.selection.set([source, recipient]);
    await fire("unthreadWebFlow");
    expect(rec.layers.has(idOf(recipient))).toBe(false);
    expect(rec.clears).toContain(idOf(recipient));
  });

  it("deleting a recipient clears it and re-renders the flow without it", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `<p>Line${i + 1} of the flow</p>`).join("");
    const source = await webFrame(many);
    const recipient = await webFrame("", {}, 300);
    await host.selection.set([source, recipient]);
    await fire("threadWebFlow");
    const before = submitsOf(source);
    await host.document.mutate({ op: "deleteFrame", args: { frameId: idOf(recipient) } });
    await idle();
    expect(rec.layers.has(idOf(recipient))).toBe(false);
    expect(submitsOf(source)).toBeGreaterThan(before);
    // The source still names the recipient (undo of the delete brings it back).
    expect((await loadWebSource(host, source))?.flow?.recipients.length).toBe(1);
  });

  it("deleting a web frame clears its layer", async () => {
    const id = await webFrame("<p>Doomed</p>");
    await host.document.mutate({ op: "deleteFrame", args: { frameId: idOf(id) } });
    await idle();
    expect(rec.layers.has(idOf(id))).toBe(false);
  });

  it("grow: undoing the resize sticks (the canvas does not grow it back)", async () => {
    const many = Array.from({ length: 14 }, (_, i) => `<p>Line${i + 1}</p>`).join("");
    const id = await webFrame(many, { options: { media: "print", overflow: "grow" } });
    const [grown] = await host.document.elementGeometry([id]);
    expect(grown.bounds[2] - grown.bounds[0]).toBeGreaterThan(120);
    await host.document.undo();
    await idle();
    const [after] = await host.document.elementGeometry([id]);
    expect(after.bounds[2] - after.bounds[0]).toBeCloseTo(120, 3);
  });
});
