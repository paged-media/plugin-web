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

// The InDesign lane, first half: run the REAL bake ("Bake web frame to
// document", bake-to-document.ts) against a recording host, and turn the
// wire mutations it issues into a core `paged script` (Boa, paged.* API).
// Core applies that script to a blank page and writes IDML; InDesign then
// opens the IDML and answers what it sees (run.sh + probe.jsx).
//
// Nothing here re-implements the bake: the ops come from the bundle's own
// materializePlan, so the IDML is what an editor bake would have produced
// (minus undo grouping), and a drift in the bake changes the committed
// script.

import { readFileSync } from "node:fs";

import { bakeWebFrameToDocument } from "../../web-bundle/src/bake-to-document";
import { parseSceneLayer, type WebEngine } from "../../web-bundle/src/engine-loader";
import { envelopeFor } from "../../web-model/src";

// The host contract types, taken from the bake's own signature (this package
// does not depend on the plugin API directly).
type BundleHost = Parameters<typeof bakeWebFrameToDocument>[0];
type ElementId = Parameters<typeof bakeWebFrameToDocument>[1];

/** One wire mutation as the bundle sends it to `host.document.mutate`. */
export interface WireOp {
  op: string;
  args: Record<string, unknown>;
}

/** Page origin of the web frame on the blank page, points. */
export const FRAME_ORIGIN = { top: 36, left: 36 };

// --- Inter advance widths: the measure an editor host answers with -----

interface Face {
  upm: number;
  ascender: number;
  descender: number;
  advance: (cp: number) => number;
}

/** A minimal sfnt reader (cmap 3/1 format 4, hhea, hmtx) — enough to measure
 *  a run the way `host.text.measureString` does, without kerning. */
