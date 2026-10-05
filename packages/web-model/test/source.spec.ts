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
  contentHash,
  DEFAULT_SOURCE,
  envelopeFor,
  hasNoLegacyPart,
  isWebFrameEnvelope,
  LABEL_INLINE_MAX_BYTES,
  LABEL_MAX_BYTES,
  sourceFromPartText,
  sourcePartPath,
  sourceRefOf,
  storeSource,
  utf8Length,
  flowChainOf,
  flowGroups,
  MAX_VIEWPORT_WIDTH,
  normalizeFlowChain,
  normalizeViewportWidth,
  SOURCE_METADATA_VERSION,
  sourceFromEnvelope,
  withRecipient,
  withoutRecipient,
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

describe("flow chain — persisted region chain (ADR-020 rung 2)", () => {
  const base: WebFrameSource = {
    html: "<article>x</article>",
    css: "",
    options: { media: "print", overflow: "clip" },
  };
  const A = { kind: "rectangle", id: "uA" };
  const B = { kind: "rectangle", id: "uB" };
  const C = { kind: "textFrame", id: "uC" };

  it("round-trips a threaded source through the envelope (additive-optional v1)", () => {
    const threaded: WebFrameSource = { ...base, flow: { recipients: [B, C] } };
    expect(sourceFromEnvelope(envelopeFor(threaded))).toEqual(threaded);
    // Still envelope v1 — the chain is additive-optional, no version bump.
    expect(envelopeFor(threaded).v).toBe(SOURCE_METADATA_VERSION);
  });

  it("a legacy (no-flow) envelope reads as a non-threaded source", () => {
    const back = sourceFromEnvelope(envelopeFor(base));
    expect(back?.flow).toBeUndefined();
    expect(flowChainOf(back!, A)).toEqual([A]);
  });

  it("normalizeFlowChain de-dupes by id and rejects malformed entries", () => {
    expect(
      normalizeFlowChain({
        recipients: [B, { kind: "rectangle", id: "uB" }, C, { id: "noKind" }, 7, "s"],
      }),
    ).toEqual({ recipients: [B, C] });
    expect(normalizeFlowChain({ recipients: [] })).toBeUndefined();
    expect(normalizeFlowChain({ recipients: "uB" })).toBeUndefined();
    expect(normalizeFlowChain(null)).toBeUndefined();
    expect(normalizeFlowChain([B])).toBeUndefined();
  });

  it("a malformed flow reads as not-threaded, never poisons the source", () => {
    const env = envelopeFor(base);
    (env.data as { flow?: unknown }).flow = { recipients: [1, 2] };
    const back = sourceFromEnvelope(env);
    expect(back).not.toBeNull();
    expect(back?.flow).toBeUndefined();
  });

  it("flowChainOf puts the source frame first", () => {
    const s: WebFrameSource = { ...base, flow: { recipients: [B, C] } };
    expect(flowChainOf(s, A)).toEqual([A, B, C]);
  });

  it("withRecipient appends, de-dupes by id, and never threads into itself", () => {
    const s1 = withRecipient(base, A, B);
    expect(s1.flow).toEqual({ recipients: [B] });
    const s2 = withRecipient(s1, A, { kind: "oval", id: "uB" }); // dup id → no-op
    expect(s2).toBe(s1);
    const s3 = withRecipient(s1, A, A); // self → no-op
    expect(s3).toBe(s1);
    const s4 = withRecipient(s1, A, C);
    expect(s4.flow).toEqual({ recipients: [B, C] });
  });

  it("withoutRecipient removes by id, dropping the flow field when empty", () => {
    const s = { ...base, flow: { recipients: [B, C] } };
    expect(withoutRecipient(s, "uB").flow).toEqual({ recipients: [C] });
    expect(withoutRecipient(withoutRecipient(s, "uB"), "uC").flow).toBeUndefined();
    expect(withoutRecipient(s, "uZ")).toBe(s); // absent → no-op
  });

  it("flowGroups splits recipients into named flows + a source-anchored primary", () => {
    const s: WebFrameSource = {
      ...base,
      flow: { recipients: [B, { ...C, flow: "notes" }] },
    };
    expect(flowGroups(s, A)).toEqual([
      { name: "", frames: [A, B] }, // primary = source + untagged B
      { name: "notes", frames: [C] }, // the named flow
    ]);
    // The primary chain excludes named-flow recipients.
    expect(flowChainOf(s, A)).toEqual([A, B]);
  });

  it("withRecipient can route a recipient to a named flow", () => {
    const s = withRecipient(base, A, B, "notes");
    expect(s.flow?.recipients).toEqual([{ ...B, flow: "notes" }]);
    // B is in the named flow, so the primary chain is just the source.
    expect(flowChainOf(s, A)).toEqual([A]);
    expect(flowGroups(s, A)).toEqual([
      { name: "", frames: [A] },
      { name: "notes", frames: [B] },
    ]);
  });

  it("a named-flow recipient round-trips through the envelope", () => {
    const s: WebFrameSource = { ...base, flow: { recipients: [{ ...B, flow: "notes" }] } };
    expect(sourceFromEnvelope(envelopeFor(s))).toEqual(s);
  });
});

