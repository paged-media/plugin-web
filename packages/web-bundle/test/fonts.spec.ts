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

// W1 — font registration parity wiring.
//
// Three seams the panel relies on, proven against the real in-process
// host adapter (no DOM):
//   1. the `fonts` collection door crosses the document's font FAMILY
//      names (FontSummary; no bytes) into the bundle;
//   2. the panel's diagnostic set (HTML + font parity) reaches the host
//      Problems sink keyed by (bundleId, sourceKey) — i.e. font
//      diagnostics publish exactly like the §6.1 policy errors do;
//   3. `previewFontBadge` derives the honest substitution-badge state.
//
// Bytes WERE out of scope when this spec was born (no serving door);
// since W-06 landed end-to-end (editor adapter serves REAL engine
// font bytes through `host.assets.getFontFace`, v43) the second half
// of this spec covers the real-bytes path: a mock host serving
// `FontFaceAsset` → `resolvePreviewFontFaces` (the SAME unit the
// panel effect runs) → a data-url `@font-face` inside the srcdoc +
// the substitution badge clearing. `null` answers keep the badge.

import { describe, expect, it } from "vitest";

import type {
  Diagnostic,
  FontFaceAsset,
  PagedEditor,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createRecordableAssetSource,
} from "@paged-media/plugin-sdk";
import {
  composeFontFaces,
  composeSrcdoc,
  diagnoseFonts,
  diagnoseHtml,
  sourceKeyFor,
  type WebFrameSource,
} from "@paged-media/web-model";

import { webBundle } from "../src";
import { resolvePreviewFontFaces } from "../src/panels/font-resolution";
import { previewFontBadge } from "../src/panels/web-source-panel";

const manifest = webBundle.manifest;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

// An editor whose `fonts` collection returns FontSummary-shaped rows —
// the only collection this test exercises.
function fakeEditorWithFonts(
  fonts: Array<{ family: string; referenceCount?: number }>,
): PagedEditor {
  return {
    client: {
      collection: async (name: string) => (name === "fonts" ? fonts : []),
    },
  } as unknown as PagedEditor;
}

describe("fonts collection door (W1)", () => {
  it("crosses document font FAMILY names into the bundle (names only — no bytes)", async () => {
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([
        { family: "IBM Plex Sans", referenceCount: 12 },
        { family: "Source Serif", referenceCount: 3 },
      ]),
      manifest,
      { console: silent, storage: mapBacking() },
    );
    const rows = await host.document.collection<{ family: string }>("fonts");
    expect(rows.map((r) => r.family)).toEqual([
      "IBM Plex Sans",
      "Source Serif",
    ]);
    // The row shape carries NO face bytes — parity is name-based only.
    expect(rows[0]).not.toHaveProperty("bytes");
  });
});

describe("font diagnostics → host.diagnostics fan-out (W1)", () => {
  it("publishes parity diagnostics to the problems sink keyed by source", () => {
    const published: Array<{ bundleId: string; key: string; diags: Diagnostic[] }> =
      [];
    const { host } = createBundleHost(() => fakeEditorWithFonts([]), manifest, {
      console: silent,
      storage: mapBacking(),
      diagnosticsSink: {
        publish: (bundleId, key, diags) =>
          published.push({ bundleId, key, diags }),
        clear: () => {},
      },
    });

    // What the panel's `commit` publishes: HTML + font parity, against a
    // registry that has "Inter" but not "Ghost Sans".
    const key = sourceKeyFor({ kind: "rectangle", id: "uWEB1" });
    const families = ["Inter"];
    const html = "<p>hello</p>";
    const css = 'p { font-family: "Ghost Sans", Inter, sans-serif; }';
    host.diagnostics.set(key, [
      ...diagnoseHtml(html),
      ...diagnoseFonts(css, families),
    ]);

    expect(published).toHaveLength(1);
    expect(published[0].bundleId).toBe("media.paged.web");
    expect(published[0].key).toBe(key);

    const diags = published[0].diags;
    // "font not in document" — a warning on the css source.
    const missing = diags.find(
      (d) => d.severity === "warning" && /not in the document/.test(d.message),
    );
    expect(missing?.source).toBe("css");
    expect(missing?.message).toContain("Ghost Sans");
    // "document font not previewable" — an info on the matched family.
    const previewable = diags.find(
      (d) => d.severity === "info" && /not previewable/.test(d.message),
    );
    expect(previewable?.message).toContain("Inter");
  });

  it("publishes no font diagnostics when the registry is empty (absence ≠ missing)", () => {
    const css = 'p { font-family: "Whatever"; }';
    expect(diagnoseFonts(css, [])).toEqual([]);
  });
});

