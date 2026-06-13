// The W-01 RENDER CONTRACT — the engine-agnostic seam (ADR-011). What
// it MUST be today: the HONEST not-loaded path. No Blitz engine is
// bundled (a multi-week wasm fork), so `renderWebFrame` returns no scene
// layer and the documented not-loaded diagnostic. What it must NOT do:
// fake a render (an empty/placeholder SceneLayer would be the exact
// dishonesty the seam exists to avoid). Also covers the engine-pin
// envelope round-trip (the determinism record ADR-011 requires).

import { describe, expect, it } from "vitest";

import {
  ENGINE_NOT_LOADED_MESSAGE,
  ENGINE_PIN,
  engineStamp,
  envelopeFor,
  isRendered,
  pinFromStamp,
  pinMatches,
  renderWebFrame,
  sourceFromEnvelope,
  type WebFrameSource,
  type WebRenderRequest,
} from "../src";

const REQUEST: WebRenderRequest = {
  html: "<h1>{{title}}</h1>",
  css: "h1 { color: red; }",
  vars: { title: "Hi" },
  frameWidthPt: 240,
  frameHeightPt: 180,
  dpi: 300,
};

describe("renderWebFrame — the not-loaded path (W-01)", () => {
  it("returns no scene layer (the engine is not loaded)", () => {
    const r = renderWebFrame(REQUEST);
    expect(r.sceneLayer).toBeNull();
    expect(isRendered(r)).toBe(false);
  });

  it("emits exactly the honest not-loaded diagnostic", () => {
    const r = renderWebFrame(REQUEST);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "info",
      source: "render",
      message: ENGINE_NOT_LOADED_MESSAGE,
    });
  });

  it("is pure + total — same request, same result, never throws", () => {
    const a = renderWebFrame(REQUEST);
    const b = renderWebFrame(REQUEST);
    expect(a).toEqual(b);
    // garbage geometry must not throw (the seam never crashes)
    expect(() =>
      renderWebFrame({ html: "", css: "", frameWidthPt: NaN, frameHeightPt: -1 }),
    ).not.toThrow();
  });

  it("never fakes a render — the scene layer stays strictly null", () => {
    // A request with rich content still yields nothing today: the seam
    // is a declaration, not a renderer. (Guards against a placeholder
    // layer creeping in.)
    const r = renderWebFrame({
      html: "<p>lots of content</p><img src='x'>",
      css: "p { font-size: 99px; } @media print { p { color: blue } }",
      frameWidthPt: 1000,
      frameHeightPt: 1000,
    });
    expect(r.sceneLayer).toBeNull();
  });
});

describe("engine pin — determinism record (ADR-011)", () => {
  it("ENGINE_PIN is the W0 spike's forward-declared stack", () => {
    expect(ENGINE_PIN).toEqual({
      blitz: "0.3.0-alpha.4",
      stylo: "0.17.0",
      anyrender: "0.11.0",
    });
  });

  it("stamps the pin into the source envelope's engine record", () => {
    const source: WebFrameSource = {
      html: "<p>x</p>",
      css: "",
      options: { media: "print", overflow: "clip" },
    };
    const env = envelopeFor(source);
    expect(env.engine).toEqual(engineStamp());
    expect(env.engine).toEqual({
      blitz: "0.3.0-alpha.4",
      stylo: "0.17.0",
      anyrender: "0.11.0",
    });
  });

  it("round-trips the pin: stamp → envelope → read back matches", () => {
    const env = envelopeFor({
      html: "<p>x</p>",
      css: "",
      options: { media: "print", overflow: "clip" },
    });
    const readBack = pinFromStamp(env.engine);
    expect(pinMatches(readBack, ENGINE_PIN)).toBe(true);
  });

  it("a legacy envelope (no stamp) reads as an empty, non-matching pin", () => {
    const empty = pinFromStamp(undefined);
    expect(empty).toEqual({ blitz: "", stylo: "", anyrender: "" });
    expect(pinMatches(empty, ENGINE_PIN)).toBe(false);
  });

  it("the engine stamp does not pollute the decoded source", () => {
    // sourceFromEnvelope must ignore `engine` — the source shape is
    // unchanged by the determinism record.
    const env = envelopeFor({
      html: "<p>x</p>",
      css: "b{}",
      options: { media: "screen", overflow: "clip" },
    });
    const back = sourceFromEnvelope(env);
    expect(back).toEqual({
      html: "<p>x</p>",
      css: "b{}",
      options: { media: "screen", overflow: "clip" },
    });
  });
});
