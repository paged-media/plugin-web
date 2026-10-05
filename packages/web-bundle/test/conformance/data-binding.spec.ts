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

// Bound data in templates against the real host and the real Blitz engine:
// `{{frame.page}}`, `{{doc.pages}}`, a document value and a data provider's
// first record reach the canvas, and the frame re-renders when a bound
// value changes (a document value is written, a provider announces a new
// revision).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, DataProviderSnapshot, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { autoRendererFor } from "../../src/auto-render";
import { writeDocumentValues, writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { blitzPresent, layerText, primeBlitz, recordScene, requireBlitz, type SceneRecord } from "./blitz";
import { openHost } from "./host";

requireBlitz("web conformance — data binding");

const idOf = (id: ElementId) => (id as { id: string }).id;

/** A one-provider `dataset` registry, installed on the bundle's host (the
 *  headless harness wires none). */
function installProvider(h: HeadlessHost) {
  let revision = "1";
  let city = "Vienna";
  const listeners = new Set<(r: string) => void>();
  const host = h.host as unknown as Record<string, unknown>;
  const supports = (host.supports as (f: string) => boolean).bind(host);
  Object.defineProperty(host, "supports", {
    value: (f: string) => f === "dataProviders@1" || supports(f),
  });
  Object.defineProperty(host, "dataProviders", {
    value: {
      register: () => ({ update() {}, dispose() {} }),
      discover: () => [{ id: "places", category: "dataset", schema: { fields: [{ name: "city", type: "string" }] }, revision }],
      get: async (): Promise<DataProviderSnapshot> => ({
        id: "places",
        revision,
        records: { schema: { fields: [{ name: "city", type: "string" } as never] }, columns: [[city]], rowCount: 1 },
      }),
      onDidChange: (_id: string, l: (r: string) => void) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    },
  });
  return {
    set(next: string) {
      city = next;
      revision = String(Number(revision) + 1);
      for (const l of listeners) l(revision);
    },
  };
}

describe.skipIf(!blitzPresent)("web conformance — data binding (real host + real Blitz) @feat:plugin-web.data-binding", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let rec: SceneRecord;
  let provider: ReturnType<typeof installProvider>;

  beforeEach(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    rec = recordScene(h);
    await primeBlitz(h.host as unknown as BundleHost);
    h.loadBundle(webBundle);
    // The bundle's own host (built at load) gets the registry.
    provider = installProvider(h);
    host = h.host as unknown as BundleHost;
    await autoRendererFor(host)!.idle();
  });
  afterEach(() => h?.dispose());

  async function frame(html: string): Promise<ElementId> {
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 180, 400] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    const id = out.createdId as ElementId;
    const source: WebFrameSource = { ...DEFAULT_SOURCE, html, css: "body{margin:0}" };
    expect((await writeWebSource(host, id, source)).applied).toBe(true);
    await autoRendererFor(host)!.idle();
    return id;
  }

  it("frame page, page count, a document value and a provider field reach the canvas", async () => {
    expect((await writeDocumentValues(host, { edition: "Spring" })).applied).toBe(true);
    const id = await frame("<p>Page {{frame.page}} of {{doc.pages}}, {{doc.edition}}, {{data.city}}</p>");
    const text = layerText(rec.layers.get(idOf(id)));
    expect(text).toContain("Page 1 of 1");
    expect(text).toContain("Spring");
    expect(text).toContain("Vienna");
  });

  it("re-renders when a bound value changes, and only then", async () => {
    const id = await frame("<p>{{data.city}} / {{doc.edition}}</p>");
    const submits = () => rec.submits.filter((s) => s === idOf(id)).length;
    const before = submits();
    await autoRendererFor(host)!.reconcile("change");
    expect(submits()).toBe(before); // nothing bound changed
    provider.set("Graz");
    await autoRendererFor(host)!.idle();
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Graz");
    await writeDocumentValues(host, { edition: "Autumn" });
    await autoRendererFor(host)!.reconcile("change");
    expect(layerText(rec.layers.get(idOf(id)))).toContain("Autumn");
  });

  it("a source that names no bound value keeps its placeholders verbatim", async () => {
    const id = await frame("<p>{{plain}}</p>");
    expect(layerText(rec.layers.get(idOf(id)))).toContain("{{plain}}");
  });
});
