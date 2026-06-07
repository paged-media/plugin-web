// Conformance — the `fonts` collection door + diagnostics, driven
// against the REAL engine. Two doors the source panel relies on:
//
//   1. FONTS DOOR — a document that registers font families (via styles
//      + story AppliedFont) surfaces them through
//      `host.document.collection("fonts")` as family NAMES (FontSummary;
//      no face bytes). Fed into web-model's parity check.
//   2. DIAGNOSTICS — the linter's findings on a BAD source (the §6.1
//      <script> policy error) and the font-parity findings reach the
//      host problems sink keyed by (bundleId, sourceKey), exactly as the
//      panel publishes them. Here the diagnostics are computed by the
//      pure web-model functions over the REAL fonts-door projection.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  diagnoseFonts,
  diagnoseHtml,
  familiesUsed,
  fontParity,
} from "@paged-media/web-model";

import { W2_FONTS, W2_FAMILIES } from "../fixtures/corpus";
import { openHost } from "./host";

/** The fonts-door projection the panel feeds web-model: family names. */
async function registeredFamilies(h: HeadlessHost): Promise<string[]> {
  const rows = await h.host.document.collection<{ family: string }>("fonts");
  return rows.map((r) => r.family);
}

describe("web conformance — fonts collection door", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(W2_FONTS.bytes());
  });
  afterAll(() => h?.dispose());

  it("surfaces the document's registered font FAMILY names (no bytes)", async () => {
    const rows = await h.host.document.collection<Record<string, unknown>>("fonts");
    expect(rows.map((r) => r.family).sort()).toEqual([...W2_FAMILIES].sort());
    // Name-based parity only — no face bytes cross the door.
    expect(rows[0]).not.toHaveProperty("bytes");
  });

  it("a source CSS using a registered family matches against the door", async () => {
    const families = await registeredFamilies(h);
    const css = 'h1 { font-family: "IBM Plex Sans", sans-serif; }';
    const parity = fontParity(css, families);
    expect(parity.matched).toEqual(["IBM Plex Sans"]);
    expect(parity.unregistered).toEqual([]);
  });

  it("a source CSS using an UNREGISTERED family is flagged against the door", async () => {
    const families = await registeredFamilies(h);
    const css = 'p { font-family: "Ghost Sans", "Source Serif Pro"; }';
    const parity = fontParity(css, families);
    expect(parity.unregistered).toEqual(["Ghost Sans"]);
    expect(parity.matched).toEqual(["Source Serif Pro"]);
  });

  it("font-parity diagnostics: warning for missing, info for matched-but-not-previewable", async () => {
    const families = await registeredFamilies(h);
    const css =
      'h1 { font: 600 18px/1.2 "IBM Plex Sans", sans-serif; }\n' +
      'p  { font-family: "Ghost Sans"; }';
    const diags = diagnoseFonts(css, families);
    const missing = diags.find(
      (d) => d.severity === "warning" && /not in the document/.test(d.message),
    );
    expect(missing?.message).toContain("Ghost Sans");
    const matched = diags.find(
      (d) => d.severity === "info" && /not previewable/.test(d.message),
    );
    expect(matched?.message).toContain("IBM Plex Sans");
    // Every parity diagnostic is sourced to the CSS.
    expect(diags.every((d) => d.source === "css")).toBe(true);
  });
});

describe("web conformance — diagnostics publication on a bad source", () => {
  it("the §6.1 <script> policy error is produced by the linter", () => {
    // The bad-source fixture: a frame whose HTML carries a forbidden
    // <script>. The linter the panel runs on every edit flags it as a
    // POLICY ERROR (page JavaScript never executes).
    const badHtml = "<p>hello</p>\n<script>alert(1)</script>";
    const diags = diagnoseHtml(badHtml);
    const policy = diags.find((d) => d.severity === "error");
    expect(policy?.message).toMatch(/never executes/);
    expect(policy?.line).toBe(2);
  });

  it("a combined HTML + font diagnostic set is what the panel publishes", async () => {
    // The panel publishes diagnoseHtml(html) ++ diagnoseFonts(css, fonts)
    // through host.diagnostics.set; here we assemble the SAME set against
    // the real fonts door and assert both lanes are present.
    const h = await openHost();
    try {
      await h.load(W2_FONTS.bytes());
      const families = await registeredFamilies(h);
      const html = "<p>ok</p>\n<script>bad()</script>";
      const css = 'p { font-family: "Ghost Sans"; }';
      const diags = [...diagnoseHtml(html), ...diagnoseFonts(css, families)];
      // HTML policy error (line 2) + font warning, in one publishable set.
      expect(diags.some((d) => d.severity === "error" && d.source === "html")).toBe(true);
      expect(
        diags.some((d) => d.severity === "warning" && d.source === "css"),
      ).toBe(true);
    } finally {
      h.dispose();
    }
  });

  it("font parity is silent when the document registers no fonts (absence ≠ missing)", async () => {
    // An empty-fonts document: the door returns no families, so parity
    // emits nothing rather than flagging every used family.
    const h = await openHost();
    try {
      const { W1_EMPTY_PAGE } = await import("../fixtures/corpus");
      await h.load(W1_EMPTY_PAGE.bytes());
      const families = await registeredFamilies(h);
      expect(families).toEqual([]);
      expect(diagnoseFonts('p { font-family: "Anything"; }', families)).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it("familiesUsed never crashes on garbage CSS (the scanner is a scanner)", () => {
    expect(() => familiesUsed("p { font-family: ")).not.toThrow();
    expect(() => familiesUsed("/* unterminated")).not.toThrow();
  });
});
