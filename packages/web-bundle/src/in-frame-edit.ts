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

// IN-FRAME TEXT EDITING — the modal session behind the `webFrame` edit
// context (the K-1 shape paged.sheet's grid uses).
//
// Inside the context (double-click the frame), a click on rendered text
// opens an edit of the DOM text node under it:
//
//   click ──▶ engine.renderInspected (layer + text map)        engine-loader.ts
//         ──▶ hitText → (node ordinal, offset)                 web-model inspect.ts
//         ──▶ scanTextNodes(source.html)[ordinal], its text checked against
//             the engine's (a mismatch refuses: the text is template output,
//             or the markup moves it)                          web-model source-text.ts
//   keys  ──▶ the node's text + caret (typing, Backspace/Delete, arrows,
//             Home/End); every change re-renders the frame after a short
//             debounce with editTextNode(source) and moves the caret overlay
//   Enter ──▶ commit: writeWebSource — one undoable document step; the
//             panel's draft history records it too (draft-store.ts)
//   Esc   ──▶ cancel: the frame shows the source as it was
//
// While an edit is open the context is DIRTY, so the host routes every key
// here (Enter and Esc included) and Cmd+Z steps the edit's own keystrokes;
// with no edit open, Cmd+Z steps the panel's draft history (ADR 012).
//
// Only an unthreaded frame under a clip, grow or thread policy is edited in
// place: a threaded frame's text is cut across frames and a shrunk frame is
// scaled, so a point on the canvas does not name one place in the layout
// the inspected render reads.

import type { BundleHost, ElementId, ElementGeometryItem } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  caretAt,
  editTextNode,
  hitText,
  outlineIndexAt,
  scanTextNodes,
  tagOutline,
  sourceKeyFor,
  type InspectedRender,
  type SourceTextNode,
  type WebFrameSource,
} from "../../web-model/src";

import { persistentSceneSurface } from "./bake";
import { resolveBindings } from "./bindings";
import { engineDocument } from "./engine-document";
import { loadWebEngine, type WebEngine } from "./engine-loader";
import type { DraftSession } from "./panels/draft-store";
import { contentToPage, reportCanvasPick } from "./outline-highlight";
import { loadWebSource, writeWebSource } from "./source-part";

/** CSS px per point (the frame size the engine lays out at). */
const PX_PER_PT = 96 / 72;

/** Debounce between a keystroke and the frame's re-render, ms. */
export const IN_FRAME_RENDER_MS = 80;

/** Diagnostics key suffix of the session's notes. */
const DIAG_SUFFIX = "#in-frame";

interface Step {
  text: string;
  caret: number;
}

interface OpenEdit {
  node: SourceTextNode;
  ordinal: number;
  text: string;
  caret: number;
  history: Step[];
  at: number;
}

interface Frame {
  id: ElementId;
  key: string;
  source: WebFrameSource;
  geometry: ElementGeometryItem | null;
  /** The render of the persisted source (what cancel restores). */
  base: InspectedRender;
  /** The latest render (the edited text, once a re-render landed). */
  current: InspectedRender;
  widthPx: number;
  heightPx: number;
  bound: Record<string, string>;
}

