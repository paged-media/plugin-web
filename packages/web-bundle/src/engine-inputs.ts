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

// What the engine needs besides the HTML: the FACES the source names and the
// SUB-RESOURCES it points at. The engine never touches the network
// (web-render `resources.rs`); this module hands it bytes from the document:
//
//   · faces — every family the source's CSS names that the host's asset
//     store serves (`host.assets.getFontFace`, document fonts), in the styles
//     the source uses (regular, bold, italic), registered ONCE per engine so
//     runs shape in their real face;
//   · resources — every relative URL the source writes (`<img src>`,
//     `<link rel=stylesheet href>`, CSS `url()` and `@import`, recursively
//     through loaded stylesheets) read from the container
//     (`resources/<path>`, source-part.ts), and `paged-image:<element id>`
//     from the asset store's placed images. `data:` URIs the engine decodes
//     itself. Each is registered once per engine.
//
// The canvas draws the engine's text items itself, resolving each family
// through the host. So every face the engine shapes with — the bundled face
// (the engine's fallback for every family nobody registered) and the
// document faces above — is also handed to the host's scene-layer face table
// (`host.assets.registerFont`, `assets.registerFont@1`), once per host. Those
// faces reach scene-layer text only, never the document's layout, its Fonts
// panel or preflight. They are given back on deactivation
// (`releaseSceneFaces`).
//
// A source's own `@font-face` rules load their faces through the resource
// provider (container parts, `data:` URLs), so the engine lays text out in
// them; the same bytes go to the scene-layer face table under the family the
// CSS declares (and the face's own family, which is what the engine names on
// a run shaped with it), in the rule's weight and style — once per host,
// family, style and bytes. Each render records which frame used which face;
// a face no frame uses any more is given back (`retainSceneFaces`, after
// each auto-render pass). A face over the asset budget, or one only in a
// format the canvas cannot take (WOFF, WOFF2), is said as a problem.
//
// After a render the engine reports what did not load; `resourceDiagnostics`
// turns that into problems. `faceDiagnostics` turns the host's submit reply
// (`fontFallbacks`, protocol 68) into problems. With the bundled face in the
// host's table every fallback is a real problem; on a host that cannot take
// scene faces the bundled face's fallback is expected (it draws in the
// document default face, which is that same face in a new document) and is
// not reported.

import type { BundleHost, Disposable, SceneLayerSubmitResult } from "@paged-media/plugin-api";
import { ASSET_BUDGETS } from "@paged-media/plugin-sdk";
import { familiesUsed, type WebDiagnostic } from "../../web-model/src";

import { bytesHash, dataUrlBytes, fontFaceRules, fontFormat, sfntFamily, type CssFace } from "./css-faces";
import type { WebEngine } from "./engine-loader";
import { readResourcePart } from "./source-part";

type InputsHost = Pick<BundleHost, "supports" | "assets" | "parts" | "log">;

/** The family the engine's bundled face registers under. */
export const BUNDLED_FAMILY = "Inter";

/** The most resources one source may pull in (a stylesheet chain cannot
 *  loop the reader forever). */
const MAX_RESOURCES = 64;

const facesAsked = new WeakMap<WebEngine, Set<string>>();

/** Styles to ask the asset store for, beyond the family's default face. */
function stylesUsed(doc: string): (string | undefined)[] {
  const bold = /<(b|strong|h[1-6]|th)[\s>]|font-weight\s*:\s*(bold|bolder|[6-9]00)\b/i.test(doc);
  const italic = /<(i|em|cite|var|dfn|address)[\s>]|font-style\s*:\s*(italic|oblique)\b/i.test(doc);
  const out: (string | undefined)[] = [undefined];
  if (bold) out.push("Bold");
  if (italic) out.push("Italic");
  if (bold && italic) out.push("Bold Italic");
  return out;
}

// ------------------------------------------------------ scene-layer faces

/** The faces this bundle handed a host's scene-layer face table, per host:
 *  `family\0style` → the registration (resolves `null` when refused). */
const sceneFaces = new WeakMap<object, Map<string, Promise<Disposable | null>>>();

