// Conformance — webFrame SOURCE metadata round-trip against the REAL
// engine. The source persists as an `x-paged:media.paged.web` envelope
// (web-model's `envelopeFor` / `sourceFromEnvelope` are the single
// (de)serialization point). This proves, through the true v34 metadata
// carrier:
//   · write → read recovers the source byte-for-byte (within session);
//   · an EDIT (re-write) replaces it; the latest wins;
//   · the envelope survives an unrelated document mutate;
//   · a foreign / unknown-version envelope reads as "not a web frame".
//
// CROSS-RELOAD RESIDUAL (wire limit, present through protocol v35 — the
// currently-vendored stamp): re-loading IDML bytes that already CARRY an
// authored `Properties/Label` `KeyValuePair` does NOT surface through
// `getMetadata` headlessly (the read accessor returns metadata written
// via `setPluginMetadata` IN-session, not pre-existing Label entries).
// So persistence is proven within a session here; the IDML-authored-
// Label read path is a future engine target. The pinned-gap test below
// documents it so a fix flips the assert.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  DEFAULT_SOURCE,
  envelopeFor,
  sourceFromEnvelope,
  type WebFrameSource,
} from "@paged-media/web-model";

import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { packageOf } from "../fixtures/build-idml";
import { openHost } from "./host";

/** Insert a plain frame on the page + return its ElementId — the
 *  carrier a source envelope attaches to (the bundle's insert does the
 *  same, in one batch; here we split so each metadata assertion is
 *  isolated). */
async function insertCarrier(h: HeadlessHost): Promise<{ kind: string; id: string }> {
  const out = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [60, 60, 240, 300] },
  } as never);
  expect(out.applied).toBe(true);
  if (!out.applied || !out.createdId) throw new Error("no carrier created");
  return out.createdId as never;
}

const xmlAttr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

describe("web conformance — source metadata round-trip", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
  });
  afterAll(() => h?.dispose());

  it("write → read recovers the source envelope verbatim", async () => {
    const carrier = await insertCarrier(h);
    const set = await h.host.document.setMetadata(
      carrier as never,
      envelopeFor(DEFAULT_SOURCE),
    );
    expect(set.applied).toBe(true);
    const env = await h.host.document.getMetadata(carrier as never);
    expect(sourceFromEnvelope(env as never)).toEqual(DEFAULT_SOURCE);
    await h.host.document.undo(); // remove the carrier frame
  });

  it("a re-write replaces the source (latest wins)", async () => {
    const carrier = await insertCarrier(h);
    await h.host.document.setMetadata(carrier as never, envelopeFor(DEFAULT_SOURCE));
    const edited: WebFrameSource = {
      html: "<h1>Edited</h1>",
      css: "h1 { color: rebeccapurple; }",
      // The full options shape — incl. the Phase 2c viewportWidth —
      // rides the same envelope through the real engine carrier.
      options: { media: "screen", overflow: "clip", viewportWidth: 480 },
    };
    await h.host.document.setMetadata(carrier as never, envelopeFor(edited));
    const env = await h.host.document.getMetadata(carrier as never);
    expect(sourceFromEnvelope(env as never)).toEqual(edited);
    await h.host.document.undo(); // pop the re-write
    await h.host.document.undo(); // pop the first write
    await h.host.document.undo(); // remove the carrier frame
  });

  it("the source survives an unrelated document mutate", async () => {
    const carrier = await insertCarrier(h);
    await h.host.document.setMetadata(carrier as never, envelopeFor(DEFAULT_SOURCE));
    // An unrelated insert on the same page.
    const other = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [300, 300, 360, 360] },
    } as never);
    expect(other.applied).toBe(true);
    const env = await h.host.document.getMetadata(carrier as never);
    expect(sourceFromEnvelope(env as never)).toEqual(DEFAULT_SOURCE);
    await h.host.document.undo(); // other frame
    await h.host.document.undo(); // source write
    await h.host.document.undo(); // carrier frame
  });

  it("an unknown-version envelope reads as 'not a web frame' (null)", () => {
    // web-model refuses to guess a foreign / future envelope shape.
    expect(sourceFromEnvelope({ v: 99, data: {} } as never)).toBeNull();
    expect(sourceFromEnvelope(null)).toBeNull();
  });

  it("KNOWN WIRE LIMIT: an IDML-authored x-paged Label does not read back headlessly", async () => {
    // A document whose rectangle already CARRIES the source as a
    // Properties/Label KeyValuePair (the cross-reload persistence path
    // the facility design targets). It parses, but the read accessor
    // does not surface a pre-authored Label (present through v35).
    const env = JSON.stringify(envelopeFor(DEFAULT_SOURCE));
    const rect =
      `<Rectangle Self="uweb" GeometricBounds="60 60 240 300" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black">` +
      `<Properties><Label><KeyValuePair Key="x-paged:media.paged.web" Value="${xmlAttr(env)}"/></Label>` +
      `<PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>` +
      `<PathPointType Anchor="60 60" LeftDirection="60 60" RightDirection="60 60"/>` +
      `<PathPointType Anchor="60 300" LeftDirection="60 300" RightDirection="60 300"/>` +
      `<PathPointType Anchor="240 300" LeftDirection="240 300" RightDirection="240 300"/>` +
      `<PathPointType Anchor="240 60" LeftDirection="240 60" RightDirection="240 60"/>` +
      `</PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>`;
    const probe = await openHost();
    try {
      const pages = await probe.load(packageOf({ spreadBody: rect }));
      expect(pages).toEqual(["usp"]); // it PARSES
      const got = await probe.host.document.getMetadata({
        kind: "rectangle",
        id: "uweb",
      } as never);
      expect(got).toBeNull(); // …but the pre-authored Label is not surfaced (v35)
    } finally {
      probe.dispose();
    }
  });
});
