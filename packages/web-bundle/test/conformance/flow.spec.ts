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

// Conformance — the FLOW lifecycle (thread → render → unthread) driven
// through the REAL headless editor host (createHeadlessHost + the real
// canvas-wasm engine), NOT a mock. Inserts a source + a recipient web
// frame, threads them, and verifies the persisted region chain resolves
// through the host; renderWebFlow runs cleanly (the Blitz engine is not
// loaded in Node → the honest not-loaded path); unthread removes the chain.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { CommandContribution, ElementId } from "@paged-media/plugin-api";

import { webBundle } from "../../src";
import { resolveFlowChain } from "../../src/render-flow-command";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { openHost } from "./host";

const fire = (h: HeadlessHost, id: string): Promise<unknown> => {
  const c = h.contributions.find((x) => x.kind === "command" && x.id === id);
  return Promise.resolve((c!.value as CommandContribution).handler(undefined));
};
const idOf = (e: ElementId): string => (e as { id: string }).id;

describe("web conformance — flow lifecycle through the real host", () => {
  let h: HeadlessHost;
  let source: ElementId;
  let recipient: ElementId;

  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    h.loadBundle(webBundle);
    // Insert two web frames — the source, then a recipient. Each insert
    // selects the frame it created, so selection[0] is the new frame id.
    await fire(h, "media.paged.web.command.insertWebFrame");
    source = h.host.selection.get()[0];
    await fire(h, "media.paged.web.command.insertWebFrame");
    recipient = h.host.selection.get()[0];
  });
  afterAll(() => h?.dispose());

  it("inserted two distinct web frames", () => {
    expect(idOf(source)).not.toBe(idOf(recipient));
  });

  it("threadWebFlow persists a chain that resolves through the host", async () => {
    await h.host.selection.set([source, recipient]);
    await fire(h, "media.paged.web.command.threadWebFlow");

    // Resolve the PERSISTED chain via the plugin's own resolver (reads the
    // container part / metadata label back from the real host).
    const chain = await resolveFlowChain(h.host, [source]);
    expect(chain).not.toBeNull();
    expect(chain!.map(idOf)).toEqual([idOf(source), idOf(recipient)]);
  });

  it("renderWebFlow runs cleanly through the real host (engine not loaded in Node)", async () => {
    await h.host.selection.set([source]);
    // The command must complete without throwing — a loaded engine would
    // submit layers; here the honest not-loaded path is taken.
    await expect(fire(h, "media.paged.web.command.renderWebFlow")).resolves.toBeUndefined();
  });

  it("unthreadWebFlow removes the recipient — the chain no longer resolves", async () => {
    await h.host.selection.set([source, recipient]);
    await fire(h, "media.paged.web.command.unthreadWebFlow");
    // A lone unthreaded source resolves to null (nothing to thread).
    expect(await resolveFlowChain(h.host, [source])).toBeNull();
  });
});
