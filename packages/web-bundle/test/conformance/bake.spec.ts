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

// Conformance — Phase C BAKE-TO-NATIVE through the REAL headless editor host
// (createHeadlessHost + real canvas-wasm) AND the REAL Blitz engine wasm.
// Inserts a web frame with a solid-fill + text source, loads the actual Blitz
// artifact (Node initSync), and bakes: asserts real NATIVE page items appear —
// a swatch per colour, a rectangle for the fill, and a text frame (with a
// minted story) for the run. This is the end-to-end "flatten to IDML/PDF-able
// content" proof: real render → real bake plan → real host mutations. Gated on
// the gitignored engine artifact being built; skips with a note when absent.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { sceneLayerToBakePlan } from "../../src/bake-plan";
import { bakeWebFrameToDocument, bakeWebFlowToDocument } from "../../src/bake-to-document";
import { parseSceneLayer, parseFlowResult, type WebEngine } from "../../src/engine-loader";
import { persistSource } from "../../src/source-part";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { openHost } from "./host";

const binDir = fileURLToPath(new URL("../../bin/", import.meta.url));
const gluePath = binDir + "blitz_web.js";
const wasmPath = binDir + "blitz_web_bg.wasm";
const artifactPresent = existsSync(gluePath) && existsSync(wasmPath);

// DUAL GATE (mirrors engine.spec.ts): locally a missing engine artifact
// SKIPS this conformance suite; in CI the vitest workflow builds the
// artifact and sets REQUIRE_REAL_ENGINE=1, under which a missing artifact
// FAILS instead of skipping — the bake conformance can never silently
// fall out of CI on a skip gate.
if (process.env.REQUIRE_REAL_ENGINE === "1" && !artifactPresent) {
  describe("web conformance — bake to native content — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the engine artifact is missing", () => {
      throw new Error(
        `REQUIRE_REAL_ENGINE=1 but ${wasmPath} (or its glue) is missing — ` +
          "build it with `bash scripts/build-wasm.sh --engine` (CI must " +
          "build the artifact before running vitest; skipping is not allowed here)",
      );
    });
  });
}

/** A source with a solid-fill box + a text run → exercises both bake lanes. */
const SOURCE: WebFrameSource = {
  ...DEFAULT_SOURCE,
  html: '<div class="box"><p>Bake me</p></div>',
  css: "body{margin:0}.box{background:#cc3333;width:120px;height:80px}p{margin:0;color:#ffffff;font-size:24px}",
};

async function storyCount(h: HeadlessHost): Promise<number> {
  return (await h.host.document.collection<{ selfId: string }>("stories")).length;
}

