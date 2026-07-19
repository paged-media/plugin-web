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

// ADR-020 rung 2 — the FLOW lifecycle commands: persist a region chain on
// the source frame (threadSelectedIntoFlow) and resolve it for rendering
// (resolveFlowChain). These pin the PERSISTENCE behavior (the fix for the
// earlier ephemeral, selection-only chain) with a mock host — no editor.

import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  DEFAULT_SOURCE,
  envelopeFor,
  flowThreadOptions,
  type WebFrameSource,
} from "@paged-media/web-model";

import {
  resolveFlowChain,
  threadSelectedIntoFlow,
  threadSelectedIntoNamedFlow,
  unthreadSelectedFromFlow,
} from "../src/render-flow-command";

const S = { kind: "rectangle", id: "uS" } as ElementId;
const B = { kind: "rectangle", id: "uB" } as ElementId;
const C = { kind: "textFrame", id: "uC" } as ElementId;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A host whose `getMetadata` returns `metadata` for any id, records every
 *  `setMetadata` write, and has no container parts (so the source rides the
 *  label — `readSourcePart` → null, `writeSourcePart` → no-op). */
function makeHost(opts: { selection: ElementId[]; metadata: unknown }) {
  const writes: { id: ElementId; envelope: { data: WebFrameSource } }[] = [];
  const host = {
    log: silent,
    selection: { get: () => opts.selection },
    document: {
      getMetadata: async () => opts.metadata,
      setMetadata: async (id: ElementId, envelope: unknown) => {
        writes.push({ id, envelope: envelope as { data: WebFrameSource } });
      },
    },
    parts: { read: async () => null, write: async () => {} },
    supports: () => false,
  } as unknown as BundleHost;
  return { host, writes };
}

describe("resolveFlowChain — the persisted chain wins", () => {
  it("returns [source, ...recipients] from the persisted flow", async () => {
    const threaded: WebFrameSource = {
      ...DEFAULT_SOURCE,
      flow: {
        recipients: [
          { kind: "rectangle", id: "uB" },
          { kind: "textFrame", id: "uC" },
        ],
      },
    };
    const { host } = makeHost({ selection: [S], metadata: envelopeFor(threaded) });
    expect(await resolveFlowChain(host, [S])).toEqual([
      { kind: "rectangle", id: "uS" },
      { kind: "rectangle", id: "uB" },
      { kind: "textFrame", id: "uC" },
    ]);
  });

  it("falls back to a >=2-frame selection when the source is not threaded", async () => {
    const { host } = makeHost({ selection: [S, B], metadata: null });
    expect(await resolveFlowChain(host, [S, B])).toEqual([S, B]);
  });

  it("a lone unthreaded web frame resolves to null (nothing to thread)", async () => {
    const { host } = makeHost({
      selection: [S],
      metadata: envelopeFor(DEFAULT_SOURCE),
    });
    expect(await resolveFlowChain(host, [S])).toBeNull();
  });

  it("an empty selection resolves to null", async () => {
    const { host } = makeHost({ selection: [], metadata: null });
    expect(await resolveFlowChain(host, [])).toBeNull();
  });
});

