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
  isFlowRendered,
  isRendered,
  pinFromStamp,
  pinMatches,
  renderWebFlow,
  renderWebFrame,
  sourceFromEnvelope,
  type WebFrameSource,
  type WebRenderFlowRequest,
  type WebRenderRequest,
} from "../src";

const FLOW_REQUEST: WebRenderFlowRequest = {
  flowId: "frame-a",
  html: "<article>{{title}} — long body that must thread</article>",
  css: "article { font-size: 12pt; }",
  vars: { title: "Hi" },
  // Deliberately out of chain order to prove the lane sorts by `order`.
  frames: [
    { frameId: "frame-b", order: 1, frameWidthPt: 320, frameHeightPt: 180 },
    { frameId: "frame-a", order: 0, frameWidthPt: 240, frameHeightPt: 180 },
  ],
};

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

describe("renderWebFlow — the not-loaded path (ADR-020 rung 2)", () => {
  it("returns one slot per frame, in chain order, all layers null", () => {
    const r = renderWebFlow(FLOW_REQUEST);
    expect(r.flowId).toBe("frame-a");
    // Sorted by `order` regardless of request order.
    expect(r.frames.map((f) => f.frameId)).toEqual(["frame-a", "frame-b"]);
    expect(r.frames.every((f) => f.sceneLayer === null)).toBe(true);
    expect(isFlowRendered(r)).toBe(false);
    expect(r.overset).toBe(false);
  });

  it("emits exactly the honest not-loaded diagnostic", () => {
    const r = renderWebFlow(FLOW_REQUEST);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "info",
      source: "render",
      message: ENGINE_NOT_LOADED_MESSAGE,
    });
  });

  it("is pure + total — same request, same result, never throws", () => {
    const a = renderWebFlow(FLOW_REQUEST);
    const b = renderWebFlow(FLOW_REQUEST);
    expect(a).toEqual(b);
    // Zero frames + garbage geometry must not throw.
    expect(() =>
      renderWebFlow({ flowId: "x", html: "", css: "", frames: [] }),
    ).not.toThrow();
    expect(renderWebFlow({ flowId: "x", html: "", css: "", frames: [] }).frames).toEqual([]);
  });

  it("never fakes a render — every frame's layer stays strictly null", () => {
    const r = renderWebFlow({
      flowId: "s",
      html: "<p>lots of threaded content</p>".repeat(50),
      css: "p { font-size: 99px }",
      frames: [{ frameId: "s", order: 0, frameWidthPt: 1000, frameHeightPt: 1000 }],
    });
    expect(r.frames.every((f) => f.sceneLayer === null)).toBe(true);
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