function sceneFaceTable(host: object): Map<string, Promise<Disposable | null>> {
  let table = sceneFaces.get(host);
  if (!table) {
    table = new Map();
    sceneFaces.set(host, table);
  }
  return table;
}

/** Whether the host takes scene-layer faces (probed once per host). */
const sceneFaceDoor = new WeakMap<object, boolean>();

function takesSceneFaces(host: InputsHost): boolean {
  let door = sceneFaceDoor.get(host);
  if (door === undefined) {
    door = host.supports("assets.registerFont@1");
    sceneFaceDoor.set(host, door);
  }
  return door;
}

/** Hand one face to the host's scene-layer face table (once per host per
 *  family and style). A host without the door, or one that refuses the face,
 *  leaves scene text in its fallback face. */
async function shareSceneFace(
  host: InputsHost,
  bytes: Uint8Array,
  family: string,
  style?: string,
): Promise<void> {
  if (!takesSceneFaces(host)) return;
  const table = sceneFaceTable(host);
  const key = faceKey(family, style);
  if (table.has(key)) {
    await table.get(key);
    return;
  }
  const pending = host.assets.registerFont(bytes, family, style).catch((err: unknown) => {
    host.log.warn(`web engine: the canvas cannot take the face ${family} ${style ?? ""}: ${String(err)}`);
    return null;
  });
  table.set(key, pending);
  await pending;
}

const faceKey = (family: string, style?: string) => `${family.toLowerCase()}\u0000${style ?? ""}`;

/** Whether the host's scene-layer face table holds the bundled face. */
async function bundledFaceShared(host: object): Promise<boolean> {
  const pending = sceneFaces.get(host)?.get(faceKey(BUNDLED_FAMILY));
  return pending !== undefined && (await pending) !== null;
}

const bundledShared = new WeakMap<object, boolean>();

/** Hand the engine's bundled face to the host (once per host). */
async function shareBundledFace(host: InputsHost, engine: WebEngine): Promise<void> {
  if (!engine.bundledFont || !takesSceneFaces(host)) return;
  if (!sceneFaceTable(host).has(faceKey(BUNDLED_FAMILY))) {
    const bytes = engine.bundledFont();
    if (!bytes || bytes.byteLength === 0) return;
    await shareSceneFace(host, bytes, BUNDLED_FAMILY);
  }
  bundledShared.set(host, await bundledFaceShared(host));
}

/** Give back every face this bundle handed the host (deactivation).
 *  Resolves once each registration has settled and been disposed. */
export async function releaseSceneFaces(host: object): Promise<void> {
  const table = sceneFaces.get(host);
  const css = cssFaces.get(host);
  sceneFaces.delete(host);
  cssFaces.delete(host);
  bundledShared.delete(host);
  const pending = [...(table?.values() ?? []), ...(css?.shared.values() ?? [])];
  await Promise.all(pending.map((p) => p.then((d) => d?.dispose())));
}

// ------------------------------------------------- @font-face scene faces

/** A rule's face as read from the document: its bytes, or why the canvas
 *  cannot take it. */
interface ResolvedFace {
  bytes: Uint8Array | null;
  diagnostic: WebDiagnostic | null;
}

/** Per host: the faces `@font-face` rules handed over (`family\0style\0hash`
 *  → registration), what each rule resolved to, and which faces each
 *  rendering frame used. */
interface CssFaceState {
  shared: Map<string, Promise<Disposable | null>>;
  resolved: Map<string, ResolvedFace>;
  users: Map<string, Set<string>>;
}

const cssFaces = new WeakMap<object, CssFaceState>();

function cssFaceState(host: object): CssFaceState {
  let state = cssFaces.get(host);
  if (!state) {
    state = { shared: new Map(), resolved: new Map(), users: new Map() };
    cssFaces.set(host, state);
  }
  return state;
}

const MB = 1024 * 1024;

const faceProblem = (message: string): WebDiagnostic => ({ severity: "warning", message, source: "render" });

/** The bytes of a rule's face: its first TrueType/OpenType source the
 *  document holds (a container part or a `data:` URL). `null` bytes with a
 *  diagnostic when the face cannot reach the canvas; `null` when nothing
 *  is held yet (not remembered, so a part stored later is read). */
