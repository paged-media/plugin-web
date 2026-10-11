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

import { ASSET_BUDGETS } from "@paged-media/plugin-sdk";

import { fontFaceRules, sfntFamily } from "../src/css-faces";
import {
  faceDiagnostics,
  prepareEngineInputs,
  relativePath,
  releaseSceneFaces,
  resourceDiagnostics,
  resourceUrls,
  retainSceneFaces,
} from "../src/engine-inputs";
import type { WebEngine } from "../src/engine-loader";
import { renamedFace } from "./fixtures/fonts";

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
    bundledFont: () => new Uint8Array(7),
  };
  return { engine, fonts, resources };
}

function fakeHost(
  parts: Record<string, string | Uint8Array> = {},
  faces: Record<string, number> = {},
  { sceneFaces = true }: { sceneFaces?: boolean } = {},
) {
  const calls: string[] = [];
  /** Live scene-layer faces the bundle registered: "family/style:bytes". */
  const scene: string[] = [];
  const caps = ["assets.fonts@1", "assets.images@1", "storage.parts@1"];
  if (sceneFaces) caps.push("assets.registerFont@1");
  const host = {
    supports: (cap: string) => caps.includes(cap),
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
      registerFont: async (bytes: Uint8Array, family: string, style?: string) => {
        const entry = `${family}/${style ?? ""}:${bytes.byteLength}`;
        scene.push(entry);
        return { dispose: () => void scene.splice(scene.indexOf(entry), 1) };
      },
    },
    parts: {
      read: async (path: string) => {
        calls.push(`part:${path}`);
        const part = parts[path];
        if (part === undefined) return null;
        return typeof part === "string" ? new TextEncoder().encode(part) : part;
      },
    },
  };
  return { host: host as never, calls, scene };
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

  it("hands the scene-layer face table the faces the engine shapes with: the bundled face and the document's, once per host", async () => {
    const { engine } = fakeEngine();
    const { host, scene } = fakeHost({}, { "Lora/": 100, "Lora/Bold": 120 });
    const doc = "<style>h1{font-family:Lora, serif}</style><h1>T</h1>";
    await prepareEngineInputs(host, engine, doc);
    expect(scene).toEqual(["Inter/:7", "Lora/:100", "Lora/Bold:120"]);
    // A second engine (a reload) shapes with the same faces; the host
    // already has them.
    await prepareEngineInputs(host, fakeEngine().engine, doc);
    expect(scene).toHaveLength(3);
    // A source naming no family still draws in the bundled face.
    const other = fakeHost();
    await prepareEngineInputs(other.host, fakeEngine().engine, "<p>plain</p>");
    expect(other.scene).toEqual(["Inter/:7"]);
    // Deactivation gives every face back.
    await releaseSceneFaces(host);
    expect(scene).toEqual([]);
  });

  it("font fallbacks from the submit reply become problems — the bundled face too, once the host has it", async () => {
    expect(faceDiagnostics(undefined, {})).toEqual([]);
    const reply = { fontFallbacks: ["Inter", "Inter Bold", "Lora Italic"] };
    const { host } = fakeHost();
    await prepareEngineInputs(host, fakeEngine().engine, "<p>x</p>");
    expect(faceDiagnostics(reply, host).map((d) => d.message)).toEqual([
      "font “Inter” is not in the document — the canvas draws it in the default font",
      "font “Inter Bold” is not in the document — the canvas draws it in the default font",
      "font “Lora Italic” is not in the document — the canvas draws it in the default font",
    ]);
  });

  it("on a host that cannot take scene faces the bundled face's fallback stays expected", async () => {
    const { host, scene } = fakeHost({}, {}, { sceneFaces: false });
    await prepareEngineInputs(host, fakeEngine().engine, "<p>x</p>");
    expect(scene).toEqual([]);
    expect(
      faceDiagnostics({ fontFallbacks: ["Inter", "Inter Bold", "Lora Italic"] }, host).map((d) => d.message),
    ).toEqual(["font “Lora Italic” is not in the document — the canvas draws it in the default font"]);
  });
});

