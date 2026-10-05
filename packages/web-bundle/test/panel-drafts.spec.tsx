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

// Unsaved panel edits survive leaving the frame.
//
// The panel's draft is not the document until "Save to document". It used
// to live only in the mounted editor, so selecting another frame — or an
// undo that remounted the editor — dropped it without a word. The panel now
// keeps the draft per frame: coming back restores it and it still shows as
// unsaved. Rendered with react-test-renderer against a minimal host.

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, envelopeFor } from "@paged-media/web-model";

import { makeWebSourcePanel } from "../src/panels/web-source-panel";

const A = { kind: "rectangle", id: "uA" } as ElementId;
const B = { kind: "rectangle", id: "uB" } as ElementId;

function panelHost() {
  let selection: ElementId[] = [];
  const selectionListeners = new Set<(ids: ElementId[]) => void>();
  const docListeners = new Set<(e: { kind: string }) => void>();
  const labels = new Map<string, unknown>([
    ["uA", envelopeFor({ ...DEFAULT_SOURCE, html: "<p>A saved</p>" })],
    ["uB", envelopeFor({ ...DEFAULT_SOURCE, html: "<p>B saved</p>" })],
  ]);
  const host = {
    supports: () => false,
    widgets: {},
    selection: {
      get: () => selection,
      onDidChange: (l: (ids: ElementId[]) => void) => {
        selectionListeners.add(l);
        return { dispose: () => selectionListeners.delete(l) };
      },
    },
    document: {
      getMetadata: async (id: ElementId) => labels.get(String((id as { id: unknown }).id)) ?? null,
      setMetadata: async () => ({ applied: true, createdId: null, pageIds: [] }),
      collection: async () => [],
      onDidChange: (l: (e: { kind: string }) => void) => {
        docListeners.add(l);
        return { dispose: () => docListeners.delete(l) };
      },
    },
    parts: { read: async () => null, write: async () => {}, list: async () => [] },
    storage: { get: () => undefined, delete: () => {} },
    diagnostics: { set: () => {} },
    assets: { getFontFace: async () => null },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as BundleHost;
  return {
    host,
    select: (ids: ElementId[]) => {
      selection = ids;
      for (const l of selectionListeners) l(ids);
    },
    emit: (kind: string) => {
      for (const l of docListeners) l({ kind });
    },
  };
}

/** Let the panel's async reads settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

const htmlEditor = (r: ReactTestRenderer) =>
  r.root.find((n) => n.type === "textarea" && n.props["aria-label"] === "Web frame HTML");
const dirtyFlag = (r: ReactTestRenderer) =>
  r.root.find((n) => n.props["data-web-dirty"] !== undefined).props["data-web-dirty"];

async function mountOn(h: ReturnType<typeof panelHost>, id: ElementId) {
  const Panel = makeWebSourcePanel(h.host);
  let r!: ReactTestRenderer;
  h.select([id]);
  await act(async () => {
    r = create(<Panel />);
  });
  await settle();
  return r;
}

describe("unsaved panel edits are kept per frame", () => {
  it("leaving the frame and coming back restores the draft, still unsaved", async () => {
    const h = panelHost();
    const r = await mountOn(h, A);
    expect(htmlEditor(r).props.value).toBe("<p>A saved</p>");

    await act(async () => htmlEditor(r).props.onChange({ target: { value: "<p>A edited</p>" } }));
    expect(dirtyFlag(r)).toBe("true");

    await act(async () => h.select([B]));
    await settle();
    expect(htmlEditor(r).props.value).toBe("<p>B saved</p>");
    expect(dirtyFlag(r)).toBe("false");

    await act(async () => h.select([A]));
    await settle();
    expect(htmlEditor(r).props.value).toBe("<p>A edited</p>");
    expect(dirtyFlag(r)).toBe("true");
  });

  it("an undo that reverts the source keeps the draft, shown as unsaved", async () => {
    const h = panelHost();
    const r = await mountOn(h, A);
    await act(async () => htmlEditor(r).props.onChange({ target: { value: "<p>A edited</p>" } }));
    // The document's source changes under the panel (an undo elsewhere).
    const labels = h.host.document as unknown as {
      getMetadata: (id: ElementId) => Promise<unknown>;
    };
    labels.getMetadata = async () => envelopeFor({ ...DEFAULT_SOURCE, html: "<p>A reverted</p>" });
    await act(async () => h.emit("undoApplied"));
    await settle();
    expect(htmlEditor(r).props.value).toBe("<p>A edited</p>");
    expect(dirtyFlag(r)).toBe("true");
  });
});