async function resolveFace(host: InputsHost, rule: CssFace): Promise<ResolvedFace | null> {
  let other: string | null = null;
  for (const src of rule.srcs) {
    let bytes: Uint8Array | null = null;
    if (/^data:/i.test(src)) bytes = dataUrlBytes(src);
    else {
      const path = relativePath(src, rule.base);
      if (path !== null) bytes = await readResourcePart(host, path);
    }
    if (!bytes || bytes.byteLength === 0) continue;
    const format = fontFormat(bytes);
    if (format === "sfnt") {
      if (bytes.byteLength > ASSET_BUDGETS.maxFontFaceBytes) {
        return {
          bytes: null,
          diagnostic: faceProblem(
            `font face “${rule.family}” (${(bytes.byteLength / MB).toFixed(1)} MB) is over the canvas's ` +
              `${(ASSET_BUDGETS.maxFontFaceBytes / MB).toFixed(0)} MB limit for one face — ` +
              "the canvas draws its text in the default font",
          ),
        };
      }
      return { bytes, diagnostic: null };
    }
    other ??= format;
  }
  if (other === "woff" || other === "woff2") {
    return {
      bytes: null,
      diagnostic: faceProblem(
        `font face “${rule.family}” is a ${other.toUpperCase()} file — the canvas takes TrueType or ` +
          "OpenType faces only; store a .ttf or .otf source beside it",
      ),
    };
  }
  return null;
}

/** Hand the faces of `rules` to the host's scene-layer face table (once per
 *  host, family, style and bytes), recording them as used by `user` (a
 *  rendering frame). Answers the problems: faces that cannot reach the
 *  canvas. */
async function shareCssFaces(host: InputsHost, rules: CssFace[], user: string | undefined): Promise<WebDiagnostic[]> {
  if (rules.length === 0) {
    // Nothing to hand over: the frame now uses no face (no door is asked).
    if (user !== undefined) cssFaces.get(host)?.users.set(user, new Set());
    return [];
  }
  if (!takesSceneFaces(host)) return [];
  const state = cssFaceState(host);
  const diagnostics: WebDiagnostic[] = [];
  const faces: { key: string; family: string; style?: string; bytes: Uint8Array }[] = [];
  for (const rule of rules) {
    const ruleKey = [rule.family, rule.style ?? "", rule.base, ...rule.srcs].join("\u0000");
    let resolved = state.resolved.get(ruleKey) ?? null;
    if (!resolved) {
      resolved = await resolveFace(host, rule);
      if (resolved) state.resolved.set(ruleKey, resolved);
    }
    if (!resolved) continue;
    if (resolved.diagnostic) diagnostics.push(resolved.diagnostic);
    const bytes = resolved.bytes;
    if (!bytes) continue;
    const hash = bytesHash(bytes);
    // The family the CSS declares, and the face's own family — the engine
    // names a run shaped with an `@font-face` face by the face's own name.
    const own = sfntFamily(bytes);
    const families = [rule.family];
    if (own && own.toLowerCase() !== rule.family.toLowerCase()) families.push(own);
    for (const family of families) {
      faces.push({ key: `${faceKey(family, rule.style)}\u0000${hash}`, family, style: rule.style, bytes });
    }
  }
  if (user !== undefined) state.users.set(user, new Set(faces.map((f) => f.key)));
  for (const face of faces) {
    let pending = state.shared.get(face.key);
    if (!pending) {
      pending = host.assets.registerFont(face.bytes, face.family, face.style).catch((err: unknown) => {
        host.log.warn(`web engine: the canvas cannot take the face ${face.family} ${face.style ?? ""}: ${String(err)}`);
        return null;
      });
      state.shared.set(face.key, pending);
    }
    await pending;
  }
  return diagnostics;
}

/** Keep the `@font-face` faces the frames in `live` used at their last
 *  render and give back every other one (the auto renderer calls this after
 *  each pass with the web frames it found). */
