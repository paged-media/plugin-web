// The paged.web conformance CORPUS — named single-page IDML documents
// that exercise the bundle's REAL surfaces against the headless engine:
// the insert-webFrame batch (single-undo), source-metadata round-trip,
// and the `fonts` collection door that drives font-parity diagnostics.
// Built by the pure-TS IDML builder so the shapes are readable XML and
// the bytes are deterministic — no `zip` tool, no vendored base64.

import { fontsXml, packageOf } from "./build-idml";

export interface WebFixture {
  id: string;
  about: string;
  bytes(): Uint8Array;
  pageId: string;
}

/** W1 — an empty single page: the insert-webFrame target. The frame is
 *  created by the bundle's batch, so the fixture starts with no page
 *  items (the cleanest single-undo proof — count goes 0→1→0). */
export const W1_EMPTY_PAGE: WebFixture = {
  id: "empty-page",
  about: "one empty US-Letter page — the insert-webFrame target",
  pageId: "usp",
  bytes() {
    return packageOf({ spreadBody: "" });
  },
};

/** W2 — a document that registers two font families (a paragraph style
 *  and a character range each apply one), so the `fonts` collection
 *  surfaces "IBM Plex Sans" + "Source Serif Pro". Drives the font-parity
 *  door: a source CSS using those families matches; one it doesn't is
 *  flagged. */
export const W2_FONTS: WebFixture = {
  id: "registered-fonts",
  about: "document registering IBM Plex Sans + Source Serif Pro via styles",
  pageId: "usp",
  bytes() {
    const styles =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
      `<RootCharacterStyleGroup Self="rcs">` +
      `<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>` +
      `</RootCharacterStyleGroup>` +
      `<RootParagraphStyleGroup Self="rps">` +
      `<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]">` +
      `<Properties><AppliedFont type="string">IBM Plex Sans</AppliedFont></Properties>` +
      `</ParagraphStyle></RootParagraphStyleGroup></idPkg:Styles>`;
    const story =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
      `<Story Self="ustory" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="" AppliedNamedGrid="n">` +
      `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/[No paragraph style]">` +
      `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">` +
      `<Properties><AppliedFont type="string">Source Serif Pro</AppliedFont></Properties>` +
      `<Content>Hello from a styled story.</Content>` +
      `</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`;
    const tf =
      `<TextFrame Self="utf" ParentStory="ustory" GeometricBounds="100 100 300 400" ItemTransform="1 0 0 1 0 0"/>`;
    return packageOf({
      spreadBody: tf,
      fonts: fontsXml(["IBM Plex Sans", "Source Serif Pro"]),
      styles,
      stories: [{ id: "ustory", xml: story }],
    });
  },
  // The document's registered font FAMILY names (the `fonts` collection
  // projection the panel feeds web-model). Asserted by the spec.
};

/** The family names W2 registers — the expected `fonts` collection
 *  projection, kept beside the fixture so the spec asserts the door
 *  surfaces exactly these. */
export const W2_FAMILIES = ["IBM Plex Sans", "Source Serif Pro"] as const;

export const WEB_CORPUS: readonly WebFixture[] = [W1_EMPTY_PAGE, W2_FONTS];
