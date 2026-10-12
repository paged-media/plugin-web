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

// Baked text names a face the document can draw. Against the real host and
// the real Blitz engine: the web film's mailer names "IBM Plex Sans", which no
// document holds, so the engine shapes it in the bundled face — and every
// baked run named that face, which the document's registry did not hold
// either: the Fonts collection flagged it missing ("Missing fonts: 1") and the
// canvas drew the baked text in a substitute. The bake now gives the document
// the faces its text names when the document has none: the bundled face, and
// the faces a source's own `@font-face` rules load.
//
// The asset source here is the editor's (`plugin-asset-source.ts`): a face's
// bytes come from the engine's DOCUMENT registry (`requestFontFaceBytes`),
// scene faces go to its scene-layer registry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { bakeWebFlowToDocument, bakeWebFrameToDocument } from "../../src/bake-to-document";
import { BUNDLED_FAMILY } from "../../src/engine-inputs";
import type { WebEngine } from "../../src/engine-loader";
import { writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { renamedFace } from "../fixtures/fonts";
import { blitzPresent, primeBlitz, requireBlitz } from "./blitz";
import { mapBacking, silent } from "./host";

requireBlitz("web conformance — baked faces");

type Reply = { kind: string; payload?: any };
type Send = (m: { kind: string; payload?: unknown }) => Promise<Reply>;
type FontRow = { family: string; isMissing: boolean };

/** The film's mailer, as its frame holds it: every rule names IBM Plex Sans. */
const MAILER: WebFrameSource = {
  ...DEFAULT_SOURCE,
  html: '<div class="mailer"><p class="kicker">New this season</p><h1>Spring line sheet</h1><p>Three pieces.</p></div>',
  css:
    '.mailer { font: 14px/1.5 "IBM Plex Sans", sans-serif; color: #241c12; background: #fff7ea; padding: 22px 24px; }' +
    '.kicker { font-size: 11px; text-transform: uppercase; color: #c2410c; margin: 0 0 6px; }' +
    'h1 { font: 600 30px/1.1 "IBM Plex Sans", sans-serif; margin: 0 0 8px; }',
};

describe.skipIf(!blitzPresent)("web conformance — baked text names a face the document can draw @feat:plugin-web.bake-to-native", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let engine: WebEngine;
  const sent: { kind: string; payload?: any }[] = [];

  const send: Send = (m) => {
    sent.push(m);
    return (h.host.editor as unknown as { client: { send: Send } }).client.send(m);
  };

  beforeEach(async () => {
    sent.length = 0;
    h = await createHeadlessHost({
      console: silent,
      storage: mapBacking(),
      // The editor's asset source: document face bytes from the engine's
      // document registry; scene faces into its scene-layer registry.
      assetSource: {
        getFontFace: async (family: string, style?: string) => {
          const r = await (h.host.editor as unknown as { client: { send: Send } }).client.send({
            kind: "requestFontFaceBytes",
            payload: { family, style: style ?? null },
          });
          if (r.kind !== "fontFaceBytes" || !r.payload.found) return null;
          return { bytes: Uint8Array.from(r.payload.bytes), format: "truetype", family: r.payload.family };
        },
        registerFont: async (family: string, bytes: Uint8Array, style?: string) => {
          await send({ kind: "registerFont", payload: { family, style: style ?? null, bytes: [...bytes], scope: "sceneLayer" } });
        },
        clearSceneFonts: async () => {
          await send({ kind: "clearFontRegistry", payload: { scope: "sceneLayer" } });
        },
      },
    });
    await h.load(W1_EMPTY_PAGE.bytes());
    // Every document-font registration, as the bundle sends it.
    const client = (h.host.editor as unknown as { client: { send: Send } }).client;
    const raw = client.send.bind(client);
    client.send = (m) => {
      if (m.kind === "registerFont") sent.push(m);
      return raw(m);
    };
    engine = await primeBlitz(h.host as unknown as BundleHost);
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
  });
  afterEach(() => h?.dispose());

  async function webFrame(source: WebFrameSource): Promise<ElementId> {
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [40, 40, 260, 400] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    const id = out.createdId as ElementId;
    const w = await writeWebSource(host, id, source);
    if (!w.applied) throw new Error(`not written: ${w.reason}`);
    return id;
  }

  const fonts = () => host.document.collection<FontRow>("fonts");
  const missing = async () => new Set((await fonts()).filter((f) => f.isMissing).map((f) => f.family));
  const documentRegistrations = () => sent.filter((m) => m.kind === "registerFont" && m.payload.scope === "document");

  it("the film's mailer: baked runs name the bundled face, and the document holds it", async () => {
    const frame = await webFrame(MAILER);
    const before = await missing();
    const outcome = await bakeWebFrameToDocument(host, frame, engine);
    expect(outcome.baked).toBe(true);
    // The runs name the face they were shaped in, not the family the CSS asks for.
    const rows = await fonts();
    const inter = rows.find((f) => f.family === BUNDLED_FAMILY);
    expect(inter, "the baked text names the bundled face").toBeTruthy();
    expect(rows.map((f) => f.family)).not.toContain("IBM Plex Sans");
    // Nothing the bake wrote is missing.
    expect(inter!.isMissing).toBe(false);
    for (const family of await missing()) expect(before.has(family), `${family} is missing after the bake`).toBe(true);
    // A second bake finds the face in the document and registers nothing.
    const registered = documentRegistrations().length;
    expect(registered).toBe(1);
    await bakeWebFrameToDocument(host, frame, engine);
    expect(documentRegistrations().length).toBe(registered);
  });

  it("a flow bake gives the document the faces its text names too", async () => {
    const lines = Array.from({ length: 24 }, (_, i) => `<p>Line ${i + 1} of the flow</p>`).join("");
    const source = await webFrame({ ...MAILER, html: `<div class="mailer">${lines}</div>` });
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [300, 40, 520, 400] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no recipient frame");
    const recipient = out.createdId as ElementId;
    await writeWebSource(host, source, {
      ...MAILER,
      html: `<div class="mailer">${lines}</div>`,
      flow: { recipients: [{ kind: (recipient as { kind: string }).kind as never, id: (recipient as { id: string }).id }] },
    });
    const outcome = await bakeWebFlowToDocument(host, [source, recipient], engine);
    expect(outcome.baked).toBe(true);
    expect((await fonts()).find((f) => f.family === BUNDLED_FAMILY)?.isMissing).toBe(false);
  });

  it("a face a source's @font-face rule loads is given to the document under the family its runs name", async () => {
    await host.parts.write("resources/fonts/brand.ttf", renamedFace("Brand"));
    const frame = await webFrame({
      ...DEFAULT_SOURCE,
      html: "<p>Branded</p>",
      css: "@font-face{font-family:'Brand';src:url(fonts/brand.ttf) format('truetype')} body{margin:0} p{font-family:'Brand';margin:0}",
    });
    const outcome = await bakeWebFrameToDocument(host, frame, engine);
    expect(outcome.baked).toBe(true);
    const brand = (await fonts()).find((f) => f.family === "Brand");
    expect(brand, "the baked text names the @font-face face").toBeTruthy();
    expect(brand!.isMissing).toBe(false);
  });

  it("a family the document already holds is left as the document has it", async () => {
    // The document's own Inter (here: a face whose own name is Inter's), registered first.
    await send({ kind: "registerFont", payload: { family: BUNDLED_FAMILY, style: null, bytes: [...renamedFace("Other")], scope: "document" } });
    sent.length = 0;
    const frame = await webFrame(MAILER);
    await bakeWebFrameToDocument(host, frame, engine);
    expect(documentRegistrations()).toEqual([]);
    expect((await fonts()).find((f) => f.family === BUNDLED_FAMILY)?.isMissing).toBe(false);
  });
});