describe.skipIf(!artifactPresent)(
  "web conformance — bake to native content (real host + real Blitz)",
  () => {
    let h: HeadlessHost;
    let frame: ElementId;
    let engine: WebEngine;

    beforeAll(async () => {
      h = await openHost();
      await h.load(W1_EMPTY_PAGE.bytes());
      h.loadBundle(webBundle);
      // Insert a web frame, then override its default source with ours.
      const c = h.contributions.find(
        (x) => x.kind === "command" && x.id === "media.paged.web.command.insertWebFrame",
      );
      await (c!.value as { handler: (a: unknown) => unknown }).handler(undefined);
      frame = h.host.selection.get()[0];
      await persistSource(h.host, frame, SOURCE);

      // Load the REAL Blitz engine (Node has no relative fetch → initSync).
      const glue = (await import(new URL("../../bin/blitz_web.js", import.meta.url).href)) as {
        initSync: (m: { module: Uint8Array }) => unknown;
        render_web_frame: (html: string, w: number, h: number) => string;
        render_web_flow: (html: string, framesJson: string, flowRoot: string) => string;
      };
      glue.initSync({ module: readFileSync(wasmPath) });
      engine = {
        render: (html, w, hh) => parseSceneLayer(glue.render_web_frame(html, w, hh)),
        renderFlow: (html, frames, flowRoot) =>
          parseFlowResult(glue.render_web_flow(html, JSON.stringify(frames), flowRoot ?? "")),
      };
    });
    afterAll(() => h?.dispose());

    it("bakes the web frame into native content (swatches + rect + text frame)", async () => {
      const storiesBefore = await storyCount(h);

      const outcome = await bakeWebFrameToDocument(h.host, frame, engine);

      // Real native content was created — not the not-loaded fallback.
      expect(outcome.baked).toBe(true);
      expect(outcome.createdCount).toBeGreaterThan(0);
      expect(outcome.swatchCount).toBeGreaterThan(0);

      // Each baked text run mints a native story → the stories collection grew.
      const storiesAfter = await storyCount(h);
      expect(storiesAfter).toBeGreaterThan(storiesBefore);

      // The colour lane really applied: a `Color/wb-…` swatch now exists in
      // the document (createSwatch landed against the real engine, so the
      // rect/text `colorRef`s resolve — not a dangling reference).
      const swatches = await h.host.document.collection<{ selfId: string }>("swatches");
      expect(swatches.some((s) => s.selfId.startsWith("Color/wb-"))).toBe(true);
    });

    it("a real Blitz border-radius fill bakes as a native PATH (Phase F, real wasm)", () => {
      // A rounded-rect background renders to a non-rectangular single-subpath
      // fill; the translator turns it into a native path (not a deferred item).
      const html =
        "<html><body style='margin:0'>" +
        "<div style='width:100px;height:60px;background:#cc3333;border-radius:14px'></div>" +
        "</body></html>";
      const layer = engine.render(html, 200, 120);
      expect(layer).not.toBeNull();
      const plan = sceneLayerToBakePlan(layer!);
      // Real Blitz emits non-rectangular single-subpath fills for the rounded
      // corners → at least one native PATH (Phase F). (Complex border-radius
      // also yields some multi-subpath fills, honestly deferred — the point is
      // that non-rect fills now bake instead of ALL being dropped.)
      expect(plan.paths.length).toBeGreaterThanOrEqual(1);
    });

    it("a non-web-frame selection bakes nothing (honest, no crash)", async () => {
      // Baking an id that carries no web source returns the honest not-a-web-
      // frame outcome — never throws, never invents content. (Uses a bogus
      // element id: `asFrameTarget` accepts the shape but `getMetadata`/part
      // read yields no source.)
      const bogus = { kind: "rectangle", id: "uNOTWEB" } as unknown as ElementId;
      const outcome = await bakeWebFrameToDocument(h.host, bogus, engine);
      expect(outcome.baked).toBe(false);
      expect(outcome.createdCount).toBe(0);
    });

    it("bakes a threaded FLOW into native content across both frames", async () => {
      // Insert a source + a recipient, give the source enough content to spill
      // past the source frame, and bake the whole flow. Each baked text run
      // mints a story → the stories collection grows by exactly the created
      // count, and content lands across BOTH frames (createdCount > a single
      // frame's worth).
      const insert = h.contributions.find(
        (x) => x.kind === "command" && x.id === "media.paged.web.command.insertWebFrame",
      )!.value as { handler: (a: unknown) => unknown };
      await insert.handler(undefined);
      const src = h.host.selection.get()[0];
      await insert.handler(undefined);
      const rcp = h.host.selection.get()[0];

      const many = Array.from({ length: 24 }, (_v, i) => `<p>Row ${i}</p>`).join("");
      await persistSource(h.host, src, {
        ...SOURCE,
        html: many,
        css: "body{margin:0}p{margin:0;font-size:14px;line-height:20px}",
      });

      const before = await storyCount(h);
      const outcome = await bakeWebFlowToDocument(h.host, [src, rcp], engine);

      expect(outcome.baked).toBe(true);
      // A single ~180pt frame holds ~9 rows; >10 baked proves the spill into
      // the RECIPIENT frame was materialised too (a real cross-frame flow bake).
      expect(outcome.createdCount).toBeGreaterThan(10);
      // One native story per baked text run (all-text source → no rects).
      const delta = (await storyCount(h)) - before;
      expect(delta).toBe(outcome.createdCount);
    });
  },
);