describe("previewFontBadge — badge state logic (W1)", () => {
  it("hidden when the source uses no (non-generic) families", () => {
    expect(previewFontBadge("p { color: red; }", ["Inter"]).show).toBe(false);
    expect(previewFontBadge("p { font-family: serif; }", ["Inter"]).show).toBe(
      false,
    );
  });

  it("shows with INFO severity when every used family is in the document", () => {
    const b = previewFontBadge('p { font-family: Inter; }', ["Inter"]);
    expect(b.show).toBe(true);
    expect(b.severity).toBe("info");
    expect(b.matched).toEqual(["Inter"]);
    expect(b.unregistered).toEqual([]);
    // No bytes shown (W1 default) → still SUBSTITUTING, not flipped.
    expect(b.state).toBe("substituting");
    expect(b.shown).toEqual([]);
  });

  it("escalates to REVIEW severity when a used family is missing from the document", () => {
    const b = previewFontBadge(
      'p { font-family: "Ghost Sans", Inter; }',
      ["Inter"],
    );
    expect(b.show).toBe(true);
    expect(b.severity).toBe("review");
    expect(b.unregistered).toEqual(["Ghost Sans"]);
    expect(b.matched).toEqual(["Inter"]);
  });

  it("shows (substituting) even when the document registry is empty", () => {
    const b = previewFontBadge('p { font-family: "Anything"; }', []);
    expect(b.show).toBe(true);
    expect(b.severity).toBe("review");
    expect(b.unregistered).toEqual(["Anything"]);
  });
});

describe("previewFontBadge — the W-06 flip (document fonts shown)", () => {
  it("FLIPS to 'shown' when every used+registered family was served bytes", () => {
    const b = previewFontBadge(
      'p { font-family: Inter; }',
      ["Inter"],
      ["Inter"],
    );
    expect(b.show).toBe(true);
    expect(b.state).toBe("shown");
    expect(b.severity).toBe("info");
    expect(b.shown).toEqual(["Inter"]);
  });

  it("stays 'substituting' when a matched family had NO bytes served", () => {
    const b = previewFontBadge(
      'p { font-family: Inter, Lora; }',
      ["Inter", "Lora"],
      ["Inter"], // Lora not served
    );
    expect(b.state).toBe("substituting");
    expect(b.shown).toEqual(["Inter"]);
  });

  it("stays 'substituting' (review) when an unregistered family is used, even if matched ones are shown", () => {
    const b = previewFontBadge(
      'p { font-family: "Ghost", Inter; }',
      ["Inter"],
      ["Inter"],
    );
    expect(b.state).toBe("substituting");
    expect(b.severity).toBe("review");
    expect(b.shown).toEqual(["Inter"]);
    expect(b.unregistered).toEqual(["Ghost"]);
  });

  it("matches shown families case-insensitively against the used set", () => {
    const b = previewFontBadge(
      'p { font-family: "IBM Plex Sans"; }',
      ["IBM Plex Sans"],
      ["ibm plex sans"],
    );
    expect(b.state).toBe("shown");
    expect(b.shown).toEqual(["IBM Plex Sans"]);
  });
});

