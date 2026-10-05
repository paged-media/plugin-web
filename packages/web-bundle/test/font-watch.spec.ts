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

// The panel's document-font watch (font-watch.ts) on a fake document: a
// burst of changes is ONE trailing read, and the panel hears only about a
// family list that actually changed. (The real-host count is in
// perf/perf-budgets.spec.ts.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BundleHost, DocumentChangeEvent } from "@paged-media/plugin-api";

import { FONT_WATCH_DELAY_MS, watchDocumentFonts } from "../src/panels/font-watch";

function fakeDocument(families: string[][]) {
  let fire: ((e: DocumentChangeEvent) => void) | null = null;
  let reads = 0;
  let disposed = false;
  const document = {
    collection: vi.fn(async () => {
      const list = families[Math.min(reads, families.length - 1)];
      reads += 1;
      return list.map((family) => ({ family }));
    }),
    onDidChange: (l: (e: DocumentChangeEvent) => void) => {
      fire = l;
      return { dispose: () => void (disposed = true) };
    },
  } as unknown as BundleHost["document"];
  return {
    host: { document },
    change: () => fire?.({ kind: "mutationApplied", pageIds: [] }),
    reads: () => reads,
    disposed: () => disposed,
  };
}

describe("watchDocumentFonts [plugin-web.source-panel]", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("reads once on mount and once per BURST of changes, after the quiet time", async () => {
    const doc = fakeDocument([["A"], ["A"]]);
    const got: string[][] = [];
    const w = watchDocumentFonts(doc.host, (f) => got.push(f));
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.reads()).toBe(1);
    expect(got).toEqual([["A"]]);

    for (let i = 0; i < 500; i++) doc.change();
    await vi.advanceTimersByTimeAsync(FONT_WATCH_DELAY_MS - 1);
    expect(doc.reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(doc.reads()).toBe(2);
    // The list did not change: nothing is delivered.
    expect(got).toEqual([["A"]]);
    w.dispose();
  });

  it("delivers a changed family list (order does not count as a change)", async () => {
    const doc = fakeDocument([["A", "B"], ["B", "A"], ["B", "A", "C"]]);
    const got: string[][] = [];
    const w = watchDocumentFonts(doc.host, (f) => got.push(f), { delayMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    doc.change();
    await vi.advanceTimersByTimeAsync(10);
    expect(got).toHaveLength(1);
    doc.change();
    await w.flush();
    expect(got).toEqual([["A", "B"], ["B", "A", "C"]]);
    w.dispose();
  });

  it("dispose drops a pending re-read and a reply in flight", async () => {
    const doc = fakeDocument([["A"], ["Z"]]);
    const got: string[][] = [];
    const w = watchDocumentFonts(doc.host, (f) => got.push(f));
    await vi.advanceTimersByTimeAsync(0);
    doc.change();
    w.dispose();
    await vi.advanceTimersByTimeAsync(FONT_WATCH_DELAY_MS * 2);
    expect(doc.reads()).toBe(1);
    expect(doc.disposed()).toBe(true);
    expect(got).toEqual([["A"]]);
  });
});