describe("@font-face faces reach the canvas @feat:plugin-web.web-fonts", () => {
  const brand = renamedFace("Brand");
  const b64 = (bytes: Uint8Array) => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  it("reads the rules a stylesheet declares: family, sources, weight and style", () => {
    const css =
      "p{color:red} @font-face { font-family: \"Brand Sans\"; src: local(Brand), url(f/a.woff2) format('woff2'), url('f/a.ttf'); font-weight: bold; font-style: italic }" +
      "@font-face{font-family:Plain;src:url(p.otf)}@font-face{src:url(x.ttf)}";
    expect(fontFaceRules(css, "css/")).toEqual([
      { family: "Brand Sans", srcs: ["f/a.woff2", "f/a.ttf"], style: "Bold Italic", base: "css/" },
      { family: "Plain", srcs: ["p.otf"], style: undefined, base: "css/" },
    ]);
    expect(fontFaceRules("@font-face{font-family:L;src:url(l.ttf);font-weight:300}")[0].style).toBe("Light");
    expect(fontFaceRules("@font-face{font-family:V;src:url(v.ttf);font-weight:100 900}")[0].style).toBeUndefined();
  });

  it("reads a face's own family from its name table", () => {
    expect(sfntFamily(brand)).toBe("Brand");
    expect(sfntFamily(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBeNull();
  });

  it("hands a container face to the canvas under the CSS family, once per host and bytes", async () => {
    const { host, scene } = fakeHost({ "resources/fonts/brand.ttf": brand });
    const doc = "<style>@font-face{font-family:'Brand';src:url(fonts/brand.ttf)}p{font-family:Brand}</style><p>x</p>";
    expect(await prepareEngineInputs(host, fakeEngine().engine, doc, "uA")).toEqual([]);
    expect(scene).toEqual(["Inter/:7", `Brand/:${brand.byteLength}`]);
    await prepareEngineInputs(host, fakeEngine().engine, doc, "uB");
    expect(scene).toHaveLength(2);
  });

  it("registers under the face's own family too when the CSS names it differently (the run names that one)", async () => {
    const { host, scene } = fakeHost();
    const doc =
      `<style>@font-face{font-family:Display;font-weight:700;src:url(data:font/ttf;base64,${b64(brand)})}</style><p>x</p>`;
    await prepareEngineInputs(host, fakeEngine().engine, doc, "uA");
    expect(scene.slice(1).sort()).toEqual([`Brand/Bold:${brand.byteLength}`, `Display/Bold:${brand.byteLength}`]);
  });

  it("follows a linked stylesheet's @font-face, relative to the stylesheet", async () => {
    const { host, scene } = fakeHost({
      "resources/css/site.css": "@font-face{font-family:Brand;src:url(../fonts/b.ttf)}",
      "resources/fonts/b.ttf": brand,
    });
    await prepareEngineInputs(host, fakeEngine().engine, '<link rel="stylesheet" href="css/site.css"><p>x</p>', "uA");
    expect(scene).toContain(`Brand/:${brand.byteLength}`);
  });

  it("gives a face back once no source uses it, and on deactivation", async () => {
    const { host, scene } = fakeHost({ "resources/fonts/brand.ttf": brand });
    const doc = "<style>@font-face{font-family:Brand;src:url(fonts/brand.ttf)}</style><p>x</p>";
    await prepareEngineInputs(host, fakeEngine().engine, doc, "uA");
    await prepareEngineInputs(host, fakeEngine().engine, "<p>plain</p>", "uB");
    await retainSceneFaces(host, ["uA", "uB"]);
    expect(scene).toContain(`Brand/:${brand.byteLength}`);
    // uA now renders without the rule: nobody uses the face.
    await prepareEngineInputs(host, fakeEngine().engine, "<p>plain</p>", "uA");
    await retainSceneFaces(host, ["uA", "uB"]);
    expect(scene).toEqual(["Inter/:7"]);
    // Used again, then the frame is gone.
    await prepareEngineInputs(host, fakeEngine().engine, doc, "uA");
    expect(scene).toContain(`Brand/:${brand.byteLength}`);
    await retainSceneFaces(host, ["uB"]);
    expect(scene).toEqual(["Inter/:7"]);
    await prepareEngineInputs(host, fakeEngine().engine, doc, "uA");
    await releaseSceneFaces(host);
    expect(scene).toEqual([]);
  });

  it("a face over the asset budget is not handed over and says so", async () => {
    const big = new Uint8Array(ASSET_BUDGETS.maxFontFaceBytes + 1);
    big.set(brand.subarray(0, 64));
    const { host, scene } = fakeHost({ "resources/fonts/big.ttf": big });
    const doc = "<style>@font-face{font-family:Huge;src:url(fonts/big.ttf)}</style><p>x</p>";
    const diagnostics = await prepareEngineInputs(host, fakeEngine().engine, doc, "uA");
    expect(scene).toEqual(["Inter/:7"]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringMatching(/font face “Huge” .* over the canvas's .* limit/),
    ]);
    // Said on every render that uses it, read once.
    expect(await prepareEngineInputs(host, fakeEngine().engine, doc, "uA")).toHaveLength(1);
  });

  it("a WOFF face the canvas cannot take says so; a TrueType source beside it is preferred", async () => {
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const { host, scene } = fakeHost({ "resources/f/a.woff2": woff2, "resources/f/a.ttf": brand });
    const only = "<style>@font-face{font-family:W;src:url(f/a.woff2) format('woff2')}</style><p>x</p>";
    const d = await prepareEngineInputs(host, fakeEngine().engine, only, "uA");
    expect(d.map((x) => x.message)).toEqual([expect.stringMatching(/font face “W” is a WOFF2 file/)]);
    const both = "<style>@font-face{font-family:T;src:url(f/a.woff2) format('woff2'),url(f/a.ttf)}</style><p>x</p>";
    expect(await prepareEngineInputs(host, fakeEngine().engine, both, "uA")).toEqual([]);
    expect(scene).toContain(`T/:${brand.byteLength}`);
  });
});