export async function retainSceneFaces(host: object, live: Iterable<string>): Promise<void> {
  const state = cssFaces.get(host);
  if (!state) return;
  const keep = new Set(live);
  for (const user of [...state.users.keys()]) if (!keep.has(user)) state.users.delete(user);
  const used = new Set<string>();
  for (const keys of state.users.values()) for (const k of keys) used.add(k);
  const gone: Promise<Disposable | null>[] = [];
  for (const [key, pending] of [...state.shared]) {
    if (used.has(key)) continue;
    state.shared.delete(key);
    gone.push(pending);
  }
  await Promise.all(gone.map((p) => p.then((d) => d?.dispose())));
}

/** Register the faces the engine shapes with: the document faces the source
 *  names (with the engine once per engine, with the host's scene-layer face
 *  table once per host) and the bundled face (with the host). Needs
 *  `assets.fonts@1` and an engine that takes faces for the document faces. */
export async function registerSourceFaces(
  host: InputsHost,
  engine: WebEngine,
  doc: string,
): Promise<void> {
  await shareBundledFace(host, engine);
  if (!engine.registerFont || !host.supports("assets.fonts@1")) return;
  const families = familiesUsed(doc);
  if (families.length === 0) return;
  let asked = facesAsked.get(engine);
  if (!asked) {
    asked = new Set();
    facesAsked.set(engine, asked);
  }
  const styles = stylesUsed(doc);
  for (const family of families) {
    for (const style of styles) {
      const key = `${family.toLowerCase()}\u0000${style ?? ""}`;
      if (asked.has(key)) continue;
      asked.add(key);
      try {
        const face = await host.assets.getFontFace(family, style);
        if (face && face.bytes.byteLength > 0) {
          engine.registerFont(face.bytes, family);
          await shareSceneFace(host, face.bytes, family, style);
        }
      } catch (err) {
        host.log.debug(`web engine: no face for ${family} ${style ?? ""}: ${String(err)}`);
      }
    }
  }
}

// --------------------------------------------------------------- resources

const SRC_ATTR = /<(?:img|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

const pick = (m: RegExpExecArray): string => (m[1] ?? m[2] ?? m[3] ?? "").trim();

/** The URLs a document (HTML with inline CSS) or a stylesheet writes, in
 *  order, deduplicated. A scanner, not a parser: it never throws. */
export function resourceUrls(text: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    if (u.length > 0 && !out.includes(u)) out.push(u);
  };
  let m: RegExpExecArray | null;
  SRC_ATTR.lastIndex = 0;
  while ((m = SRC_ATTR.exec(text)) !== null) push(pick(m));
  LINK_TAG.lastIndex = 0;
  while ((m = LINK_TAG.exec(text)) !== null) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(m[0])) continue;
    const href = HREF_ATTR.exec(m[0]);
    if (href) push(pick(href as RegExpExecArray));
  }
  CSS_URL.lastIndex = 0;
  while ((m = CSS_URL.exec(text)) !== null) push(pick(m));
  CSS_IMPORT.lastIndex = 0;
  while ((m = CSS_IMPORT.exec(text)) !== null) push(pick(m));
  return out;
}

/** A source-relative URL's path (`./img/a.png?x` → `img/a.png`), resolved
 *  against `base` (the directory of the stylesheet that wrote it); `null`
 *  for a URL with a scheme, a protocol-relative or fragment-only URL. */
