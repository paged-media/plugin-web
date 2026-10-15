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

// The faces a bake gave the document come back when the document is opened
// again, without a re-bake (ADR 414). A document face lives as long as the
// document it was given to (plugin SDK ADR 330) — and never longer than the
// engine session — while the baked text naming it is saved with the
// document. Against the real host and the real Blitz engine: bake, save as
// .paged, open the file in a NEW session (a fresh headless host, whose engine
// has never seen the face), activate the bundle, and the family is not
// missing. The strongest case is a baked frame that is deleted after the bake:
// its source — the only thing that says which face its text was set in — is
// gone, and the face still comes back.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { bakeWebFrameToDocument } from "../../src/bake-to-document";
import { BUNDLED_FAMILY } from "../../src/engine-inputs";
import { writeWebSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { renamedFace } from "../fixtures/fonts";
import { blitzPresent, primeBlitz, requireBlitz } from "./blitz";
import { mapBacking, silent } from "./host";

requireBlitz("web conformance — baked faces after a reopen");

type Reply = { kind: string; payload?: any };
type Send = (m: { kind: string; payload?: unknown }) => Promise<Reply>;
type FontRow = { family: string; isMissing: boolean };

/** Shaped in the bundled face: the CSS names a family no document holds. */
const MAILER: WebFrameSource = {
  ...DEFAULT_SOURCE,
  html: "<p>Spring line sheet</p>",
  css: 'p { font: 18px/1.4 "IBM Plex Sans", sans-serif; margin: 0; }',
};

/** A face a source's own `@font-face` rule loads from the container. */
const BRANDED: WebFrameSource = {
  ...DEFAULT_SOURCE,
  html: "<p>Branded</p>",
  css: "@font-face{font-family:'Brand';src:url(fonts/brand.ttf) format('truetype')} body{margin:0} p{font-family:'Brand';margin:0}",
};

const clientOf = (h: HeadlessHost) => (h.host.editor as unknown as { client: { send: Send } }).client;

/** A headless host wired like the editor: document face bytes come from the
 *  engine's document registry, scene faces go to its scene-layer registry.
 *  `sent` records every document-font registration. */
async function editorLikeHost(sent: Reply[]): Promise<HeadlessHost> {
  const h: HeadlessHost = await createHeadlessHost({
    console: silent,
    storage: mapBacking(),
    assetSource: {
      getFontFace: async (family: string, style?: string) => {
        const r = await clientOf(h).send({ kind: "requestFontFaceBytes", payload: { family, style: style ?? null } });
        if (r.kind !== "fontFaceBytes" || !r.payload.found) return null;
        return { bytes: Uint8Array.from(r.payload.bytes), format: "truetype", family: r.payload.family };
      },
      registerFont: async (family: string, bytes: Uint8Array, style?: string) => {
        await clientOf(h).send({ kind: "registerFont", payload: { family, style: style ?? null, bytes: [...bytes], scope: "sceneLayer" } });
      },
      clearSceneFonts: async () => {
        await clientOf(h).send({ kind: "clearFontRegistry", payload: { scope: "sceneLayer" } });
      },
    },
  });
  const client = clientOf(h);
  const raw = client.send.bind(client);
  client.send = (m) => {
    if (m.kind === "registerFont" && (m.payload as { scope?: string }).scope === "document") sent.push(m as Reply);
    return raw(m);
  };
  return h;
}

describe.skipIf(!blitzPresent)("web conformance — the faces a bake gave the document come back on open @feat:plugin-web.bake-to-native", () => {
  const hosts: HeadlessHost[] = [];
  afterEach(() => {
    for (const h of hosts.splice(0)) h.dispose();
  });

  /** Bake `source` into a fresh document, optionally delete the web frame,
   *  and save the document as .paged. */
  async function bakeAndSave(source: WebFrameSource, options: { deleteFrame?: boolean; undoBake?: boolean } = {}) {
    const sent: Reply[] = [];
    const h = await editorLikeHost(sent);
    hosts.push(h);
    await h.load(W1_EMPTY_PAGE.bytes());
    const engine = await primeBlitz(h.host as unknown as BundleHost);
    h.loadBundle(webBundle);
    const host = h.host as unknown as BundleHost;
    await host.parts.write("resources/fonts/brand.ttf", renamedFace("Brand"));
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [40, 40, 260, 400] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    const frame = out.createdId as ElementId;
    const w = await writeWebSource(host, frame, source);
    if (!w.applied) throw new Error(`not written: ${w.reason}`);
    const baked = await bakeWebFrameToDocument(host, frame, engine);
    expect(baked.baked).toBe(true);
    expect(sent.length, "the bake gave the document a face").toBeGreaterThan(0);
    if (options.undoBake) await host.document.undo();
    if (options.deleteFrame) {
      const del = await host.document.mutate({ op: "deleteFrame", args: { frameId: (frame as { id: string }).id } } as never);
      expect(del.applied).toBe(true);
    }
    const { bytes } = await h.exportDocument("paged");
    return bytes;
  }

  /** Open `bytes` in a NEW session and activate the bundle. */
  async function reopen(bytes: Uint8Array) {
    const sent: Reply[] = [];
    const h = await editorLikeHost(sent);
    hosts.push(h);
    await h.load(bytes);
    h.loadBundle(webBundle);
    const host = h.host as unknown as BundleHost;
    const row = async (family: string) =>
      (await host.document.collection<FontRow>("fonts")).find((f) => f.family === family);
    return { h, host, sent, row };
  }

  it("the bundled face of a baked run is given back on open, without a re-bake", async () => {
    const saved = await bakeAndSave(MAILER);
    const { row, sent } = await reopen(saved);
    expect(await row(BUNDLED_FAMILY), "the baked text names the bundled face").toBeTruthy();
    await vi.waitFor(async () => expect((await row(BUNDLED_FAMILY))?.isMissing).toBe(false), { timeout: 3_000 });
    expect(sent.map((m) => m.payload.family)).toEqual([BUNDLED_FAMILY]);
  });

  it("an @font-face face comes back after the web frame and its source are deleted", async () => {
    const saved = await bakeAndSave(BRANDED, { deleteFrame: true });
    const { row } = await reopen(saved);
    expect((await row("Brand"))?.isMissing === undefined, "the baked text still names Brand").toBe(false);
    await vi.waitFor(async () => expect((await row("Brand"))?.isMissing).toBe(false), { timeout: 3_000 });
  });

  it("a face no text names any more is not given back, and its record is dropped on the next save", async () => {
    const saved = await bakeAndSave(MAILER, { undoBake: true });
    const { h, host, sent, row } = await reopen(saved);
    // Give the open pass time to run; nothing names the family, so nothing is given.
    await new Promise((r) => setTimeout(r, 200));
    expect(await row(BUNDLED_FAMILY)).toBeUndefined();
    expect(sent).toEqual([]);
    expect((await host.parts.list("faces/")).length, "the bake left its record").toBeGreaterThan(0);
    await h.willSave.fire();
    expect(await host.parts.list("faces/")).toEqual([]);
  });
});
