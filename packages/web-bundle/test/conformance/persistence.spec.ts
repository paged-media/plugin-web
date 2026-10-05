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

// Conformance — source persistence against the REAL engine: its 64 KiB
// metadata cap, its undo, and its (non-undoable) container parts. The unit
// suite (source-persistence.spec.ts) models these rules; this proves the
// model matches the engine. The bundle is loaded first so the host speaks
// for its namespace (`x-paged:media.paged.web`, `paged/media.paged.web/`).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { loadWebSource, writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { openHost } from "./host";

const src = (html: string): WebFrameSource => ({ ...DEFAULT_SOURCE, html });
const big = (tag: string): WebFrameSource =>
  src(`<p>${tag}</p>` + "<p>lorem ipsum dolor</p>".repeat(5000));

describe("web conformance — source persistence (real engine)", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
  });
  afterAll(() => h?.dispose());

  async function carrier(): Promise<ElementId> {
    const out = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 240, 300] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no carrier created");
    return out.createdId as ElementId;
  }

  it("the engine really refuses a label over 64 KiB (the rule the design rests on)", async () => {
    const id = await carrier();
    const out = await h.host.document.setMetadata(id as never, {
      v: 1,
      data: { html: "x".repeat(70 * 1024), css: "" },
    });
    expect(out.applied).toBe(false);
    await h.host.document.undo(); // carrier
  });

  it("undo of a save restores the previous source (small)", async () => {
    const id = await carrier();
    await writeWebSource(host, id, src("<p>A</p>"));
    await writeWebSource(host, id, src("<p>B</p>"));
    expect((await loadWebSource(host, id))?.html).toBe("<p>B</p>");
    await h.host.document.undo();
    expect((await loadWebSource(host, id))?.html).toBe("<p>A</p>");
    await h.host.document.undo();
    await h.host.document.undo();
  });

  it("a large source saves through a part and undo restores the previous one", async () => {
    const id = await carrier();
    expect((await writeWebSource(host, id, big("L1"))).applied).toBe(true);
    expect((await writeWebSource(host, id, big("L2"))).applied).toBe(true);
    expect((await loadWebSource(host, id))?.html.startsWith("<p>L2</p>")).toBe(true);
    await h.host.document.undo();
    expect((await loadWebSource(host, id))?.html.startsWith("<p>L1</p>")).toBe(true);
    await h.host.document.undo();
    await h.host.document.undo();
  });

  it("importing a large .html file creates the web frame in one batch", async () => {
    // Through the bundle's own importer — the File ▸ Open / drop path.
    const importer = h.importersContributed().find((c) => c.id === "media.paged.web.importer.html");
    expect(importer, "the bundle contributes its .html importer").toBeDefined();
    const body = "<p>import</p>" + "<p>lorem ipsum dolor</p>".repeat(5000);
    await importer!.import({
      name: "large.html",
      bytes: new TextEncoder().encode(`<html><body>${body}</body></html>`),
    } as never);
    const selected = h.host.selection.get();
    expect(selected).toHaveLength(1);
    const s = await loadWebSource(host, selected[0] as ElementId);
    expect(s?.html.startsWith("<p>import</p>")).toBe(true);
    expect(s?.html.length).toBeGreaterThan(64 * 1024);
    await h.host.document.undo();
  });
});