export function readFace(bytes: Uint8Array): Face {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint16(4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    tables[String.fromCharCode(...bytes.subarray(o, o + 4))] = dv.getUint32(o + 8);
  }
  const upm = dv.getUint16(tables.head + 18);
  const hhea = tables.hhea;
  const ascender = dv.getInt16(hhea + 4);
  const descender = dv.getInt16(hhea + 6);
  const nMetrics = dv.getUint16(hhea + 34);
  const hmtx = tables.hmtx;
  const cmap = tables.cmap;
  let sub = -1;
  for (let i = 0; i < dv.getUint16(cmap + 2); i++) {
    const r = cmap + 4 + 8 * i;
    if (dv.getUint16(r) === 3 && dv.getUint16(r + 2) === 1) sub = cmap + dv.getUint32(r + 4);
  }
  if (sub < 0 || dv.getUint16(sub) !== 4) throw new Error("readFace: no cmap 3/1 format 4");
  const segX2 = dv.getUint16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const offsets = deltas + segX2;
  const glyph = (cp: number): number => {
    for (let s = 0; s < segX2; s += 2) {
      if (cp > dv.getUint16(ends + s)) continue;
      const start = dv.getUint16(starts + s);
      if (cp < start) return 0;
      const delta = dv.getInt16(deltas + s);
      const ro = dv.getUint16(offsets + s);
      if (ro === 0) return (cp + delta) & 0xffff;
      const g = dv.getUint16(offsets + s + ro + 2 * (cp - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const advance = (cp: number) => {
    const g = Math.min(glyph(cp), nMetrics - 1);
    return dv.getUint16(hmtx + 4 * g);
  };
  return { upm, ascender, descender, advance };
}

// --- the recording host -------------------------------------------------

const WEB_ID = { kind: "rectangle", id: "uWEB" } as unknown as ElementId;

/**
 * Bake `html` laid out in a `widthPt` x `heightPt` frame at FRAME_ORIGIN and
 * return the wire ops the bake issued. `render` is the engine's
 * render_web_frame (strings in, JSON out).
 */
export async function recordBake(
  html: string,
  css: string,
  widthPt: number,
  heightPt: number,
  render: (html: string, w: number, h: number) => string,
  face: Face,
): Promise<WireOp[]> {
  const ops: WireOp[] = [];
  const stories: { selfId: string }[] = [];
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const host = {
    log: silent,
    supports: () => false,
    selection: { get: () => [WEB_ID] },
    diagnostics: { set: () => {} },
    text: {
      measureString: async (_family: string, _style: string | null, text: string, sizePt: number) => {
        let units = 0;
        for (const ch of text) units += face.advance(ch.codePointAt(0)!);
        const k = sizePt / face.upm;
        return { advance: units * k, ascender: face.ascender * k, descender: face.descender * k };
      },
    },
    document: {
      getMetadata: async () =>
        envelopeFor({ html, css, options: { media: "print", overflow: "clip" } }),
      elementGeometry: async () => [
        {
          id: WEB_ID,
          pageId: "PAGE",
          bounds: [FRAME_ORIGIN.top, FRAME_ORIGIN.left, FRAME_ORIGIN.top + heightPt, FRAME_ORIGIN.left + widthPt],
        },
      ],
      collection: async (name: string) => (name === "stories" ? stories.slice() : []),
      mutate: async (m: WireOp) => {
        ops.push(JSON.parse(JSON.stringify(m)));
        if (m.op === "insertTextFrame") {
          stories.push({ selfId: `STORY${stories.length}` });
          return { applied: true, createdId: { kind: "textFrame", id: `tf${stories.length}` } };
        }
        return { applied: true, createdId: { kind: "rectangle", id: `r${ops.length}` } };
      },
    },
  } as unknown as BundleHost;
  const engine: WebEngine = {
    render: (h, w, ht) => parseSceneLayer(render(h, w, ht)),
    renderFlow: () => null,
  };
  const out = await bakeWebFrameToDocument(host, WEB_ID, engine);
  if (!out.baked) throw new Error(`bake failed: ${JSON.stringify(out.diagnostics)}`);
  return ops;
}

// --- wire ops -> paged script ------------------------------------------

const lit = (v: unknown) => JSON.stringify(v);

/** Translate recorded wire ops into a `paged script` (Boa) body. Throws on an
 *  op it does not know, so a new kind of bake output cannot slip past. */
export function toPagedScript(ops: WireOp[], header: string): string {
  const lines = [
    `// ${header}`,
    "// Generated by packages/web-conformance/indesign (test/indesign-bake.spec.ts).",
    "const pid = JSON.parse(paged.pages())[0].selfId;",
  ];
  const storyVar = new Map<string, string>();
  let n = 0;
  const set = (target: string, path: string, value: { type: string; value: unknown }) =>
    `paged.set(${target}, ${lit(path)}, ${lit(value.value)});`;
  const one = (o: WireOp, created: string | null): void => {
    const a = o.args as Record<string, any>;
    switch (o.op) {
      case "createSwatch":
        lines.push(`paged.createSwatch(${lit(a.spec)});`);
        return;
      case "insertFrame":
        lines.push(`const e${++n} = paged.insertFrame(pid, ${lit(a.bounds)});`);
        return;
      case "insertPath":
        lines.push(`const e${++n} = paged.insertPath(pid, ${lit(a.anchors)}, ${lit(Boolean(a.open))}, false);`);
        return;
      case "insertTextFrame": {
        lines.push(`const e${++n} = paged.insertTextFrame(pid, ${lit(a.bounds)});`);
        const v = `s${n}`;
        lines.push(`const ${v} = JSON.parse(paged.stories()).at(-1).selfId;`);
        storyVar.set(`STORY${storyVar.size}`, v);
        return;
      }
      case "insertText": {
        const v = storyVar.get(a.storyId);
        if (!v) throw new Error(`insertText into an unknown story ${a.storyId}`);
        lines.push(`paged.insertText(${v}, ${a.offset}, ${lit(a.text)});`);
        return;
      }
      case "setElementProperty": {
        const el = a.elementId as { kind: string; id: any };
        if (el.kind === "storyRange") {
          const v = storyVar.get(el.id.story_id);
          if (!v) throw new Error(`property on an unknown story ${el.id.story_id}`);
          lines.push(set(`\`storyRange:\${${v}}@${el.id.start}..${el.id.end}\``, a.path, a.value));
        } else if (el.id === "$created" && created) {
          lines.push(set(created, a.path, a.value));
        } else {
          throw new Error(`setElementProperty on ${JSON.stringify(el)}`);
        }
        return;
      }
      default:
        throw new Error(`toPagedScript: unknown wire op ${o.op}`);
    }
  };
  for (const o of ops) {
    if (o.op === "batch") {
      let created: string | null = null;
      for (const inner of (o.args as { ops: WireOp[] }).ops) {
        one(inner, created);
        if (inner.op.startsWith("insert")) created = `e${n}`;
      }
    } else {
      one(o, null);
    }
  }
  return lines.join("\n") + "\n";
}

// --- what InDesign should see ------------------------------------------

export interface ExpectedItem {
  kind: "rectangle" | "polygon" | "textFrame";
  /** [top, left, bottom, right], page points. */
  bounds: [number, number, number, number];
  fill?: string;
  text?: string;
  textFill?: string;
  pointSize?: number;
}

export interface Expected {
  items: ExpectedItem[];
  swatches: { name: string; rgb: [number, number, number] }[];
}

/** The page items and swatches the recorded ops should produce. */
export function expectedFrom(ops: WireOp[]): Expected {
  const items: ExpectedItem[] = [];
  const swatches: Expected["swatches"] = [];
  const flat = ops.flatMap((o) => (o.op === "batch" ? (o.args as { ops: WireOp[] }).ops : [o]));
  for (const o of flat) {
    const a = o.args as Record<string, any>;
    if (o.op === "createSwatch") swatches.push({ name: a.spec.name, rgb: a.spec.value });
    else if (o.op === "insertFrame") items.push({ kind: "rectangle", bounds: a.bounds });
    else if (o.op === "insertTextFrame") items.push({ kind: "textFrame", bounds: a.bounds });
    else if (o.op === "insertPath") {
      const xs = a.anchors.map((p: { anchor: number[] }) => p.anchor[0]);
      const ys = a.anchors.map((p: { anchor: number[] }) => p.anchor[1]);
      items.push({ kind: "polygon", bounds: [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)] });
    } else if (o.op === "insertText") items[items.length - 1].text = a.text;
    else if (o.op === "setElementProperty") {
      const last = items[items.length - 1];
      if (a.path === "frameFillColor") last.fill = a.value.value;
      if (a.path === "characterFillColor") last.textFill = a.value.value;
      if (a.path === "characterFontSize") last.pointSize = a.value.value;
    }
  }
  return { items, swatches };
}

/** Frame size from `<meta name="paged-frame" content="WxH">` (points). */
export function frameOf(html: string): { widthPt: number; heightPt: number } {
  const m = /<meta name="paged-frame" content="(\d+)x(\d+)">/.exec(html);
  if (!m) throw new Error("indesign fixture without <meta name=paged-frame>");
  return { widthPt: Number(m[1]), heightPt: Number(m[2]) };
}

export function loadInter(path: string): Face {
  return readFace(new Uint8Array(readFileSync(path)));
}
