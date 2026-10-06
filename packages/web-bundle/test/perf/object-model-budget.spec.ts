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

// Count budget for the object model (ADR 323): a 10-op `objects.batch` over
// three web frames is ONE engine commit (= one undo step) and a constant
// number of host reads — one scene-tree read plus one label read per frame
// it touches, never one per op. Measured 2026-10-06; a pin is lowered by the
// commit that earns it, never raised.
//
// The model is registered on a PRIVATE registry over the harness's core
// backend, with a counting host, so the bundle's own background work (the
// auto-renderer) is not counted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BundleHost, ElementId, MutationInput } from "@paged-media/plugin-api";
import { createObjectRegistry, type CoreObjects, type HeadlessHost } from "@paged-media/plugin-sdk";
import { DEFAULT_SOURCE } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { createWebObjectModel, PLUGIN_ID, webAddress } from "../../src/object-model";
import { openHost } from "../conformance/host";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { countingHost, settle } from "./counting-host";
import { insertWebFrameAt } from "./workload";

describe("object model count budget @feat:plugin-web.object-model", () => {
  let h: HeadlessHost;
  const ids: string[] = [];

  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    h.loadBundle(webBundle);
    for (let i = 0; i < 3; i += 1) {
      const e: ElementId = await insertWebFrameAt(
        h.host as unknown as BundleHost,
        W1_EMPTY_PAGE.pageId,
        [60 + i * 120, 60, 160 + i * 120, 400],
        { ...DEFAULT_SOURCE, html: `<p>frame ${i}</p>` },
      );
      ids.push((e as { id: string }).id);
    }
  });
  afterAll(() => h?.dispose());

  it("10 sets over 3 frames: 1 commit, 1 tree read, 3 label reads, 0 bundle mutates", async () => {
    const core = h.objects.core!;
    const commits: MutationInput[][] = [];
    const countedCore: CoreObjects = new Proxy(core, {
      get(target, key, receiver) {
        if (key === "commit") {
          return (m: readonly MutationInput[]) => {
            commits.push([...m]);
            return target.commit(m);
          };
        }
        const v = Reflect.get(target, key, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const { host, work } = countingHost(h.host as unknown as BundleHost);
    const registry = createObjectRegistry({ core: countedCore });
    registry.register({ plugin: PLUGIN_ID, model: createWebObjectModel(host), parts: host.parts });
    await settle();
    work.reset();

    const a = ids.map((id) => webAddress("webFrame", id));
    const out = await registry.batch([
      { op: "set", address: a[0]!, path: "html", value: "<p>one</p>" },
      { op: "set", address: a[0]!, path: "css", value: "p{color:red}" },
      { op: "set", address: a[0]!, path: "overflow", value: "shrink" },
      { op: "set", address: a[0]!, path: "media", value: "screen" },
      { op: "set", address: a[1]!, path: "html", value: "<p>two</p>" },
      { op: "set", address: a[1]!, path: "css", value: "p{color:blue}" },
      { op: "set", address: a[1]!, path: "vars", value: { k: "v" } },
      { op: "set", address: a[2]!, path: "html", value: "<p>three</p>" },
      { op: "set", address: a[2]!, path: "overflow", value: "grow" },
      { op: "set", address: a[2]!, path: "media", value: "screen" },
    ]);
    await settle();
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });

    if (process.env.PERF_SHOW) console.log("PERF objects.batch(10)", JSON.stringify(work.calls), commits.length);
    expect(commits).toHaveLength(1);
    // The three labels ride that one commit.
    expect(commits[0]!.filter((m) => m.op === "setPluginMetadata")).toHaveLength(3);
    expect(work.count("document.mutate")).toBe(0);
    expect(work.count("document.tree")).toBe(1);
    expect(work.count("document.getMetadata")).toBe(3);
    expect(work.reads()).toBe(4);
    expect(await registry.get(a[1]!, "vars")).toEqual({ kind: "value", value: { k: "v" } });
  });
});
