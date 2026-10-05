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

// Where a web frame's source lives, and that every reader agrees with undo.
//
// The host gives the bundle two homes with different rules:
//   · the metadata LABEL (`setMetadata`) — undoable, capped at 64 KiB by
//     the engine;
//   · the container PART (`host.parts`) — uncapped, NOT undoable.
// The fake host below models exactly those two rules (the conformance
// suite repeats the important cases against the real engine). Pinned:
//   1. undo of a save restores the previous source through the one reader
//      every surface uses (panel, render, flow, bake);
//   2. a source over the label cap saves, inserts and reads back, and no
//      label over the cap is ever sent;
//   3. when a source cannot be stored, the refusal is visible (a
//      diagnostic), not a log line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webFrameObjectType } from "../src/edit-context";
import { insertWebFrame } from "../src/insert";
import { loadWebSource, writeWebSource } from "../src/source-part";

const LABEL_CAP = 64 * 1024;
const utf8 = (s: string): number => new TextEncoder().encode(s).length;

interface FakeEngine {
  host: BundleHost;
  undo(): void;
  labelBytes(id: ElementId): number;
  sentLabels: number[];
  diagnostics: Map<string, Array<{ severity: string; message: string }>>;
}

/** A host with the engine's two persistence rules and nothing else. */
function fakeEngine(opts: { parts?: boolean } = {}): FakeEngine {
  const withParts = opts.parts ?? true;
  const labels = new Map<string, string>();
  const parts = new Map<string, Uint8Array>();
  const undoStack: Array<() => void> = [];
  const sentLabels: number[] = [];
  const diagnostics = new Map<string, Array<{ severity: string; message: string }>>();
  let nextId = 1;
  const key = (id: ElementId) => String((id as { id: unknown }).id);

  /** The engine's setPluginMetadata: capped, undoable. */
  const setLabel = (id: string, value: string | null): { applied: boolean; error?: string } => {
    if (value !== null) {
      sentLabels.push(utf8(value));
      if (utf8(value) > LABEL_CAP) {
        return { applied: false, error: `metadata value is ${utf8(value)} bytes; the cap is ${LABEL_CAP}` };
      }
    }
    const prev = labels.get(id);
    if (value === null) labels.delete(id);
    else labels.set(id, value);
    undoStack.push(() => (prev === undefined ? labels.delete(id) : labels.set(id, prev)));
    return { applied: true };
  };

  const host = {
    supports: (f: string) => withParts && f.startsWith("storage.parts@"),
    document: {
      getMetadata: async (id: ElementId) => {
        const v = labels.get(key(id));
        return v === undefined ? null : JSON.parse(v);
      },
      setMetadata: async (id: ElementId, env: unknown) =>
        setLabel(key(id), env === null ? null : JSON.stringify(env)),
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [],
      // insertFrame + setPluginMetadata($created) as ONE atomic batch.
      mutate: async (m: { op: string; args: { ops: Array<{ op: string; args: Record<string, unknown> }> } }) => {
        if (m.op !== "batch") throw new Error(`fake engine: unexpected op ${m.op}`);
        const id = `u${nextId++}`;
        const before = undoStack.length;
        for (const op of m.args.ops) {
          if (op.op === "insertFrame") continue;
          if (op.op === "setPluginMetadata") {
            const r = setLabel(id, op.args.value as string);
            if (!r.applied) {
              undoStack.length = before; // the whole batch is refused
              return { applied: false, error: r.error };
            }
          }
        }
        return { applied: true, createdId: { kind: "rectangle", id } };
      },
    },
    parts: {
      write: async (p: string, b: Uint8Array) => {
        if (!withParts) throw new Error("no container writer");
        parts.set(p, b); // NOT undoable — the host contract
      },
      read: async (p: string) => (withParts ? (parts.get(p) ?? null) : null),
      list: async () => [...parts.keys()],
      delete: async (p: string) => void parts.delete(p),
    },
    selection: { set: async () => {}, get: () => [] },
    shell: { openPanel: () => {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    diagnostics: {
      set: (k: string, d: Array<{ severity: string; message: string }>) => void diagnostics.set(k, d),
    },
  } as unknown as BundleHost;

  return {
    host,
    undo: () => undoStack.pop()?.(),
    labelBytes: (id) => utf8(labels.get(key(id)) ?? ""),
    sentLabels,
    diagnostics,
  };
}

const frame: ElementId = { kind: "rectangle", id: "uF1" } as ElementId;
const src = (html: string): WebFrameSource => ({ ...DEFAULT_SOURCE, html });
/** A source whose envelope is well over the label cap. */
const big = (tag: string): WebFrameSource => src(`<p>${tag}</p>` + "<p>lorem ipsum dolor</p>".repeat(5000));

describe("undo of a save is what every reader sees", () => {
  it("small source: save A, save B, undo → A", async () => {
    const e = fakeEngine();
    expect((await writeWebSource(e.host, frame, src("<p>A</p>"))).applied).toBe(true);
    expect((await writeWebSource(e.host, frame, src("<p>B</p>"))).applied).toBe(true);
    expect((await loadWebSource(e.host, frame))?.html).toBe("<p>B</p>");
    e.undo();
    expect((await loadWebSource(e.host, frame))?.html).toBe("<p>A</p>");
  });

  it("large source: save L1, save L2, undo → L1 (the part does not outlive the label)", async () => {
    const e = fakeEngine();
    expect((await writeWebSource(e.host, frame, big("L1"))).applied).toBe(true);
    expect((await writeWebSource(e.host, frame, big("L2"))).applied).toBe(true);
    expect((await loadWebSource(e.host, frame))?.html.startsWith("<p>L2</p>")).toBe(true);
    e.undo();
    expect((await loadWebSource(e.host, frame))?.html.startsWith("<p>L1</p>")).toBe(true);
  });

  it("undo across the size boundary: save small, save large, undo → small", async () => {
    const e = fakeEngine();
    await writeWebSource(e.host, frame, src("<p>small</p>"));
    await writeWebSource(e.host, frame, big("large"));
    e.undo();
    expect((await loadWebSource(e.host, frame))?.html).toBe("<p>small</p>");
  });

  it("every source reader in src/ goes through loadWebSource (no second reader order)", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(srcDir);
    const offenders = files
      .filter((f) => !f.endsWith("source-part.ts"))
      .filter((f) => /getMetadata\(|readSourcePart\(|parts\.read\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("sources over the 64 KiB label cap", () => {
  it("save: applies, reads back, and never sends a label over the cap", async () => {
    const e = fakeEngine();
    const s = big("save");
    const out = await writeWebSource(e.host, frame, s);
    expect(out.applied).toBe(true);
    expect(await loadWebSource(e.host, frame)).toEqual(s);
    expect(Math.max(...e.sentLabels)).toBeLessThanOrEqual(LABEL_CAP);
    expect(e.labelBytes(frame)).toBeLessThan(1024); // a pointer, not the source
  });

  it("insert/import: the frame is created and carries the large source", async () => {
    const e = fakeEngine();
    const s = big("import");
    let selected: ElementId[] = [];
    (e.host.selection as unknown as { set: (ids: ElementId[]) => Promise<void> }).set = async (
      ids,
    ) => {
      selected = ids;
    };
    await insertWebFrame(e.host, "panel", s);
    expect(selected).toHaveLength(1);
    expect(await loadWebSource(e.host, selected[0])).toEqual(s);
    expect(Math.max(...e.sentLabels)).toBeLessThanOrEqual(LABEL_CAP);
  });

  it("a pointer label still marks the frame as a web frame (double-click routing)", async () => {
    const e = fakeEngine();
    await writeWebSource(e.host, frame, big("pointer"));
    const metadata = await e.host.document.getMetadata(frame);
    expect(webFrameObjectType.matches({ metadata } as never)).toBe(true);
  });

  it("a host without container parts refuses a large save visibly, writing nothing", async () => {
    const e = fakeEngine({ parts: false });
    await writeWebSource(e.host, frame, src("<p>kept</p>"));
    const out = await writeWebSource(e.host, frame, big("refused"));
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/64 KiB/);
    // The previous source is untouched.
    expect((await loadWebSource(e.host, frame))?.html).toBe("<p>kept</p>");
  });

  it("a refused insert/import is a visible diagnostic, not only a log line", async () => {
    const e = fakeEngine({ parts: false });
    await insertWebFrame(e.host, "panel", big("refused-import"));
    const all = [...e.diagnostics.values()].flat();
    expect(all.some((d) => d.severity === "error" && /64 KiB/.test(d.message))).toBe(true);
  });
});
