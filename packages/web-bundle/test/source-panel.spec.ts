// Phase 2c — the source panel's three separable units, tested without
// rendering (the panel's pure seams, like `previewFontBadge` before
// them):
//   1. the W-04 editor LANE branch — host widget when
//      `supports("widgets.codeEditor@1")`, the bundle's own plain
//      textarea otherwise (the headless/conformance path);
//   2. the keystroke→preview DEBOUNCE (trailing edge, fake timers);
//   3. `persistDraft` — the explicit save is the panel's only document
//      write: one metadata mutation per call, never a preview side
//      effect.

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BundleHost,
  CodeEditorProps,
  ElementId,
  PagedEditor,
  WidgetSurface,
} from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import {
  DEFAULT_SOURCE,
  envelopeFor,
  type WebFrameSource,
} from "@paged-media/web-model";

import { webBundle } from "../src";
import { createDebouncer } from "../src/panels/debounce";
import {
  FallbackCodeEditor,
  resolveEditorLane,
} from "../src/panels/editor-lane";
import {
  persistDraft,
  PREVIEW_DEBOUNCE_MS,
} from "../src/panels/web-source-panel";
import { readSourcePart } from "../src/source-part";

const manifest = webBundle.manifest;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};
const fakeEditor = {} as unknown as PagedEditor;

// A recognizable host widget — identity is the assertion.
const HostWidget = ((_props: CodeEditorProps) =>
  null) as WidgetSurface["CodeEditor"];

describe("editor lane (W-04 widget vs textarea fallback)", () => {
  it("uses the host widget when supports('widgets.codeEditor@1') answers true", () => {
    const lane = resolveEditorLane({
      supports: (f) => f === "widgets.codeEditor@1",
      widgets: { CodeEditor: HostWidget },
    });
    expect(lane.native).toBe(true);
    expect(lane.CodeEditor).toBe(HostWidget);
  });

  it("falls back to the bundle's plain textarea when the probe answers false", () => {
    const lane = resolveEditorLane({
      supports: () => false,
      // Even a present catalog member is ignored when the FEATURE is
      // not advertised — the probe, not the property, is the contract.
      widgets: { CodeEditor: HostWidget },
    });
    expect(lane.native).toBe(false);
    expect(lane.CodeEditor).toBe(FallbackCodeEditor);
  });

  it("matches the real host adapter's feature flag (headless = textarea, injected = widget)", () => {
    // Headless/conformance: no widget catalog injected.
    const headless = createBundleHost(() => fakeEditor, manifest, {
      console: silent,
      storage: mapBacking(),
    });
    expect(headless.host.supports("widgets.codeEditor@1")).toBe(false);
    expect(resolveEditorLane(headless.host)).toEqual({
      native: false,
      CodeEditor: FallbackCodeEditor,
    });
    // A host app that injects the catalog flips the lane.
    const withWidgets = createBundleHost(() => fakeEditor, manifest, {
      console: silent,
      storage: mapBacking(),
      widgets: { CodeEditor: HostWidget },
    });
    expect(withWidgets.host.supports("widgets.codeEditor@1")).toBe(true);
    expect(resolveEditorLane(withWidgets.host)).toEqual({
      native: true,
      CodeEditor: HostWidget,
    });
  });
});

describe("keystroke→preview debounce (trailing edge)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once, PREVIEW_DEBOUNCE_MS after the last schedule", () => {
    vi.useFakeTimers();
    const d = createDebouncer(PREVIEW_DEBOUNCE_MS);
    const fn = vi.fn();
    d.schedule(fn);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(false);
  });

  it("a typing burst collapses to ONE trailing refresh (the latest)", () => {
    vi.useFakeTimers();
    const d = createDebouncer(PREVIEW_DEBOUNCE_MS);
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    d.schedule(first);
    vi.advanceTimersByTime(150);
    d.schedule(second); // replaces `first`, restarts the window
    vi.advanceTimersByTime(150);
    d.schedule(third); // replaces `second`, restarts again
    // 300 ms after the FIRST keystroke nothing has fired yet…
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    // …only the LAST scheduled refresh fires, a full window later.
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending refresh (unmount path)", () => {
    vi.useFakeTimers();
    const d = createDebouncer(PREVIEW_DEBOUNCE_MS);
    const fn = vi.fn();
    d.schedule(fn);
    expect(d.pending()).toBe(true);
    d.cancel();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(false);
  });
});

describe("persistDraft (the explicit save — the panel's only document write)", () => {
  const id: ElementId = { kind: "rectangle", id: "uWEB1" } as ElementId;
  const draft: WebFrameSource = {
    ...DEFAULT_SOURCE,
    css: "h1 { color: rebeccapurple; }",
    options: { media: "screen", overflow: "clip", viewportWidth: 480 },
    // §6.2 slice — the panel-edited template vars ride the SAME
    // envelope (additive within v1).
    vars: { title: "Hello", price: "1234.5" },
  };

  it("writes exactly one envelope through host.document.setMetadata", async () => {
    const writes: Array<{ id: unknown; envelope: unknown }> = [];
    const host = {
      document: {
        setMetadata: async (elementId: unknown, envelope: unknown) => {
          writes.push({ id: elementId, envelope });
          return { applied: true };
        },
      },
      parts: { write: async () => {}, read: async () => null, list: async () => [] },
      supports: () => false, // no container writer → the part write no-ops
    } as unknown as Pick<BundleHost, "document" | "parts" | "supports">;
    await expect(persistDraft(host, id, draft)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe(id);
    // The envelope path is web-model's single (de)serialization point —
    // the frame OPTIONS (media/viewport/overflow) round-trip through it.
    expect(writes[0].envelope).toEqual(envelopeFor(draft));
  });

  it("reports an engine rejection as false (caller keeps the dirty state)", async () => {
    const host = {
      document: {
        setMetadata: async () => ({ applied: false }),
      },
      parts: { write: async () => {}, read: async () => null, list: async () => [] },
      supports: () => false,
    } as unknown as Pick<BundleHost, "document" | "parts" | "supports">;
    await expect(persistDraft(host, id, draft)).resolves.toBe(false);
  });

  it("write-throughs the source to a portable .paged container part", async () => {
    // Against a host WITH a container writer, persistDraft also writes the
    // source as a paged/ part — the uncapped, portable source-of-truth — and
    // readSourcePart reads it back (the migration round-trip).
    const store = new Map<string, Uint8Array>();
    const host = {
      document: {
        setMetadata: async () => ({ applied: true }),
        getMetadata: async () => null,
      },
      parts: {
        write: async (p: string, b: Uint8Array) => void store.set(p, b),
        read: async (p: string) => store.get(p) ?? null,
        list: async () => [...store.keys()],
      },
      supports: (f: string) => f === "storage.parts@1",
    } as unknown as BundleHost;

    await expect(persistDraft(host, id, draft)).resolves.toBe(true);
    // The part landed under the frame-id-keyed relative path (the host
    // prepends the plugin namespace; this layer speaks relative paths).
    expect([...store.keys()]).toEqual([`${(id as { id: string }).id}/source.json`]);
    // And it round-trips back to the exact source.
    expect(await readSourcePart(host, id)).toEqual(draft);
  });
});
