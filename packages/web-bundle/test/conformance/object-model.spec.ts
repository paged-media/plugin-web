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

// The object model (ADR 323) against the REAL headless host: the registry
// every surface shares (`h.objects` — what the Node CLI, a Boa bridge, a
// data binding and a schema-driven field call). Each write is ONE engine
// undo step, read back through the same door, and undone by one
// `document.undo()`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, DataProviderSnapshot } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { webBundle } from "../../src";
import { autoRendererFor } from "../../src/auto-render";
import { PANEL_FIELDS, schemaOf, webAddress } from "../../src/object-model";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { blitzPresent, layerText, primeBlitz, recordScene, requireBlitz, type SceneRecord } from "./blitz";
import { openHost } from "./host";

requireBlitz("web conformance — object model");

const INSERT = "media.paged.web.command.insertWebFrame";
const value = (v: unknown) => ({ kind: "value", value: v });

/** A one-provider `dataset` source on the bundle's host (as data-binding.spec). */
function installProvider(h: HeadlessHost): void {
  const host = h.host as unknown as Record<string, unknown>;
  const supports = (host.supports as (f: string) => boolean).bind(host);
  Object.defineProperty(host, "supports", { value: (f: string) => f === "dataProviders@1" || supports(f) });
  Object.defineProperty(host, "dataProviders", {
    value: {
      register: () => ({ update() {}, dispose() {} }),
      discover: () => [{ id: "places", category: "dataset", schema: { fields: [{ name: "city", type: "string" }] }, revision: "1" }],
      get: async (): Promise<DataProviderSnapshot> => ({
        id: "places",
        revision: "1",
        records: { schema: { fields: [{ name: "city", type: "string" } as never] }, columns: [["Vienna"]], rowCount: 1 },
      }),
      onDidChange: () => ({ dispose() {} }),
    },
  });
}

