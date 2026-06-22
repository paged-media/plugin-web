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

// The metadata envelope helpers — the bundle's single
// (de)serialization point for the W-02 carrier (core protocol v33).

import { describe, expect, it } from "vitest";

import {
  envelopeFor,
  MAX_VIEWPORT_WIDTH,
  normalizeViewportWidth,
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

  it("round-trips the viewportWidth option", () => {
    const source: WebFrameSource = {
      html: "<p>x</p>",
      css: "",
      options: { media: "screen", overflow: "clip", viewportWidth: 480 },
    };
    expect(sourceFromEnvelope(envelopeFor(source))).toEqual(source);
  });

  it("a legacy envelope (no viewportWidth) reads as no viewport override", () => {
    const env = { v: 1, data: { html: "<p>x</p>", css: "" } };
    expect(sourceFromEnvelope(env)?.options.viewportWidth).toBeUndefined();
  });

  it("sanitizes an invalid envelope viewportWidth to absent (never poisons the source)", () => {
    const read = (viewportWidth: unknown) =>
      sourceFromEnvelope({
        v: 1,
        data: {
          html: "<p>x</p>",
          css: "",
          options: { media: "print", overflow: "clip", viewportWidth },
        },
      });
    expect(read("480")?.options.viewportWidth).toBeUndefined();
    expect(read(0)?.options.viewportWidth).toBeUndefined();
    expect(read(-320)?.options.viewportWidth).toBeUndefined();
    expect(read(Number.NaN)?.options.viewportWidth).toBeUndefined();
    expect(read(Infinity)?.options.viewportWidth).toBeUndefined();
    // Fractions round; runaway values clamp instead of vanishing.
    expect(read(320.6)?.options.viewportWidth).toBe(321);
    expect(read(1e9)?.options.viewportWidth).toBe(MAX_VIEWPORT_WIDTH);
  });
});

describe("metadata envelope — the §6.2 vars map (additive within v1)", () => {
  it("round-trips a source WITH template vars", () => {
    const source: WebFrameSource = {
      html: "<h1>{{title}}</h1>",
      css: "",
      options: { media: "print", overflow: "clip" },
      vars: { title: "Hello", "product.price": "1234.5" },
    };
    expect(sourceFromEnvelope(envelopeFor(source))).toEqual(source);
  });

  it("a legacy envelope (no vars) reads as NO vars (pass disabled)", () => {
    const env = { v: 1, data: { html: "<p>x</p>", css: "" } };
    expect(sourceFromEnvelope(env)?.vars).toBeUndefined();
  });

  it("an EMPTY vars map round-trips as enabled-but-empty", () => {
    const source: WebFrameSource = {
      html: "<p>x</p>",
      css: "",
      options: { media: "print", overflow: "clip" },
      vars: {},
    };
    expect(sourceFromEnvelope(envelopeFor(source))?.vars).toEqual({});
  });

  it("sanitizes malformed vars instead of poisoning the source", () => {
    const read = (vars: unknown) =>
      sourceFromEnvelope({
        v: 1,
        data: { html: "<p>x</p>", css: "", vars },
      });
    // Non-map shapes read as "no vars" (pass disabled).
    expect(read("nope")?.vars).toBeUndefined();
    expect(read(["a"])?.vars).toBeUndefined();
    expect(read(null)?.vars).toBeUndefined();
    // A map keeps string entries, stringifies numbers, drops the rest.
    expect(read({ a: "x", n: 2, bad: {} })?.vars).toEqual({
      a: "x",
      n: "2",
    });
    // The source itself always survives.
    expect(read("nope")?.html).toBe("<p>x</p>");
  });
});

describe("normalizeViewportWidth", () => {
  it("accepts positive finite numbers (rounded, clamped)", () => {
    expect(normalizeViewportWidth(480)).toBe(480);
    expect(normalizeViewportWidth(480.4)).toBe(480);
    expect(normalizeViewportWidth(1)).toBe(1);
    expect(normalizeViewportWidth(MAX_VIEWPORT_WIDTH + 1)).toBe(
      MAX_VIEWPORT_WIDTH,
    );
  });

  it("reads everything else as no override", () => {
    expect(normalizeViewportWidth(undefined)).toBeUndefined();
    expect(normalizeViewportWidth(null)).toBeUndefined();
    expect(normalizeViewportWidth("480")).toBeUndefined();
    expect(normalizeViewportWidth(0)).toBeUndefined();
    expect(normalizeViewportWidth(0.4)).toBeUndefined(); // rounds below 1
    expect(normalizeViewportWidth(-1)).toBeUndefined();
    expect(normalizeViewportWidth(Number.NaN)).toBeUndefined();
    expect(normalizeViewportWidth(-Infinity)).toBeUndefined();
  });
});
