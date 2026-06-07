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
// Bytes are out of scope by contract: there is no door that serves
// font face bytes (the wire `registerFont` is host→worker only), so
// the preview substitutes and the badge says so — serving real
// `@font-face` is the W-06 asset-store dependency.

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
  diagnoseFonts,
  diagnoseHtml,
  fontParity,
  sourceKeyFor,
  type ResolvedFontFace,
} from "@paged-media/web-model";

import { webBundle } from "../src";
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

// The panel's resolution PATH, exercised end-to-end against the real
// SDK door + a recordable fake source: for each matched family the panel
// calls `host.assets.getFontFace`, composes `@font-face`, and the badge
// flips. Proves the bundle's manifest declares `assets: ["fonts"]` (the
// gate passes), the bytes flow, and the composed CSS + badge are right.
describe("asset resolution → @font-face composition + badge flip (W-06)", () => {
  const inter: FontFaceAsset = {
    bytes: new Uint8Array([0, 1, 2, 3]),
    format: "truetype",
    family: "Inter",
    postscriptName: "Inter-Regular",
  };

  /** Mirror the panel's resolution loop (no DOM): resolve matched
   *  families through the door, build ResolvedFontFace[] (src is a
   *  stand-in for the panel's object URL), return the shown names. */
  async function resolve(
    host: ReturnType<typeof createBundleHost>["host"],
    css: string,
    registered: string[],
  ): Promise<{ faces: ResolvedFontFace[]; shown: string[] }> {
    const { matched } = fontParity(css, registered);
    const faces: ResolvedFontFace[] = [];
    const shown: string[] = [];
    for (const family of matched) {
      const asset = await host.assets.getFontFace(family);
      if (!asset) continue;
      faces.push({ family, src: `blob:${family}`, format: asset.format });
      shown.push(family);
    }
    return { faces, shown };
  }

  it("serves bytes for a used+registered family, composes a rule, flips the badge", async () => {
    const source = createRecordableAssetSource([inter]);
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }]),
      manifest,
      { console: silent, storage: mapBacking(), assetSource: source },
    );
    expect(host.supports("assets.fonts@1")).toBe(true);

    const css = 'p { font-family: Inter, sans-serif; }';
    const { faces, shown } = await resolve(host, css, ["Inter"]);

    // The door was asked for exactly the used+registered family.
    expect(source.requests).toEqual([{ family: "Inter" }]);
    // A real @font-face composed from the served bytes.
    const fontFaceCss = composeFontFaces(faces);
    expect(fontFaceCss).toContain('@font-face{font-family:"Inter";');
    expect(fontFaceCss).toContain('format("truetype")');
    // The badge flips to "document fonts shown".
    const badge = previewFontBadge(css, ["Inter"], shown);
    expect(badge.state).toBe("shown");
    expect(badge.shown).toEqual(["Inter"]);
    // And the diagnostics drop the "not previewable" caveat for it.
    expect(diagnoseFonts(css, ["Inter"], shown)).toEqual([]);
  });

  it("does NOT ask for an UNREGISTERED family (no bytes can exist) and stays substituting", async () => {
    const source = createRecordableAssetSource([inter]);
    const { host } = createBundleHost(
      () => fakeEditorWithFonts([{ family: "Inter" }]),
      manifest,
      { console: silent, storage: mapBacking(), assetSource: source },
    );
    const css = 'p { font-family: "Ghost Sans", Inter; }';
    const { shown } = await resolve(host, css, ["Inter"]);
    // Only the registered family was requested.
    expect(source.requests).toEqual([{ family: "Inter" }]);
    const badge = previewFontBadge(css, ["Inter"], shown);
    expect(badge.state).toBe("substituting");
    expect(badge.severity).toBe("review");
    expect(badge.unregistered).toEqual(["Ghost Sans"]);
  });

  it("with NO source injected (the editor's v1 null-path), nothing flips — honest substitution stays", async () => {
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
    const badge = previewFontBadge(css, ["Inter"], []);
    expect(badge.state).toBe("substituting");
    expect(badge.shown).toEqual([]);
  });
});
