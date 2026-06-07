// Registration + insert-flow wiring against the real in-process host
// adapter over a minimal fake editor (the plugin-draw pattern).
// Engine behavior is not faked; this proves the contract wiring and
// the honesty smoke test.

import { describe, expect, it, vi } from "vitest";

import type { PagedEditor } from "@paged-media/plugin-api";
import { loadBundle } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, envelopeFor } from "@paged-media/web-model";

import { webBundle } from "../src";

function fakeRegistry() {
  const byId = new Map<string, { id: string }>();
  return {
    ids: () => Array.from(byId.keys()),
    get: (id: string) => byId.get(id),
    register(c: { id: string }) {
      if (byId.has(c.id)) throw new Error(`duplicate id ${c.id}`);
      byId.set(c.id, c);
      return {
        dispose() {
          byId.delete(c.id);
        },
      };
    },
  };
}

// W3.2 — edit-context / object-type registries key off `type`.
function fakeTypeRegistry() {
  const byType = new Map<string, { type: string }>();
  return {
    types: () => Array.from(byType.keys()),
    get: (t: string) => byType.get(t),
    register(c: { type: string }) {
      byType.set(c.type, c);
      return {
        dispose() {
          byType.delete(c.type);
        },
      };
    },
  };
}

function makeFakeEditor() {
  const panels = fakeRegistry();
  const commands = fakeRegistry();
  const editContexts = fakeTypeRegistry();
  const objectTypes = fakeTypeRegistry();
  let selection: unknown[] = [];
  const created = { kind: "rectangle", id: "uWEB1" };
  const mutations: unknown[] = [];
  const editor = {
    registries: { panels, commands, editContexts, objectTypes },
    selection: {
      elementSelection: selection,
      setElementSelection: (ids: unknown[]) => {
        selection = ids;
        editor.selection.elementSelection = ids;
      },
      setElementGeometry: () => {},
    },
    camera: { camera: { scale: 1, tx: 0, ty: 0 } },
    client: {
      mutate: async (m: unknown) => {
        mutations.push(m);
        return {
          kind: "mutationApplied",
          payload: { createdId: created, pageIds: ["pg1"] },
        };
      },
      documentMeta: async () => ({ pageCount: 1, activePage: "pg1" }),
      collection: async () => [],
      setElementSelection: async (ids: unknown[]) => ids,
      elementGeometry: async () => [],
      subscribe: () => () => {},
    },
  };
  return {
    editor: editor as unknown as PagedEditor,
    panels,
    commands,
    editContexts,
    objectTypes,
    created,
    mutations,
  };
}

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

describe("webBundle.activate", () => {
  it("registers the source panel + the insert command (show/hide host-derived per B-15)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: { openPanel() {}, closePanel() {} },
    });
    expect(fake.panels.ids()).toEqual(["media.paged.web.panel.source"]);
    expect(fake.commands.ids()).toEqual([
      "media.paged.web.command.insertWebFrame",
    ]);
  });

  it("insert command: ONE sentinel batch (frame + metadata), selected, panel opened", async () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: { openPanel, closePanel() {} },
    });
    const cmd = fake.commands.get(
      "media.paged.web.command.insertWebFrame",
    ) as unknown as { handler: () => Promise<void> };
    await cmd.handler();
    // ONE batch through the one door: frame + source metadata via the
    // v34 batch-created sentinel — a single undo step.
    expect(fake.mutations).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "insertFrame",
              args: { pageId: "pg1", bounds: [60, 60, 240, 300] },
            },
            {
              op: "setPluginMetadata",
              args: {
                elementId: { kind: "rectangle", id: "$created" },
                key: "x-paged:media.paged.web",
                value: JSON.stringify(envelopeFor(DEFAULT_SOURCE)),
              },
            },
          ],
        },
      },
    ]);
    expect(fake.editor.selection.elementSelection).toEqual([fake.created]);
    expect(openPanel).toHaveBeenCalledWith("media.paged.web.panel.source");
  });

  it("registers the W3.2 webFrame object type + source edit context (W-03 RESOLVED)", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: { openPanel() {}, closePanel() {} },
    });
    // The object type routes a double-click to the source edit context.
    expect(fake.objectTypes.types()).toEqual(["webFrame"]);
    expect(fake.editContexts.types()).toEqual(["webFrame"]);
    const ot = fake.objectTypes.get("webFrame") as unknown as {
      matches: (c: unknown) => boolean;
      editContextType?: string;
      bakedFallback: string;
      metadataKey?: string;
    };
    expect(ot.editContextType).toBe("webFrame");
    expect(ot.bakedFallback).toBe("rectangle");
    expect(ot.metadataKey).toBe("x-paged:media.paged.web");
    // Metadata-claimed: a rectangle with a loadable source envelope IS a
    // webFrame; a bare rectangle (no metadata) is NOT.
    const withSource = {
      id: { kind: "rectangle", id: "uWEB1" },
      kind: "rectangle",
      groupChain: [],
      metadata: envelopeFor(DEFAULT_SOURCE),
    };
    const bare = { ...withSource, metadata: null };
    expect(ot.matches(withSource)).toBe(true);
    expect(ot.matches(bare)).toBe(false);
    // The edit context raises the source panel on enter.
    const ec = fake.editContexts.get("webFrame") as unknown as {
      panelIds: string[];
      onEnter?: (ctx: { type: string; id: unknown }) => void;
    };
    expect(ec.panelIds).toEqual(["media.paged.web.panel.source"]);
  });

  it("the webFrame edit context onEnter raises the source panel", () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: { openPanel, closePanel() {} },
    });
    const ec = fake.editContexts.get("webFrame") as unknown as {
      onEnter?: (ctx: { type: string; id: unknown }) => void;
    };
    ec.onEnter?.({ type: "webFrame", id: { kind: "rectangle", id: "uWEB1" } });
    expect(openPanel).toHaveBeenCalledWith("media.paged.web.panel.source");
  });

  it("dispose leaves the shell exactly as found (honesty smoke test)", () => {
    const fake = makeFakeEditor();
    const loaded = loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: { openPanel() {}, closePanel() {} },
    });
    loaded.dispose();
    expect(fake.panels.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
    expect(fake.objectTypes.types()).toHaveLength(0);
    expect(fake.editContexts.types()).toHaveLength(0);
  });
});
