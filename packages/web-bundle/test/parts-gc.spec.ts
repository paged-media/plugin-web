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

// The source-part collector's choices (ADR 410) on a modelled host with a
// delete door: what the opened file carried and no label names goes on
// save; what a label names, what this session wrote, and anything that is
// not a source part stays; without the delete door nothing goes.

import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, storeSource, type WebFrameSource } from "@paged-media/web-model";

import { startPartsCollector } from "../src/parts-gc";
import { DOCUMENT_VALUES_PART, readDocumentValues, writeDocumentValues, writeWebSource } from "../src/source-part";

const big = (tag: string): WebFrameSource => ({
  ...DEFAULT_SOURCE,
  html: `<p>${tag}</p>` + "<p>lorem ipsum dolor</p>".repeat(5000),
});

function modelHost(opts: { canDelete?: boolean; didOpen?: boolean; docMeta?: boolean } = {}) {
  // A host with `document.onDidOpen` (the default) announces an opened
  // document there; an older one only on the raw client broadcast.
  const didOpen = opts.didOpen !== false;
  const opened: (() => void)[] = [];
  const parts = new Map<string, Uint8Array>();
  const labels = new Map<string, unknown>();
  const items = new Set<string>(["uA", "uB"]);
  // The plugin's document metadata, with its undo history.
  const docMeta: { now: unknown; undo: unknown[] } = { now: null, undo: [] };
  let willSave: (() => Promise<void>) | null = null;
  const loaded: ((m: { kind: string }) => void)[] = [];
  const host = {
    supports: (f: string) =>
      f === "storage.parts@1" ||
      (f === "storage.parts@2" && opts.canDelete !== false) ||
      (f === "document.onDidOpen@1" && didOpen) ||
      (f === "document.documentMetadata@1" && opts.docMeta !== false),
    document: {
      tree: async () =>
        [...items].map((id) => ({ id: { kind: "rectangle", id }, kind: "Rectangle", label: id, children: [] })),
      getMetadata: async (id: ElementId) => labels.get((id as { id: string }).id) ?? null,
      setMetadata: async (id: ElementId, env: unknown) => {
        labels.set((id as { id: string }).id, env);
        return { applied: true };
      },
      getDocumentMetadata: async () => docMeta.now,
      setDocumentMetadata: async (env: unknown) => {
        docMeta.undo.push(docMeta.now);
        docMeta.now = env;
        return { applied: true };
      },
      onWillSave: (l: () => Promise<void>) => {
        willSave = l;
        return { dispose() {} };
      },
      ...(didOpen
        ? {
            onDidOpen: (l: () => void) => {
              opened.push(l);
              return { dispose: () => void opened.splice(opened.indexOf(l), 1) };
            },
          }
        : {}),
    },
    parts: {
      read: async (p: string) => parts.get(p) ?? null,
      write: async (p: string, b: Uint8Array) => void parts.set(p, b),
      list: async (prefix = "") => [...parts.keys()].filter((p) => p.startsWith(prefix)),
      delete: async (p: string) => parts.delete(p),
    },
    editor: { client: { subscribe: (l: (m: { kind: string }) => void) => (loaded.push(l), () => {}) } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as BundleHost;
  return {
    host,
    parts,
    labels,
    items,
    docMeta,
    undoDocMeta: () => {
      docMeta.now = docMeta.undo.pop() ?? null;
    },
    open: async () => {
      if (didOpen) opened.forEach((l) => l());
      else loaded.forEach((l) => l({ kind: "documentLoaded" }));
      await new Promise((r) => setTimeout(r, 0));
    },
    save: () => willSave!(),
    rawSubscribers: () => loaded.length,
  };
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("source-part collector (modelled host)", () => {
  it("drops the opened file's unnamed parts on save and keeps the rest", async () => {
    const m = modelHost();
    const named = storeSource(big("named"));
    if (named.kind !== "part") throw new Error("expected a part");
    m.parts.set(`sources/${named.ref.hash}.json`, enc(named.partText));
    m.labels.set("uA", named.label);
    m.parts.set("sources/00000000deadbeef.json", enc("{}"));
    m.parts.set("uGONE/source.json", enc("{}"));
    m.parts.set("uB/source.json", enc("{}"));
    m.parts.set("other/thing.bin", enc("x"));
    startPartsCollector(m.host);
    await m.open();
    await m.save();
    expect([...m.parts.keys()].sort()).toEqual(
      [`sources/${named.ref.hash}.json`, "other/thing.bin", "uB/source.json"].sort(),
    );
  });

  it("never drops a part written this session, even once no label names it", async () => {
    const m = modelHost();
    startPartsCollector(m.host);
    await m.open();
    const a = { kind: "rectangle", id: "uA" } as ElementId;
    await writeWebSource(m.host, a, big("one"));
    await writeWebSource(m.host, a, big("two"));
    await m.open(); // a reopen marks again; the session's writes still count
    await m.save();
    expect([...m.parts.keys()].filter((p) => p.startsWith("sources/"))).toHaveLength(2);
  });

  it("keeps a marked part that a label names again by the time of the save", async () => {
    const m = modelHost();
    const later = storeSource(big("later"));
    if (later.kind !== "part") throw new Error("expected a part");
    const path = `sources/${later.ref.hash}.json`;
    m.parts.set(path, enc(later.partText));
    startPartsCollector(m.host);
    await m.open();
    m.labels.set("uB", later.label);
    await m.save();
    expect(m.parts.has(path)).toBe(true);
  });

  it("without the delete door nothing is dropped", async () => {
    const m = modelHost({ canDelete: false });
    m.parts.set("sources/00000000deadbeef.json", enc("{}"));
    startPartsCollector(m.host);
    await m.open();
    await m.save();
    expect(m.parts.has("sources/00000000deadbeef.json")).toBe(true);
  });
  for (const didOpen of [true, false]) {
    it(`a file opened after activation is collected (${didOpen ? "document.onDidOpen" : "raw client broadcast"})`, async () => {
      const m = modelHost({ didOpen });
      startPartsCollector(m.host);
      // The opened file brings an orphan the activation mark never saw.
      m.parts.set("sources/00000000deadbeef.json", enc("{}"));
      await m.open();
      await m.save();
      expect(m.parts.has("sources/00000000deadbeef.json")).toBe(false);
      // The door replaces the raw subscription; it is the fallback only.
      expect(m.rawSubscribers()).toBe(didOpen ? 0 : 1);
    });
  }
});

describe("the migrated document-values part", () => {
  const legacy = () => enc(JSON.stringify({ edition: "Legacy" }));

  it("goes on the save of a session that opened it already migrated", async () => {
    const m = modelHost();
    m.parts.set(DOCUMENT_VALUES_PART, legacy());
    m.docMeta.now = { v: 1, data: { documentValues: { edition: "Legacy" } } };
    startPartsCollector(m.host);
    await m.open();
    await m.save();
    expect(m.parts.has(DOCUMENT_VALUES_PART)).toBe(false);
    expect(await readDocumentValues(m.host)).toEqual({ edition: "Legacy" });
  });

  it("stays through the session that migrated it, so undo of the migration finds its values", async () => {
    const m = modelHost();
    m.parts.set(DOCUMENT_VALUES_PART, legacy());
    startPartsCollector(m.host);
    await m.open();
    const values = await readDocumentValues(m.host);
    expect((await writeDocumentValues(m.host, { ...values, year: "2026" })).applied).toBe(true);
    await m.save();
    expect(m.parts.has(DOCUMENT_VALUES_PART)).toBe(true);
    m.undoDocMeta();
    expect(await readDocumentValues(m.host)).toEqual({ edition: "Legacy" });
  });

  it("stays when the metadata carries no values, or the host has no metadata door", async () => {
    const other = modelHost();
    other.parts.set(DOCUMENT_VALUES_PART, legacy());
    other.docMeta.now = { v: 1, data: { somethingElse: true } };
    startPartsCollector(other.host);
    await other.open();
    await other.save();
    expect(other.parts.has(DOCUMENT_VALUES_PART)).toBe(true);

    const old = modelHost({ docMeta: false });
    old.parts.set(DOCUMENT_VALUES_PART, legacy());
    old.docMeta.now = { v: 1, data: { documentValues: { edition: "Legacy" } } };
    startPartsCollector(old.host);
    await old.open();
    await old.save();
    expect(old.parts.has(DOCUMENT_VALUES_PART)).toBe(true);
  });

  it("stays when an undo before the save took the migrated values away again", async () => {
    const m = modelHost();
    m.parts.set(DOCUMENT_VALUES_PART, legacy());
    m.docMeta.now = { v: 1, data: { documentValues: { edition: "Legacy" } } };
    startPartsCollector(m.host);
    await m.open();
    m.docMeta.now = null; // e.g. a host-side reset of the plugin's metadata
    await m.save();
    expect(m.parts.has(DOCUMENT_VALUES_PART)).toBe(true);
  });
});
