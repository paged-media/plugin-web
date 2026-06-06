// Registration + insert-flow wiring against the real in-process host
// adapter over a minimal fake editor (the plugin-draw pattern).
// Engine behavior is not faked; this proves the contract wiring and
// the honesty smoke test.

import { describe, expect, it, vi } from "vitest";

import type { PagedEditor } from "@paged-media/plugin-api";
import { loadBundle } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE, sourceKeyFor } from "@paged-media/web-model";

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

function makeFakeEditor() {
  const panels = fakeRegistry();
  const commands = fakeRegistry();
  let selection: unknown[] = [];
  const created = { kind: "rectangle", id: "uWEB1" };
  const editor = {
    registries: { panels, commands },
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
      mutate: async () => ({
        kind: "mutationApplied",
        payload: { createdId: created, pageIds: ["pg1"] },
      }),
      documentMeta: async () => ({ pageCount: 1, activePage: "pg1" }),
      collection: async () => [],
      setElementSelection: async (ids: unknown[]) => ids,
      elementGeometry: async () => [],
      subscribe: () => () => {},
    },
  };
  return { editor: editor as unknown as PagedEditor, panels, commands, created };
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
  it("registers the source panel (with show/hide) + the insert command", () => {
    const fake = makeFakeEditor();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: mapBacking(),
      shell: { openPanel() {}, closePanel() {} },
    });
    expect(fake.panels.ids()).toEqual(["media.paged.web.panel.source"]);
    expect(fake.commands.ids()).toEqual([
      "media.paged.web.panel.source.show",
      "media.paged.web.panel.source.hide",
      "media.paged.web.command.insertWebFrame",
    ]);
  });

  it("insert command: one mutation, source stored, selected, panel opened", async () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    const backing = mapBacking();
    loadBundle(() => fake.editor, webBundle, {
      console: silent,
      storage: backing,
      shell: { openPanel, closePanel() {} },
    });
    const cmd = fake.commands.get(
      "media.paged.web.command.insertWebFrame",
    ) as unknown as { handler: () => Promise<void> };
    await cmd.handler();
    const key = `paged.plugin.media.paged.web.${sourceKeyFor(fake.created)}`;
    expect(JSON.parse(backing.getItem(key)!)).toEqual(DEFAULT_SOURCE);
    expect(fake.editor.selection.elementSelection).toEqual([fake.created]);
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
  });
});
