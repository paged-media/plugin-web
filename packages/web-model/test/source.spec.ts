// The metadata envelope helpers — the bundle's single
// (de)serialization point for the W-02 carrier (core protocol v33).

import { describe, expect, it } from "vitest";

import {
  envelopeFor,
  SOURCE_METADATA_VERSION,
  sourceFromEnvelope,
  type WebFrameSource,
} from "../src";

describe("metadata envelope (W-02 carrier)", () => {
  it("round-trips a source through envelopeFor/sourceFromEnvelope", () => {
    const source: WebFrameSource = {
      html: '<b>hi & "bye"</b>',
      css: "b { color: red; }",
      options: { media: "screen", overflow: "clip" },
    };
    expect(sourceFromEnvelope(envelopeFor(source))).toEqual(source);
    expect(envelopeFor(source).v).toBe(SOURCE_METADATA_VERSION);
  });

  it("rejects unknown versions and malformed payloads as null", () => {
    expect(sourceFromEnvelope(null)).toBeNull();
    expect(sourceFromEnvelope({ v: 99, data: {} })).toBeNull();
    expect(
      sourceFromEnvelope({ v: 1, data: { html: 1, css: "" } }),
    ).toBeNull();
    expect(sourceFromEnvelope({ v: 1, data: {} })).toBeNull();
  });

  it("normalizes a missing/unknown media option to print", () => {
    const env = { v: 1, data: { html: "<p>x</p>", css: "" } };
    expect(sourceFromEnvelope(env)?.options).toEqual({
      media: "print",
      overflow: "clip",
    });
  });
});