export interface InFrameEditSession {
  /** The context was entered on `id`. */
  enter(id: ElementId): void;
  /** The context exits: an open edit is dropped (commit/cancel ran first). */
  exit(): void;
  /** A press at a frame-content point: places the caret, opening an edit of
   *  the text node there (committing an edit of another node first). */
  pointerDown(x: number, y: number): Promise<void>;
  /** A key while the context is active; `true` when it was handled. */
  key(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean;
  isEditing(): boolean;
  /** Write the open edit to the document (one undo step). */
  commit(): Promise<boolean>;
  /** Drop the open edit; the frame shows the persisted source again. */
  cancel(): Promise<void>;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** What the session holds — for tests and the panel. */
  state(): { frame: string | null; node: number | null; text: string | null; caret: number | null; html: string | null };
  /** Resolves when no re-render is pending. */
  idle(): Promise<void>;
}

export interface InFrameEditOptions {
  engine?: () => Promise<WebEngine | null>;
  debounceMs?: number;
}

const sessions = new WeakMap<BundleHost, InFrameEditSession>();

/** The in-frame edit session `activate` created for `host`, if any. */
export function inFrameSessionFor(host: BundleHost): InFrameEditSession | undefined {
  return sessions.get(host);
}

export function createInFrameEditSession(
  host: BundleHost,
  drafts?: DraftSession,
  opts: InFrameEditOptions = {},
): InFrameEditSession {
  const engineOf = opts.engine ?? (() => loadWebEngine(host));
  const debounceMs = opts.debounceMs ?? IN_FRAME_RENDER_MS;
  let entered: ElementId | null = null;
  let frame: Frame | null = null;
  let edit: OpenEdit | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rendering: Promise<void> | null = null;

  const note = (message: string | null) => {
    if (!entered) return;
    const t = asFrameTarget(entered);
    if (!t) return;
    host.diagnostics.set(
      sourceKeyFor(t) + DIAG_SUFFIX,
      message ? [{ severity: "info", message, source: "in-frame edit" }] : [],
    );
  };

  const overlay = (shapes: Parameters<BundleHost["overlay"]["setToolPreviews"]>[0]) => {
    try {
      host.overlay.setToolPreviews(shapes);
    } catch {
      // no overlay channel granted: the edit works without a drawn caret
    }
  };

  const drawCaret = () => {
    if (!frame || !edit || !frame.geometry?.pageId) {
      overlay(null);
      return;
    }
    const at = caretAt(frame.current.text, { node: edit.ordinal, offset: edit.caret });
    if (!at) {
      overlay(null);
      return;
    }
    const pageId = frame.geometry.pageId;
    overlay([
      { pageId, points: [contentToPage(frame.geometry, at.x, at.top), contentToPage(frame.geometry, at.x, at.bottom)] },
    ]);
  };

  const editedSource = (): WebFrameSource | null => {
    if (!frame || !edit) return null;
    return { ...frame.source, html: editTextNode(frame.source.html, edit.node, edit.text) };
  };

  const renderSource = async (source: WebFrameSource): Promise<InspectedRender | null> => {
    if (!frame) return null;
    const engine = await engineOf();
    if (!engine?.renderInspected) return null;
    const doc = engineDocument(source, frame.bound);
    return engine.renderInspected(doc.html, frame.widthPx, frame.heightPx);
  };

  const submit = async (layer: InspectedRender["layer"]) => {
    const t = frame ? asFrameTarget(frame.id) : null;
    const surface = persistentSceneSurface(host);
    if (t && surface) await surface.submit(t.id, layer as never);
  };

  const renderNow = () => {
    const run = (async () => {
      const source = editedSource();
      if (!source) return;
      const out = await renderSource(source);
      if (!out || !frame) return;
      frame.current = out;
      await submit(out.layer);
      drawCaret();
    })().catch((err: unknown) => host.log.warn(`in-frame edit: ${String(err)}`));
    const done: Promise<void> = (rendering ?? Promise.resolve()).then(() => run).then(() => {
      if (rendering === done) rendering = null;
    });
    rendering = done;
  };

  const rerender = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      renderNow();
    }, debounceMs);
  };

  /** Run a pending re-render now and wait for every render in flight. */
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      renderNow();
    }
    await session.idle();
  };

  /** Load the entered frame: source, geometry, the base inspected render. */
  const load = async (id: ElementId): Promise<Frame | null> => {
    const t = asFrameTarget(id);
    if (!t) return null;
    const source = await loadWebSource(host, id);
    if (!source) return null;
    if ((source.flow?.recipients.length ?? 0) > 0) {
      note("a threaded frame is edited in the Web frame panel: its text is cut across frames");
      return null;
    }
    if (source.options.overflow === "shrink") {
      note("a frame that shrinks its content to fit is edited in the Web frame panel");
      return null;
    }
    const [geometry] = await host.document.elementGeometry([id]);
    const b = geometry?.bounds;
    const widthPx = b ? Math.round(Math.max(0, b[3] - b[1]) * PX_PER_PT) : 0;
    const heightPx = b ? Math.round(Math.max(0, b[2] - b[0]) * PX_PER_PT) : 0;
    const bound = (await resolveBindings(host, id, source)).vars;
    const f: Frame = {
      id,
      key: sourceKeyFor(t),
      source,
      geometry: geometry ?? null,
      base: { layer: { items: [] }, text: { nodes: [], lines: [] }, boxes: [] },
      current: { layer: { items: [] }, text: { nodes: [], lines: [] }, boxes: [] },
      widthPx,
      heightPx,
      bound,
    };
    frame = f;
    const base = await renderSource(source);
    if (!base) {
      frame = null;
      note("in-frame editing needs the web engine, which is not loaded");
      return null;
    }
    f.base = base;
    f.current = base;
    return f;
  };

  const record = () => {
    if (!edit) return;
    edit.history.length = edit.at + 1;
    edit.history.push({ text: edit.text, caret: edit.caret });
    edit.at = edit.history.length - 1;
  };

  const stepTo = (at: number) => {
    if (!edit) return;
    edit.at = at;
    edit.text = edit.history[at].text;
    edit.caret = edit.history[at].caret;
    rerender();
    drawCaret();
  };

  const session: InFrameEditSession = {
    enter(id) {
      entered = id;
      frame = null;
      edit = null;
      note(null);
    },
    exit() {
      if (timer) clearTimeout(timer);
      timer = null;
      overlay(null);
      note(null);
      entered = null;
      frame = null;
      edit = null;
    },
    async pointerDown(x, y) {
      if (!entered) return;
      await session.idle();
      if (!frame) {
        if (!(await load(entered))) return;
      }
      const f = frame as Frame;
      // The panel's outline marks the element under the press.
      const fid = (f.id as { id?: unknown }).id;
      if (typeof fid === "string") {
        reportCanvasPick(host, fid, outlineIndexAt(f.current.boxes, tagOutline(f.source.html), x, y));
      }
      const hit = hitText(f.current.text, x, y);
      if (!hit) return;
      if (edit && hit.node === edit.ordinal) {
        edit.caret = Math.max(0, Math.min(edit.text.length, hit.offset));
        drawCaret();
        return;
      }
      if (edit) {
        await session.commit();
        if (!frame) return;
      }
      const g = frame as Frame;
      // The hit came from the render on screen; after a commit that is the
      // render of the committed source, which `g.source` now is.
      const nodes = scanTextNodes(g.source.html);
      const node = nodes[hit.node];
      const painted = g.current.text.nodes.find((n) => n.n === hit.node);
      if (!node || !painted || painted.text !== node.text) {
        note(
          "this text is not editable on the canvas (it comes from a template value, or the markup " +
            "places it elsewhere) — edit it in the Web frame panel",
        );
        return;
      }
      note(null);
      const caret = Math.max(0, Math.min(node.text.length, hit.offset));
      edit = { node, ordinal: hit.node, text: node.text, caret, history: [{ text: node.text, caret }], at: 0 };
      drawCaret();
    },
    key(e) {
      if (!edit) return false;
      const k = e.key;
      if (k === "Enter") {
        void session.commit();
        return true;
      }
      if (k === "Escape") {
        void session.cancel();
        return true;
      }
      if (e.metaKey || e.ctrlKey) return false;
      const t = edit.text;
      const c = edit.caret;
      const before = (i: number) => (i >= 2 && /[\udc00-\udfff]/.test(t[i - 1]) && /[\ud800-\udbff]/.test(t[i - 2]) ? 2 : 1);
      const after = (i: number) => (/[\ud800-\udbff]/.test(t[i] ?? "") && /[\udc00-\udfff]/.test(t[i + 1] ?? "") ? 2 : 1);
      switch (k) {
        case "ArrowLeft":
          edit.caret = Math.max(0, c - before(c));
          drawCaret();
          return true;
        case "ArrowRight":
          edit.caret = Math.min(t.length, c + after(c));
          drawCaret();
          return true;
        case "Home":
          edit.caret = 0;
          drawCaret();
          return true;
        case "End":
          edit.caret = t.length;
          drawCaret();
          return true;
        case "Backspace":
          if (c === 0) return true;
          edit.text = t.slice(0, c - before(c)) + t.slice(c);
          edit.caret = c - before(c);
          break;
        case "Delete":
          if (c >= t.length) return true;
          edit.text = t.slice(0, c) + t.slice(c + after(c));
          break;
        default:
          if ([...k].length !== 1) return false; // a named key we do not edit with
          edit.text = t.slice(0, c) + k + t.slice(c);
          edit.caret = c + k.length;
      }
      record();
      rerender();
      drawCaret();
      return true;
    },
    isEditing: () => edit !== null,
    async commit() {
      if (!edit || !frame) return false;
      await flush();
      if (!edit || !frame) return false;
      const next = editedSource();
      const prev = frame.source;
      edit = null;
      overlay(null);
      if (!next || next.html === prev.html) return false;
      const out = await writeWebSource(host, frame.id, next);
      if (!out.applied) {
        note(`the edit was not saved: ${out.reason ?? "the document refused it"}`);
        await submit(frame.base.layer);
        return false;
      }
      // The panel's draft history follows the document (draft-store.ts).
      drafts?.record(frame.key, prev);
      drafts?.record(frame.key, next);
      frame.source = next;
      frame.base = frame.current;
      return true;
    },
    async cancel() {
      if (!edit || !frame) return;
      if (timer) clearTimeout(timer);
      timer = null;
      await session.idle();
      edit = null;
      overlay(null);
      frame.current = frame.base;
      await submit(frame.base.layer);
    },
    undo() {
      if (!edit || edit.at === 0) return false;
      stepTo(edit.at - 1);
      return true;
    },
    redo() {
      if (!edit || edit.at >= edit.history.length - 1) return false;
      stepTo(edit.at + 1);
      return true;
    },
    canUndo: () => !!edit && edit.at > 0,
    canRedo: () => !!edit && edit.at < edit.history.length - 1,
    state: () => ({
      frame: frame ? ((frame.id as { id?: string }).id ?? null) : null,
      node: edit?.ordinal ?? null,
      text: edit?.text ?? null,
      caret: edit?.caret ?? null,
      html: editedSource()?.html ?? frame?.source.html ?? null,
    }),
    async idle() {
      for (;;) {
        if (timer) {
          await new Promise((r) => setTimeout(r, debounceMs + 5));
          continue;
        }
        if (rendering) {
          await rendering;
          continue;
        }
        return;
      }
    },
  };
  sessions.set(host, session);
  return session;
}
