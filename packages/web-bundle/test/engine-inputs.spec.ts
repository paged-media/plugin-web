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

// Faces and resources the engine is handed (engine-inputs.ts): what the
// source names is read from the document — the asset store's faces, the
// container's `resources/` parts, placed images — once per engine, and what
// did not load or fell back is said.

import { describe, expect, it } from "vitest";

import {
  faceDiagnostics,
  prepareEngineInputs,
  relativePath,
  resourceDiagnostics,
  resourceUrls,
} from "../src/engine-inputs";
import type { WebEngine } from "../src/engine-loader";

function fakeEngine() {
  const fonts: [number, string][] = [];
  const resources = new Map<string, Uint8Array>();
  const engine: WebEngine = {
    render: () => ({ items: [] }),
    renderFlow: () => null,
    registerFont: (bytes, family) => {
      fonts.push([bytes.byteLength, family]);
      return [family];
    },
    registerResource: (url, bytes) => void resources.set(url, bytes),
    hasResource: (url) => resources.has(url),
    takeResourceMisses: () => ["missing.png", "https://example.com/a.png"],
  };
  return { engine, fonts, resources };
}

function fakeHost(parts: Record<string, string> = {}, faces: Record<string, number> = {}) {
  const calls: string[] = [];
  const host = {
    supports: (cap: string) => ["assets.fonts@1", "assets.images@1", "storage.parts@1"].includes(cap),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    assets: {
      getFontFace: async (family: string, style?: string) => {
        calls.push(`face:${family}/${style ?? ""}`);
        const n = faces[`${family}/${style ?? ""}`];
        return n ? { bytes: new Uint8Array(n), format: "truetype", family } : null;
      },
      getPlacedImage: async (id: string) => {
        calls.push(`image:${id}`);
        return { bytes: new Uint8Array([9]), uri: "x", width: 1, height: 1 };
      },
    },
    parts: {
      read: async (path: string) => {
        calls.push(`part:${path}`);
        return path in parts ? new TextEncoder().encode(parts[path]) : null;
      },
    },
  };
  return { host: host as never, calls };
}

describe("resource URLs @feat:plugin-web.resources", () => {
  it("finds img src, linked stylesheets, CSS url() and @import, deduplicated", () => {
    const doc =
      '<link rel="stylesheet" href="css/a.css"><link rel="icon" href="fav.ico">' +
      "<img src='img/1.png'><img src=img/1.png>" +
      '<style>@import "css/b.css"; .x{background:url( "img/2.png" )}</style>';
    expect(resourceUrls(doc)).toEqual(["img/1.png", "css/a.css", "img/2.png", "css/b.css"]);
  });

  it("resolves relative paths against a stylesheet's directory; refuses schemes", () => {
    expect(relativePath("./img/a.png?v=1")).toBe("img/a.png");
    expect(relativePath("../img/a.png", "css/")).toBe("img/a.png");
    expect(relativePath("/img/a.png", "css/")).toBe("img/a.png");
    expect(relativePath("https://x.test/a.png")).toBeNull();
    expect(relativePath("data:image/png;base64,AA")).toBeNull();
    expect(relativePath("#frag")).toBeNull();
  });
});

describe("handing the engine its inputs @feat:plugin-web.resources", () => {
  it("reads resources from the container once, following a stylesheet's own URLs", async () => {
    const { engine, resources } = fakeEngine();
    const { host, calls } = fakeHost({
      "resources/css/site.css": ".x{background:url(../img/bg.png)}",
      "resources/img/bg.png": "png",
      "resources/img/a.png": "png",
    });
    const doc = '<link rel="stylesheet" href="css/site.css"><img src="img/a.png"><img src="img/none.png">';
    await prepareEngineInputs(host, engine, doc);
    expect([...resources.keys()].sort()).toEqual(["css/site.css", "img/a.png", "img/bg.png"]);
    const reads = calls.length;
    await prepareEngineInputs(host, engine, doc);
    // Registered ones are not read again; only the missing one is retried.
    expect(calls.slice(reads)).toEqual(["part:resources/img/none.png"]);
  });

  it("serves a placed image of the document under paged-image:<element id>", async () => {
    const { engine, resources } = fakeEngine();
    const { host } = fakeHost();
    await prepareEngineInputs(host, engine, '<img src="paged-image:u1a">');
    expect([...resources.keys()]).toEqual(["paged-image:u1a"]);
  });

  it("what did not load is a problem; the network is named as the reason", () => {
    const { engine } = fakeEngine();
    const msgs = resourceDiagnostics(engine).map((d) => d.message);
    expect(msgs[0]).toMatch(/“missing.png” is not in the document/);
    expect(msgs[1]).toMatch(/loads nothing from the network/);
  });
});

describe("faces @feat:plugin-web.web-fonts", () => {
  it("registers the document faces the source names, in the styles it uses, once per engine", async () => {
    const { engine, fonts } = fakeEngine();
    const { host, calls } = fakeHost({}, { "Lora/": 100, "Lora/Bold": 120 });
    const doc = "<style>h1{font-family:Lora, serif}</style><h1>T</h1>";
    await prepareEngineInputs(host, engine, doc);
    expect(fonts).toEqual([
      [100, "Lora"],
      [120, "Lora"],
    ]);
    expect(calls).toEqual(["face:Lora/", "face:Lora/Bold"]);
    await prepareEngineInputs(host, engine, doc);
    expect(calls).toHaveLength(2);
  });

  it("a source naming no family asks the host nothing", async () => {
    const { engine } = fakeEngine();
    const { host, calls } = fakeHost();
    await prepareEngineInputs(host, engine, "<p>plain</p>");
    expect(calls).toEqual([]);
  });

  it("font fallbacks from the submit reply become problems — not the bundled face", () => {
    expect(faceDiagnostics(undefined)).toEqual([]);
    expect(faceDiagnostics({ fontFallbacks: ["Inter", "Inter Bold", "Lora Italic"] }).map((d) => d.message)).toEqual([
      "font “Lora Italic” is not in the document — the canvas draws it in the default font",
    ]);
  });
});
