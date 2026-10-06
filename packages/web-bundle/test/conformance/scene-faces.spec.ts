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

// The faces the engine shapes with reach the canvas: against the real host
// (the published canvas-wasm, its scene-layer face table) and the real Blitz
// engine, a web frame's text names the bundled face, the canvas draws it in
// the default font until the bundle hands the face over, and then in that
// face — without the document's own fonts seeing it. The same holds for a
// face a source's `@font-face` rule loads from the container.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { webBundle } from "../../src";
import { persistentSceneSurface } from "../../src/bake";
import {
  BUNDLED_FAMILY,
  faceDiagnostics,
  prepareEngineInputs,
  releaseSceneFaces,
  retainSceneFaces,
} from "../../src/engine-inputs";
import type { WebEngine } from "../../src/engine-loader";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { renamedFace } from "../fixtures/fonts";
import { blitzPresent, primeBlitz, requireBlitz } from "./blitz";
import { mapBacking, silent } from "./host";

requireBlitz("web conformance — scene faces");

type Send = (m: { kind: string; payload?: unknown }) => Promise<{ kind: string; payload?: any }>;

describe.skipIf(!blitzPresent)("web conformance — scene-layer faces (real host + real Blitz) @feat:plugin-web.web-fonts", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let engine: WebEngine;
  let id: string;

  beforeEach(async () => {
    // The editor's asset source, headlessly: scene faces go to the engine's
    // scene-layer registry, never the document's.
    const send: Send = (m) => (h.host.editor as unknown as { client: { send: Send } }).client.send(m);
    h = await createHeadlessHost({
      console: silent,
      storage: mapBacking(),
      assetSource: {
        getFontFace: async () => null,
        registerFont: async (family: string, bytes: Uint8Array, style?: string) => {
          await send({ kind: "registerFont", payload: { family, style: style ?? null, bytes: [...bytes], scope: "sceneLayer" } });
        },
        clearSceneFonts: async () => {
          await send({ kind: "clearFontRegistry", payload: { scope: "sceneLayer" } });
        },
      },
    });
    await h.load(W1_EMPTY_PAGE.bytes());
    // The real scene channel (the headless editor wires none): submit answers
    // the engine's `sceneLayerApplied` report.
    (h.host.editor as unknown as Record<string, unknown>).sceneLayers = {
      async submit(elementId: string, layer: unknown) {
        return (await send({ kind: "submitSceneLayer", payload: { elementId, layer } })).payload;
      },
      async clear(elementId: string) {
        await send({ kind: "clearSceneLayer", payload: { elementId } });
      },
    };
    engine = await primeBlitz(h.host as unknown as BundleHost);
    h.loadBundle(webBundle);
    host = h.host as unknown as BundleHost;
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 180, 400] },
    } as never);
    if (!out.applied || !out.createdId) throw new Error("no frame");
    id = (out.createdId as ElementId as { id: string }).id;
  });
  afterEach(() => h?.dispose());

  const html = "<html><body style='margin:0'><p>Bundled face</p></body></html>";

  it("the bundled face draws in its own face once the bundle hands it over", async () => {
    expect(host.supports("assets.registerFont@1")).toBe(true);
    const layer = engine.render(html, 300, 100);
    expect(layer?.items.some((i) => i.kind === "text" && (i as { family?: string }).family === BUNDLED_FAMILY)).toBe(true);
    const surface = persistentSceneSurface(host)!;
    // Before: the canvas has no such face and says so.
    const before = await surface.submit(id, layer as never);
    expect(before?.fontFallbacks?.some((f) => f.startsWith(BUNDLED_FAMILY))).toBe(true);
    // The bundle hands over the faces the engine shapes with.
    await prepareEngineInputs(host, engine, html);
    const after = await surface.submit(id, layer as never);
    expect(after?.fontFallbacks ?? []).toEqual([]);
    expect(faceDiagnostics(after, host)).toEqual([]);
    // The document's fonts never see it.
    const fonts = await host.document.collection<{ family: string }>("fonts");
    expect(fonts.map((f) => f.family)).not.toContain(BUNDLED_FAMILY);
    // Given back on deactivation: the canvas falls back again — and the
    // fallback would now be reported as the problem it is.
    await releaseSceneFaces(host);
    const released = await surface.submit(id, layer as never);
    expect(released?.fontFallbacks?.some((f) => f.startsWith(BUNDLED_FAMILY))).toBe(true);
  });

  const families = (layer: { items: unknown[] } | null) =>
    (layer?.items ?? [])
      .filter((i) => (i as { kind: string }).kind === "text")
      .map((i) => (i as { family?: string }).family);

  it("a face an @font-face rule loads from the container draws in that face, under the family the CSS declares", async () => {
    // A face whose own name is "Brand", stored with the document.
    await host.parts.write("resources/fonts/brand.ttf", renamedFace("Brand"));
    const fontsBefore = (await host.document.collection<{ family: string }>("fonts")).map((f) => f.family);
    const doc =
      "<html><head><style>@font-face{font-family:'Brand';src:url(fonts/brand.ttf) format('truetype')}" +
      "p{font-family:'Brand'}</style></head><body style='margin:0'><p>Branded</p></body></html>";
    const diagnostics = await prepareEngineInputs(host, engine, doc, id);
    expect(diagnostics).toEqual([]);
    const layer = engine.render(doc, 300, 100);
    expect(families(layer)).toContain("Brand");
    const surface = persistentSceneSurface(host)!;
    const reply = await surface.submit(id, layer as never);
    expect(reply?.fontFallbacks ?? []).toEqual([]);
    expect(faceDiagnostics(reply, host)).toEqual([]);
    // The document's Fonts collection never sees the face.
    const fontsAfter = (await host.document.collection<{ family: string }>("fonts")).map((f) => f.family);
    expect(fontsAfter).toEqual(fontsBefore);
    // Once no source uses it, the face is given back: the canvas falls back.
    await retainSceneFaces(host, []);
    const released = await surface.submit(id, layer as never);
    expect(released?.fontFallbacks ?? []).toContain("Brand");
  });

  it("a CSS family that differs from the face's own name reaches the canvas too", async () => {
    await host.parts.write("resources/fonts/plate.ttf", renamedFace("Plate"));
    const doc =
      "<html><head><style>@font-face{font-family:Display;src:url(fonts/plate.ttf);font-weight:700}" +
      "p{font-family:Display;font-weight:700}</style></head><body style='margin:0'><p>Display</p></body></html>";
    await prepareEngineInputs(host, engine, doc, id);
    const layer = engine.render(doc, 300, 100);
    const reply = await persistentSceneSurface(host)!.submit(id, layer as never);
    expect(reply?.fontFallbacks ?? []).toEqual([]);
    // Deactivation gives it back like every other face.
    await releaseSceneFaces(host);
    const released = await persistentSceneSurface(host)!.submit(id, layer as never);
    expect((released?.fontFallbacks ?? []).length).toBeGreaterThan(0);
  });
});