describe.skipIf(!blitzPresent)("web conformance — object model (real host + real Blitz) @feat:plugin-web.object-model", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let rec: SceneRecord;

  beforeEach(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    rec = recordScene(h);
    await primeBlitz(h.host as unknown as BundleHost);
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    installProvider(h);
    await autoRendererFor(host)!.idle();
  });
  afterEach(() => h?.dispose());

  async function insert(html: string, css = "body{margin:0}"): Promise<{ webFrame: string; frame: string }> {
    const out = (await h.objects.invoke(INSERT, {
      page: "page:#1",
      bounds: [60, 60, 200, 400],
      html,
      css,
    })) as { webFrame: string; frame: string };
    await autoRendererFor(host)!.idle();
    return out;
  }

  it("registers three kinds and the seven commands typed", async () => {
    const kinds = (await h.objects.kinds()).filter((k) => k.owner === "media.paged.web").map((k) => k.kind);
    expect(kinds).toEqual([
      "plugin:media.paged.web/webFrame",
      "plugin:media.paged.web/templateVar",
      "plugin:media.paged.web/cssVar",
    ]);
    const commands = (await h.objects.commands()).filter((c) => c.owner === "media.paged.web").map((c) => c.id);
    expect(commands).toHaveLength(7);
    expect(commands).toContain(INSERT);
  });

  it("insert (typed) → query → get; the frame renders", async () => {
    const { webFrame, frame } = await insert("<p>Hello object model</p>");
    expect(await h.objects.query("plugin:media.paged.web/webFrame")).toEqual([webFrame]);
    expect(await h.objects.query(`page:#1 > plugin:media.paged.web/webFrame`)).toEqual([webFrame]);
    expect(await h.objects.get(webFrame, "html")).toEqual(value("<p>Hello object model</p>"));
    expect(await h.objects.get(webFrame, "frame")).toEqual(value(frame));
    expect(await h.objects.get(webFrame, "storage")).toEqual(value("inline"));
    expect(layerText(rec.layers.get(frame.split(":")[1]!))).toContain("Hello object model");
  });

  it("set is ONE undo step, read back, and undone by one undo", async () => {
    const { webFrame } = await insert("<p>before</p>");
    const out = await h.objects.set(webFrame, "html", "<p>after</p>");
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(webFrame, "html")).toEqual(value("<p>after</p>"));
    await host.document.undo();
    expect(await h.objects.get(webFrame, "html")).toEqual(value("<p>before</p>"));
  });

  it("a batch over several paths lands as one step; a bad value applies nothing", async () => {
    const { webFrame } = await insert("<p>x</p>", "p{}");
    const out = await h.objects.batch([
      { op: "set", address: webFrame, path: "css", value: "p{color:red}" },
      { op: "set", address: webFrame, path: "overflow", value: "shrink" },
      { op: "set", address: webFrame, path: "media", value: "screen" },
      { op: "set", address: webFrame, path: "vars", value: { who: "world" } },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(webFrame, "overflow")).toEqual(value("shrink"));
    expect(await h.objects.get(webFrame, "vars")).toEqual(value({ who: "world" }));
    const bad = await h.objects.batch([
      { op: "set", address: webFrame, path: "css", value: "p{}" },
      { op: "set", address: webFrame, path: "overflow", value: "bogus" },
    ]);
    expect(bad).toMatchObject({ applied: false, code: "invalidValue", index: 1 });
    expect(await h.objects.get(webFrame, "css")).toEqual(value("p{color:red}"));
    expect((await h.objects.set(webFrame, "storage", "part")).code).toBe("readOnly");
    await host.document.undo();
    expect(await h.objects.get(webFrame, "overflow")).toEqual(value("clip"));
    expect(await h.objects.get(webFrame, "vars")).toEqual(value(null));
  });

  it("a source over the label cap goes to a part, and undo returns to the inline one", async () => {
    const { webFrame } = await insert("<p>small</p>");
    const big = `<p>${"x".repeat(70 * 1024)}</p>`;
    expect((await h.objects.set(webFrame, "html", big)).applied).toBe(true);
    expect(await h.objects.get(webFrame, "storage")).toEqual(value("part"));
    expect(((await h.objects.get(webFrame, "html")) as { value: string }).value).toHaveLength(big.length);
    await host.document.undo();
    expect(await h.objects.get(webFrame, "storage")).toEqual(value("inline"));
    expect(await h.objects.get(webFrame, "html")).toEqual(value("<p>small</p>"));
  });

  it("templateVar: a document value is set in the designmap label, renders, and undoes", async () => {
    const { webFrame, frame } = await insert("<p>Edition {{doc.edition}} in {{data.city}}</p>");
    const edition = webAddress("templateVar", "doc.edition");
    expect(await h.objects.query("plugin:media.paged.web/templateVar")).toEqual(
      expect.arrayContaining([edition, webAddress("templateVar", "doc.title"), webAddress("templateVar", "data.city")]),
    );
    expect(await h.objects.get(edition, "value")).toEqual(value(null));
    expect(await h.objects.get(edition, "usedBy")).toEqual(value([webFrame]));
    expect(await h.objects.get(webAddress("templateVar", "data.city"), "value")).toEqual(value("Vienna"));
    expect(await h.objects.set(edition, "value", "Spring")).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(edition, "value")).toEqual(value("Spring"));
    await autoRendererFor(host)!.reconcile("change");
    expect(layerText(rec.layers.get(frame.split(":")[1]!))).toContain("Edition Spring");
    // Read-only scopes refuse with a reason, never a silent no-op.
    expect(await h.objects.set(webAddress("templateVar", "data.city"), "value", "Graz")).toMatchObject({ applied: false });
    expect(await h.objects.set(webAddress("templateVar", "doc.title"), "value", "T")).toMatchObject({ applied: false });
    await host.document.undo();
    expect(await h.objects.get(edition, "value")).toEqual(value(null));
  });

  it("cssVar: a custom property is read and spliced in the css lane, one step", async () => {
    const { webFrame } = await insert("<p>v</p>", ":root { --brand: #c00; }\np { color: var(--brand) }");
    const id = webFrame.split("/").pop()!;
    const brand = webAddress("cssVar", `${id}/--brand`);
    expect(await h.objects.query("plugin:media.paged.web/cssVar")).toEqual([brand]);
    expect(await h.objects.get(brand, "value")).toEqual(value("#c00"));
    expect(await h.objects.get(brand, "context")).toEqual(value(":root"));
    expect(await h.objects.set(brand, "value", "rebeccapurple")).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(webFrame, "css")).toEqual(
      value(":root { --brand: rebeccapurple; }\np { color: var(--brand) }"),
    );
    expect(await h.objects.set(brand, "value", "red; color: blue")).toMatchObject({ applied: false });
    await host.document.undo();
    expect(await h.objects.get(brand, "value")).toEqual(value("#c00"));
  });

  it("typed thread / unthread write the flow chain through objects (one step each)", async () => {
    const a = await insert("<p>source</p>");
    const b = await h.objects.invoke(INSERT, { page: "page:#1", bounds: [220, 60, 360, 400], html: "", css: "" });
    const target = (b as { frame: string }).frame;
    expect(
      await h.objects.invoke("media.paged.web.command.threadWebFlow", { frame: a.webFrame, targets: [target], flow: "" }),
    ).toEqual({ added: 1 });
    expect(await h.objects.get(a.webFrame, "flow")).toEqual(value([{ frame: target, flow: "" }]));
    expect(
      await h.objects.invoke("media.paged.web.command.threadWebFlow", { frame: a.webFrame, targets: [target], flow: "" }),
    ).toEqual({ added: 0 });
    expect(
      await h.objects.invoke("media.paged.web.command.unthreadWebFlow", { frame: a.frame, targets: [target] }),
    ).toEqual({ removed: 1 });
    expect(await h.objects.get(a.webFrame, "flow")).toEqual(value([]));
    await host.document.undo();
    expect(await h.objects.get(a.webFrame, "flow")).toEqual(value([{ frame: target, flow: "" }]));
    await expect(h.objects.invoke("media.paged.web.command.threadWebFlow", { frame: a.webFrame })).rejects.toThrow(
      /invalidValue/,
    );
  });

  it("typed render answers what the engine did", async () => {
    const { webFrame } = await insert("<p>rendered by command</p>");
    const out = (await h.objects.invoke("media.paged.web.command.renderWebFrame", { frame: webFrame })) as {
      rendered: boolean;
    };
    expect(out.rendered).toBe(true);
  });

  it("every panel field is a writable row of its kind", () => {
    for (const f of PANEL_FIELDS) {
      const row = schemaOf(f.kind).find((r) => r.path === f.path);
      expect(row, `${f.kind}.${f.path}`).toBeDefined();
      expect(row!.access ?? "readWrite").toBe("readWrite");
    }
  });
});
