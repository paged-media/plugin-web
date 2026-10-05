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

// In-frame text editing against the real host and the real Blitz engine:
// enter the web frame's edit context, click its rendered text, type —
// the frame re-renders live from the edited source, Enter writes it as one
// undoable step with markup and entities intact, Esc restores, Cmd+Z steps
// the keystrokes, and text a template produced is refused.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, EditContextContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { autoRendererFor } from "../../src/auto-render";
import { inFrameSessionFor } from "../../src/in-frame-edit";
import { highlightOutlineEntry, onCanvasPick } from "../../src/outline-highlight";
import { loadWebSource, writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { blitzPresent, layerText, primeBlitz, recordScene, requireBlitz, type SceneRecord } from "./blitz";
import { openHost } from "./host";

requireBlitz("web conformance — in-frame edit");

const src = (html: string, extra: Partial<WebFrameSource> = {}): WebFrameSource => ({
  ...DEFAULT_SOURCE,
  html,
  css: "body{margin:0} p{margin:0;font-size:16px;line-height:20px}",
  ...extra,
});
const idOf = (id: ElementId) => (id as { id: string }).id;
const key = (k: string, mods: { metaKey?: boolean } = {}) =>
  ({ key: k, metaKey: !!mods.metaKey, ctrlKey: false, altKey: false, preventDefault() {} }) as unknown as KeyboardEvent;

describe.skipIf(!blitzPresent)("web conformance — in-frame edit (real host + real Blitz) @feat:plugin-web.in-frame-edit", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let rec: SceneRecord;
  let ctx: EditContextContribution;

  beforeEach(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    rec = recordScene(h);
    await primeBlitz(h.host as unknown as BundleHost);
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    await autoRendererFor(host)!.idle();
    ctx = h.editContextsContributed().find((c) => c.type === "webFrame") as EditContextContribution;
  });
  afterEach(() => h?.dispose());

  async function enter(html: string, extra: Partial<WebFrameSource> = {}): Promise<ElementId> {
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 180, 300] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    const id = out.createdId as ElementId;
    expect((await writeWebSource(host, id, src(html, extra))).applied).toBe(true);
    await autoRendererFor(host)!.idle();
    ctx.onEnter?.({ type: "webFrame", id });
    return id;
  }
  const session = () => inFrameSessionFor(host)!;
  async function click(x: number, y: number) {
    ctx.onContentPointerDown?.({ contentPoint: [x, y], elementId: "", modifiers: { shift: false, alt: false, cmd: false, ctrl: false }, button: 0 });
    // The press is handled asynchronously (it may render the frame first).
    for (let i = 0; i < 50 && !session().isEditing(); i += 1) await new Promise((r) => setTimeout(r, 10));
  }
  const type = (text: string) => {
    for (const ch of text) ctx.onContentKey?.(key(ch));
  };

  it("click places a caret, typing re-renders live, Enter writes one undoable step", async () => {
    const id = await enter("<p>Hello world</p>");
    await click(1, 8);
    expect(ctx.isDirty?.()).toBe(true);
    expect(session().state()).toMatchObject({ node: 0, caret: 0, text: "Hello world" });
    const overlay = h.lastToolPreviews();
    expect(overlay && overlay.length).toBe(1); // the caret
    type("Big ");
    await session().idle();
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Big");
    expect((await loadWebSource(host, id))!.html).toBe("<p>Hello world</p>"); // not written yet
    ctx.onContentKey?.(key("Enter"));
    for (let i = 0; i < 50 && session().isEditing(); i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    expect((await loadWebSource(host, id))!.html).toBe("<p>Big Hello world</p>");
    expect(ctx.isDirty?.()).toBe(false);
    await host.document.undo();
    expect((await loadWebSource(host, id))!.html).toBe("<p>Hello world</p>");
  });

  it("an edit keeps the markup and entities around it byte for byte", async () => {
    const id = await enter('<p class="x">Fish &amp; <b>chips</b> &mdash; hot</p>');
    await click(1, 8);
    expect(session().state().text).toBe("Fish & ");
    for (let i = 0; i < 4; i += 1) ctx.onContentKey?.(key("Delete"));
    type("Cod");
    expect(await session().commit()).toBe(true);
    expect((await loadWebSource(host, id))!.html).toBe('<p class="x">Cod &amp; <b>chips</b> &mdash; hot</p>');
  });

  it("Esc cancels: the document is untouched and the frame shows the source again", async () => {
    const id = await enter("<p>Keep me</p>");
    await click(1, 8);
    type("Zap ");
    await session().idle();
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Zap");
    ctx.onContentKey?.(key("Escape"));
    for (let i = 0; i < 50 && session().isEditing(); i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.isDirty?.()).toBe(false);
    expect((await loadWebSource(host, id))!.html).toBe("<p>Keep me</p>");
    expect(layerText(rec.layers.get(idOf(id)))).not.toContain("Zap");
  });

  it("Cmd+Z inside an open edit steps the keystrokes, not the document", async () => {
    await enter("<p>Abc</p>");
    await click(1, 8);
    type("12");
    expect(session().state().text).toBe("12Abc");
    expect(ctx.onUndo?.()).toBe(true);
    expect(session().state().text).toBe("1Abc");
    expect(ctx.onRedo?.()).toBe(true);
    expect(session().state().text).toBe("12Abc");
    expect(ctx.undoLabel?.()).toBe("Undo typing");
  });

  it("text a template produced is refused, with a note, never edited", async () => {
    const id = await enter("<p>{{name}}</p>", { vars: { name: "Ada" } });
    await click(1, 8);
    expect(session().isEditing()).toBe(false);
    expect((await loadWebSource(host, id))!.html).toBe("<p>{{name}}</p>");
  });

  it("a click on a second paragraph commits the first edit and opens the second", async () => {
    const id = await enter("<p>One</p><p>Two</p>");
    await click(1, 8);
    type("A");
    ctx.onContentPointerDown?.({ contentPoint: [1, 28], elementId: "", modifiers: { shift: false, alt: false, cmd: false, ctrl: false }, button: 0 });
    for (let i = 0; i < 50 && session().state().node !== 1; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(session().state().node).toBe(1);
    expect((await loadWebSource(host, id))!.html).toBe("<p>AOne</p><p>Two</p>");
  });

  it("an outline tag outlines its painted box on the canvas; a press reports the tag back @feat:plugin-web.outline-canvas", async () => {
    const id = await enter("<p>One</p><div><p>Two</p></div>");
    const source = (await loadWebSource(host, id))!;
    // Outline: p(0) div(1) p(2). The second <p> sits one 20 px line down.
    expect(await highlightOutlineEntry(host, id, source, 2)).toBe(1);
    const shapes = h.lastToolPreviews() as unknown as { points: [number, number][]; close?: boolean }[];
    expect(shapes).toHaveLength(1);
    const ys = shapes[0].points.map((p) => p[1]);
    // The frame's top is at 60 pt; the box spans 15–30 pt in the frame.
    expect(Math.min(...ys)).toBeCloseTo(75, 0);
    expect(Math.max(...ys)).toBeCloseTo(90, 0);
    expect(shapes[0].close).toBe(true);
    const picks: number[] = [];
    const off = onCanvasPick(host, (_f, i) => picks.push(i));
    await click(1, 20);
    off();
    expect(picks).toEqual([2]);
  });
});
