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

import type { Diagnostic, PagedEditor } from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import {
  diagnoseFonts,
  diagnoseHtml,
  sourceKeyFor,
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