describe("threadSelectedIntoFlow — persist the region chain", () => {
  it("appends the selected targets to the source's flow and persists once", async () => {
    const { host, writes } = makeHost({
      selection: [S, B, C],
      metadata: envelopeFor(DEFAULT_SOURCE),
    });
    await threadSelectedIntoFlow(host);
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toEqual(S);
    expect(writes[0].envelope.data.flow).toEqual({
      recipients: [
        { kind: "rectangle", id: "uB" },
        { kind: "textFrame", id: "uC" },
      ],
    });
  });

  it("threads into an ARBITRARY named flow — the picker's 3rd+ flow is reachable (Phase D)", async () => {
    // The commands alone reach only the primary (threadWebFlow) + the 2nd
    // (threadWebFlowNamed); the picker offers ALL declared flows and threads
    // into the chosen one — here the THIRD, 'promo'.
    const threeFlow: WebFrameSource = {
      ...DEFAULT_SOURCE,
      css: "#story{flow-into:main} #notes{flow-into:side} #ads{flow-into:promo}",
    };
    // The picker's model exposes all three (primary + two named).
    expect(flowThreadOptions(threeFlow.css).map((o) => o.name)).toEqual([
      "main",
      "side",
      "promo",
    ]);
    const { host, writes } = makeHost({
      selection: [S, B],
      metadata: envelopeFor(threeFlow),
    });
    // What the picker calls for the 'promo' option: threadSelectedIntoFlow with
    // its name → the recipient is tagged 'promo'.
    await threadSelectedIntoFlow(host, "promo");
    expect(writes).toHaveLength(1);
    expect(writes[0].envelope.data.flow?.recipients).toEqual([
      { kind: "rectangle", id: "uB", flow: "promo" },
    ]);
  });

  it("threads the OVERRIDE selection even when the live selection is empty (panel picker)", async () => {
    // Clicking a panel button can collapse the canvas selection, so the picker
    // passes the selection it was rendered for; the override wins over
    // host.selection.get() (here empty).
    const { host, writes } = makeHost({
      selection: [], // live selection collapsed
      metadata: envelopeFor(DEFAULT_SOURCE),
    });
    await threadSelectedIntoFlow(host, "promo", [S, B]);
    expect(writes).toHaveLength(1);
    expect(writes[0].envelope.data.flow?.recipients).toEqual([
      { kind: "rectangle", id: "uB", flow: "promo" },
    ]);
  });

  it("is a no-op (no persist) when every target is already threaded", async () => {
    const already: WebFrameSource = {
      ...DEFAULT_SOURCE,
      flow: { recipients: [{ kind: "rectangle", id: "uB" }] },
    };
    const { host, writes } = makeHost({
      selection: [S, B],
      metadata: envelopeFor(already),
    });
    await threadSelectedIntoFlow(host);
    expect(writes).toHaveLength(0);
  });

  it("does not persist when the source is not a web frame", async () => {
    const { host, writes } = makeHost({ selection: [S, B], metadata: null });
    await threadSelectedIntoFlow(host);
    expect(writes).toHaveLength(0);
  });

  it("does not persist for a short (<2) selection", async () => {
    const { host, writes } = makeHost({
      selection: [S],
      metadata: envelopeFor(DEFAULT_SOURCE),
    });
    await threadSelectedIntoFlow(host);
    expect(writes).toHaveLength(0);
  });
});

describe("unthreadSelectedFromFlow — remove frames from the chain", () => {
  const threaded: WebFrameSource = {
    ...DEFAULT_SOURCE,
    flow: {
      recipients: [
        { kind: "rectangle", id: "uB" },
        { kind: "textFrame", id: "uC" },
      ],
    },
  };

  it("removes the selected target from the chain and persists once", async () => {
    const { host, writes } = makeHost({
      selection: [S, B],
      metadata: envelopeFor(threaded),
    });
    await unthreadSelectedFromFlow(host);
    expect(writes).toHaveLength(1);
    expect(writes[0].envelope.data.flow).toEqual({
      recipients: [{ kind: "textFrame", id: "uC" }],
    });
  });

  it("drops the flow entirely when the last recipient is removed", async () => {
    const single: WebFrameSource = {
      ...DEFAULT_SOURCE,
      flow: { recipients: [{ kind: "rectangle", id: "uB" }] },
    };
    const { host, writes } = makeHost({ selection: [S, B], metadata: envelopeFor(single) });
    await unthreadSelectedFromFlow(host);
    expect(writes).toHaveLength(1);
    expect(writes[0].envelope.data.flow).toBeUndefined();
  });

  it("is a no-op (no persist) when the target is not in the flow", async () => {
    const { host, writes } = makeHost({ selection: [S, C], metadata: envelopeFor({ ...DEFAULT_SOURCE, flow: { recipients: [{ kind: "rectangle", id: "uB" }] } }) });
    await unthreadSelectedFromFlow(host);
    expect(writes).toHaveLength(0);
  });
});

describe("threadSelectedIntoNamedFlow — route into the secondary CSS flow", () => {
  it("routes targets into the source's SECOND flow-into (multi-flow authoring)", async () => {
    const twoFlow: WebFrameSource = {
      ...DEFAULT_SOURCE,
      css: "#story{flow-into:main} #notes{flow-into:side}",
    };
    const { host, writes } = makeHost({ selection: [S, B], metadata: envelopeFor(twoFlow) });
    await threadSelectedIntoNamedFlow(host);
    expect(writes).toHaveLength(1);
    expect(writes[0].envelope.data.flow?.recipients).toEqual([
      { kind: "rectangle", id: "uB", flow: "side" },
    ]);
  });

  it("is a no-op when the source declares no secondary named flow", async () => {
    const { host, writes } = makeHost({
      selection: [S, B],
      metadata: envelopeFor({ ...DEFAULT_SOURCE, css: "#story{flow-into:main}" }),
    });
    await threadSelectedIntoNamedFlow(host);
    expect(writes).toHaveLength(0);
  });
});
