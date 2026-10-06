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

// Source parts no label can reach are dropped on save (ADR 410), against the
// real host: a part the opened file carried that no label names, and a
// legacy `<frame>/source.json` of a frame the file no longer has, go; a part
// a label names, and every part written this session (undo may return to
// it), stay.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { autoRendererFor } from "../../src/auto-render";
import { loadWebSource, writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { openHost } from "./host";

const big = (tag: string): WebFrameSource => ({
  ...DEFAULT_SOURCE,
  html: `<p>${tag}</p>` + "<p>lorem ipsum dolor</p>".repeat(5000),
});
const enc = (s: string) => new TextEncoder().encode(s);

// Deleting a part needs the engine's delete door (protocol 66); an older
// engine refuses it and the parts stay (test/parts-gc.spec.ts covers the
// collector's choices on a modelled host either way).
const engineDeletes = await (async () => {
  const probe = await openHost();
  const ok = probe.protocolVersion >= 66;
  probe.dispose();
  return ok;
})();

describe("web conformance — unreachable source parts are dropped on save", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let announceLoaded: () => void;

  beforeEach(async () => {
    h = await openHost();
    // Keep the editor's own "document loaded" broadcast, so a spec can play
    // a file being opened over the document it built (the harness cannot
    // save one to reopen). The bundle hears it through document.onDidOpen.
    const listeners: ((m: { kind: string }) => void)[] = [];
    let loaded: { kind: string } | null = null;
    const client = h.host.editor.client as unknown as {
      subscribe: (l: (m: { kind: string }) => void) => () => void;
    };
    const subscribe = client.subscribe.bind(client);
    client.subscribe = (l) => {
      listeners.push(l);
      return subscribe(l);
    };
    client.subscribe((m) => {
      if (m.kind === "documentLoaded") loaded = m;
    });
    announceLoaded = () => listeners.forEach((l) => l(loaded!));
    await h.load(W1_EMPTY_PAGE.bytes());
    expect(loaded).not.toBeNull();
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    await autoRendererFor(host)!.idle();
  });
  afterEach(() => h?.dispose());

  async function frame(): Promise<ElementId> {
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 240, 300] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    return out.createdId as ElementId;
  }

  /** Stand in for a file opened with these parts: write them outside the
   *  bundle's writer, then announce the load. */
  async function openedWith(paths: string[]): Promise<void> {
    for (const p of paths) await host.parts.write(p, enc('{"v":1}'));
    announceLoaded();
    await autoRendererFor(host)!.idle();
  }

  it.skipIf(!engineDeletes)("drops the file's orphan parts and keeps the one a label names", async () => {
    expect(host.supports("document.onDidOpen@1")).toBe(true);
    const live = await frame();
    expect((await writeWebSource(host, live, big("live"))).applied).toBe(true);
    await openedWith(["sources/00000000deadbeef.json", "uGONE/source.json"]);
    const named = (await host.parts.list("sources/")).filter((p) => p !== "sources/00000000deadbeef.json");

    await h.willSave.fire();

    const after = await host.parts.list("");
    expect(after).not.toContain("sources/00000000deadbeef.json");
    expect(after).not.toContain("uGONE/source.json");
    for (const p of named) expect(after).toContain(p);
    expect((await loadWebSource(host, live))?.html.startsWith("<p>live</p>")).toBe(true);
  });

  it("keeps a part written this session that no label names any more, so undo still finds it", async () => {
    const id = await frame();
    await writeWebSource(host, id, big("one"));
    await writeWebSource(host, id, big("two"));
    await h.willSave.fire();
    await host.document.undo();
    expect((await loadWebSource(host, id))?.html.startsWith("<p>one</p>")).toBe(true);
  });

  it("keeps a legacy part whose frame still exists", async () => {
    const id = await frame();
    const legacy = `${(id as { id: string }).id}/source.json`;
    await openedWith([legacy]);
    await h.willSave.fire();
    expect(await host.parts.list("")).toContain(legacy);
  });

  it("on an engine without the delete door, saving still succeeds and drops nothing", async () => {
    await openedWith(["sources/00000000deadbeef.json"]);
    await h.willSave.fire();
    const after = await host.parts.list("");
    if (engineDeletes) expect(after).not.toContain("sources/00000000deadbeef.json");
    else expect(after).toContain("sources/00000000deadbeef.json");
  });
});