// The panel's resolution PATH — `resolvePreviewFontFaces`, the SAME
// unit the panel effect runs (not a test-side mirror) — exercised
// end-to-end against the real SDK door + a recordable fake source
// serving REAL bytes (the editor does this for engine-registered
// families since W-06 landed v43): for each used+registered family the
// door serves a `FontFaceAsset`, the bytes inline as a data-url
// `@font-face` in the srcdoc, and the substitution badge clears.
// `null` answers (no bytes / no source) keep the badge.
describe("asset resolution → data-url @font-face in the srcdoc + badge flip (W-06)", () => {
  const interBytes = [0x4d, 0x61, 0x6e]; // "Man" → base64 "TWFu"
  const inter: FontFaceAsset = {
    bytes: new Uint8Array(interBytes),
    format: "truetype",
    family: "Inter",
    postscriptName: "Inter-Regular",
  };

  const sourceWith = (css: string): WebFrameSource => ({
    html: "<p>hi</p>",
    css,
    options: { media: "print", overflow: "clip" },
  });

  it("serves bytes for a used+registered family → the srcdoc carries the data-url @font-face and the badge flips", async () => {
    const source = createRecordableAssetSource([inter]);
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }]),
      manifest,
      { console: silent, storage: mapBacking(), assetSource: source },
    );
    expect(host.supports("assets.fonts@1")).toBe(true);

    const css = 'p { font-family: Inter, sans-serif; }';
    const { faces, shown } = await resolvePreviewFontFaces(host, css, [
      "Inter",
    ]);

    // The door was asked for exactly the used+registered family.
    expect(source.requests).toEqual([{ family: "Inter" }]);
    // The face src is the served BYTES inlined as a data url (data:,
    // not blob: — the sandbox="" iframe's opaque origin can't fetch
    // origin-bound object URLs).
    expect(faces).toHaveLength(1);
    expect(faces[0].src).toBe("data:font/ttf;base64,TWFu");
    // …and the srcdoc the preview renders CARRIES it, ahead of the
    // source CSS, inside the single <style>.
    const fontFaceCss = composeFontFaces(faces);
    const srcdoc = composeSrcdoc(sourceWith(css), fontFaceCss);
    expect(srcdoc).toContain(
      '@font-face{font-family:"Inter";' +
        'src:url(data:font/ttf;base64,TWFu) format("truetype");',
    );
    expect(srcdoc.indexOf("@font-face")).toBeLessThan(
      srcdoc.indexOf("font-family: Inter"),
    );
    // The badge flips to "document fonts shown" — the substitution
    // story CLEARS for the served family.
    const badge = previewFontBadge(css, ["Inter"], shown);
    expect(badge.state).toBe("shown");
    expect(badge.shown).toEqual(["Inter"]);
    // And the diagnostics drop the "not previewable" caveat for it.
    expect(diagnoseFonts(css, ["Inter"], shown)).toEqual([]);
  });

  it("a family the host has NO bytes for (null answer) keeps the badge", async () => {
    // Lora is registered but the source only seeds Inter — the Lora
    // read answers null (the honest, frequent answer).
    const source = createRecordableAssetSource([inter]);
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }, { family: "Lora" }]),
      manifest,
      { console: silent, storage: mapBacking(), assetSource: source },
    );
    const css = "p { font-family: Inter, Lora; }";
    const { faces, shown } = await resolvePreviewFontFaces(host, css, [
      "Inter",
      "Lora",
    ]);
    // Both registered families were asked; only Inter resolved.
    expect(source.requests).toEqual([{ family: "Inter" }, { family: "Lora" }]);
    expect(shown).toEqual(["Inter"]);
    // The srcdoc carries Inter's face only.
    const srcdoc = composeSrcdoc(sourceWith(css), composeFontFaces(faces));
    expect(srcdoc).toContain('font-family:"Inter"');
    expect(srcdoc).not.toContain('font-family:"Lora"');
    // Badge: still substituting (Lora has no bytes), info severity.
    const badge = previewFontBadge(css, ["Inter", "Lora"], shown);
    expect(badge.state).toBe("substituting");
    expect(badge.shown).toEqual(["Inter"]);
    // Diagnostics: Lora keeps its "not previewable" info; Inter drops it.
    const diags = diagnoseFonts(css, ["Inter", "Lora"], shown);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Lora");
  });

  it("does NOT ask for an UNREGISTERED family (no bytes can exist) and stays substituting", async () => {
    const source = createRecordableAssetSource([inter]);
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }]),
      manifest,
      { console: silent, storage: mapBacking(), assetSource: source },
    );
    const css = 'p { font-family: "Ghost Sans", Inter; }';
    const { shown } = await resolvePreviewFontFaces(host, css, ["Inter"]);
    // Only the registered family was requested.
    expect(source.requests).toEqual([{ family: "Inter" }]);
    const badge = previewFontBadge(css, ["Inter"], shown);
    expect(badge.state).toBe("substituting");
    expect(badge.severity).toBe("review");
    expect(badge.unregistered).toEqual(["Ghost Sans"]);
  });

  it("EMPTY served bytes are an honest miss, not a zero-byte @font-face", async () => {
    const source = createRecordableAssetSource([
      { ...inter, bytes: new Uint8Array(0) },
    ]);
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }]),
      manifest,
      { console: silent, storage: mapBacking(), assetSource: source },
    );
    const { faces, shown } = await resolvePreviewFontFaces(
      host,
      "p { font-family: Inter; }",
      ["Inter"],
    );
    expect(faces).toEqual([]);
    expect(shown).toEqual([]);
  });

  it("with NO source injected (older hosts / headless), nothing flips — honest substitution stays", async () => {
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }]),
      manifest,
      { console: silent, storage: mapBacking() }, // no assetSource
    );
    expect(host.supports("assets.fonts@1")).toBe(false);
    const css = 'p { font-family: Inter; }';
    // The door still exists + the gate passes (manifest declares it),
    // but every read is null → nothing shown.
    expect(await host.assets.getFontFace("Inter")).toBeNull();
    const { faces, shown } = await resolvePreviewFontFaces(host, css, [
      "Inter",
    ]);
    expect(faces).toEqual([]);
    // No @font-face reaches the srcdoc; the badge stays.
    const srcdoc = composeSrcdoc(sourceWith(css), composeFontFaces(faces));
    expect(srcdoc).not.toContain("@font-face");
    const badge = previewFontBadge(css, ["Inter"], shown);
    expect(badge.state).toBe("substituting");
    expect(badge.shown).toEqual([]);
  });
});