export function relativePath(url: string, base = ""): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("#")) return null;
  const clean = url.split(/[?#]/)[0];
  const parts = (clean.startsWith("/") ? clean : base + clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.length > 0 ? out.join("/") : null;
}

const ASSET_IMAGE = /^paged-image:(.+)$/;

/** Hand the engine the bytes of every resource the document points at that
 *  the document holds (container parts, asset-store images), once per
 *  engine. Stylesheets loaded this way are scanned for their own URLs.
 *  Answers the `@font-face` rules those stylesheets declare. */
export async function registerSourceResources(
  host: InputsHost,
  engine: WebEngine,
  doc: string,
): Promise<CssFace[]> {
  const faces: CssFace[] = [];
  if (!engine.registerResource) return faces;
  const queue: { url: string; base: string }[] = resourceUrls(doc).map((url) => ({ url, base: "" }));
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < MAX_RESOURCES) {
    const { url, base } = queue.shift()!;
    const asset = ASSET_IMAGE.exec(url);
    const key = asset ? url.split(/[?#]/)[0] : relativePath(url, base);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    const known = engine.hasResource?.(key) ?? false;
    let bytes: Uint8Array | null = null;
    if (!known) {
      if (asset) {
        if (!host.supports("assets.images@1")) continue;
        try {
          bytes = (await host.assets.getPlacedImage(asset[1]))?.bytes ?? null;
        } catch {
          bytes = null;
        }
      } else {
        bytes = await readResourcePart(host, key);
      }
      if (!bytes) continue; // the engine reports it as not loaded
      engine.registerResource(key, bytes);
    }
    // A stylesheet's own URLs resolve against its directory (scanned once,
    // when its bytes are read; remembered per engine after that).
    if (!asset && /\.css$/i.test(key)) {
      let nested = sheetUrls(engine).get(key);
      if (!nested && bytes) {
        nested = resourceUrls(new TextDecoder().decode(bytes));
        sheetUrls(engine).set(key, nested);
      }
      const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
      for (const u of nested ?? []) queue.push({ url: u, base: dir });
      let rules = sheetFaces(engine).get(key);
      if (!rules && bytes) {
        rules = fontFaceRules(new TextDecoder().decode(bytes), dir);
        sheetFaces(engine).set(key, rules);
      }
      faces.push(...(rules ?? []));
    }
  }
  return faces;
}

const sheetFaceCache = new WeakMap<WebEngine, Map<string, CssFace[]>>();

function sheetFaces(engine: WebEngine): Map<string, CssFace[]> {
  let m = sheetFaceCache.get(engine);
  if (!m) {
    m = new Map();
    sheetFaceCache.set(engine, m);
  }
  return m;
}

const sheetUrlCache = new WeakMap<WebEngine, Map<string, string[]>>();

function sheetUrls(engine: WebEngine): Map<string, string[]> {
  let m = sheetUrlCache.get(engine);
  if (!m) {
    m = new Map();
    sheetUrlCache.set(engine, m);
  }
  return m;
}

/** Faces and resources for one render of `doc` (the composed document) by
 *  `user` (the frame id whose source renders; it keeps the source's
 *  `@font-face` faces on the canvas until `retainSceneFaces` no longer
 *  names it). Answers the problems of faces that cannot reach the canvas. */
export async function prepareEngineInputs(
  host: InputsHost,
  engine: WebEngine,
  doc: string,
  user?: string,
): Promise<WebDiagnostic[]> {
  await registerSourceFaces(host, engine, doc);
  const sheetRules = await registerSourceResources(host, engine, doc);
  return shareCssFaces(host, [...fontFaceRules(doc), ...sheetRules], user);
}

/** The engine's report of what the last render could not load, as problems. */
export function resourceDiagnostics(engine: WebEngine): WebDiagnostic[] {
  const misses = engine.takeResourceMisses?.() ?? [];
  return misses.map((url) => ({
    severity: "warning" as const,
    message: /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
      ? `“${url}” is not loaded: a web frame loads nothing from the network — store it with the document`
      : `resource “${url}” is not in the document — it is not shown`,
    source: "render" as const,
  }));
}

/** Whether a reported fallback names the bundled face. */
function isBundledFace(face: string): boolean {
  return face === BUNDLED_FAMILY || face.startsWith(`${BUNDLED_FAMILY} `);
}

/** The faces the host drew in its default font (the protocol-68 submit
 *  reply), as problems. Read defensively: an older host answers nothing.
 *  The bundled face's fallback is a problem only once `host` holds it in its
 *  scene-layer face table (a host without the door draws it in the default
 *  face, which is the same face in a new document). */
export function faceDiagnostics(
  reply: Partial<SceneLayerSubmitResult> | void | null | undefined,
  host: object,
): WebDiagnostic[] {
  const raw: unknown = reply?.fontFallbacks;
  const fallbacks = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
  const bundledExpected = bundledShared.get(host) !== true;
  return fallbacks
    .filter((f) => !(bundledExpected && isBundledFace(f)))
    .map((face) => ({
      severity: "warning" as const,
      message: `font “${face}” is not in the document — the canvas draws it in the default font`,
      source: "render" as const,
    }));
}