describe("large sources: label pointer + content-addressed part", () => {
  const small = { ...DEFAULT_SOURCE };
  const large = { ...DEFAULT_SOURCE, html: "<p>é😀</p>".repeat(12000) };

  it("utf8Length counts UTF-8 bytes (BMP, astral, ASCII)", () => {
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    expect(utf8Length("<p>é😀</p>")).toBe(new TextEncoder().encode("<p>é😀</p>").length);
  });

  it("contentHash is 16 hex digits, deterministic, and content-sensitive", () => {
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });

  it("a small source stays inline; its label decodes to the source", () => {
    const stored = storeSource(small);
    expect(stored.kind).toBe("inline");
    expect(sourceFromEnvelope(stored.label)).toEqual(small);
    expect(sourceRefOf(stored.label)).toBeNull();
    expect(isWebFrameEnvelope(stored.label)).toBe(true);
  });

  it("a large source becomes a part + a small pointer label that names it", () => {
    const stored = storeSource(large);
    expect(stored.kind).toBe("part");
    if (stored.kind !== "part") return;
    expect(utf8Length(JSON.stringify(stored.label))).toBeLessThan(LABEL_INLINE_MAX_BYTES);
    expect(utf8Length(JSON.stringify(stored.label))).toBeLessThan(LABEL_MAX_BYTES);
    expect(sourceFromEnvelope(stored.label)).toBeNull(); // not an inline source
    expect(isWebFrameEnvelope(stored.label)).toBe(true); // but still a web frame
    expect(sourceRefOf(stored.label)).toEqual(stored.ref);
    expect(sourcePartPath(stored.ref)).toBe(`sources/${stored.ref.hash}.json`);
    expect(sourceFromPartText(stored.partText, stored.ref)).toEqual(large);
  });

  it("a part whose content does not match the pointer is never read", () => {
    const stored = storeSource(large);
    if (stored.kind !== "part") throw new Error("expected a part");
    expect(sourceFromPartText(stored.partText.replace("é", "e"), stored.ref)).toBeNull();
  });

  it("a malformed pointer reads as no pointer", () => {
    expect(sourceRefOf({ v: 1, data: { ref: { hash: "zz", bytes: 1 } } })).toBeNull();
    expect(sourceRefOf({ v: 1, data: { ref: "x" } })).toBeNull();
    expect(sourceRefOf({ v: 2, data: { ref: { hash: "0123456789abcdef", bytes: 1 } } })).toBeNull();
    expect(isWebFrameEnvelope(null)).toBe(false);
  });
});

describe("the single writer's no-legacy-part marker", () => {
  it("every envelope the writer produces carries it — inline and pointer", () => {
    expect(hasNoLegacyPart(envelopeFor(DEFAULT_SOURCE))).toBe(true);
    const large = { ...DEFAULT_SOURCE, html: "<p>x</p>".repeat(20_000) };
    const stored = storeSource(large);
    expect(stored.kind).toBe("part");
    expect(hasNoLegacyPart(stored.label)).toBe(true);
    expect(sourceRefOf(stored.label)).not.toBeNull();
  });

  it("an envelope from the earlier writer has none, and the marker is not part of the source", () => {
    expect(hasNoLegacyPart({ v: 1, data: { html: "<p>x</p>", css: "" } })).toBe(false);
    expect(hasNoLegacyPart(null)).toBe(false);
    expect(sourceFromEnvelope(envelopeFor(DEFAULT_SOURCE))).toEqual(DEFAULT_SOURCE);
  });
});
