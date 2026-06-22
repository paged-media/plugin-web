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

// W-05 — the linter → host.diagnostics → host problems-panel wiring.
//
// The source panel lints HTML on every (debounced) edit and publishes
// the result through `host.diagnostics.set(sourceKey, …)`. Before
// W-05 those diagnostics only rendered inline in the panel; now the
// host injects a `diagnosticsSink` that fans them out to the editor's
// Problems panel. This proves that contract end-to-end against the
// real in-process host adapter (no DOM): the linter's findings — incl.
// the §6.1 policy ERROR for `<script>` — reach the sink keyed by the
// plugin id + source key, and clearing removes them.

import { describe, expect, it } from "vitest";

import type { Diagnostic, PagedEditor } from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import { diagnoseHtml, sourceKeyFor } from "@paged-media/web-model";

import { webBundle } from "../src";

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

// Minimal editor handle — diagnostics never touch the engine.
const fakeEditor = {} as unknown as PagedEditor;

describe("web linter → host.diagnostics fan-out (W-05)", () => {
  it("publishes the linter's findings to the host problems sink", () => {
    const published: Array<{ bundleId: string; key: string; diags: Diagnostic[] }> =
      [];
    const cleared: Array<{ bundleId: string; key?: string }> = [];
    const { host } = createBundleHost(() => fakeEditor, manifest, {
      console: silent,
      storage: mapBacking(),
      diagnosticsSink: {
        publish: (bundleId, key, diags) => published.push({ bundleId, key, diags }),
        clear: (bundleId, key) => cleared.push({ bundleId, key }),
      },
    });

    // What the panel's `commit` does on an edit with a policy violation.
    const key = sourceKeyFor({ kind: "rectangle", id: "uWEB1" });
    const diagnostics = diagnoseHtml("<p>ok</p>\n<script>alert(1)</script>");
    host.diagnostics.set(key, diagnostics);

    expect(published).toHaveLength(1);
    expect(published[0].bundleId).toBe("media.paged.web");
    expect(published[0].key).toBe(key);
    // The §6.1 policy error surfaces with its line.
    const policy = published[0].diags.find((d) => d.severity === "error");
    expect(policy?.message).toMatch(/never executes/);
    expect(policy?.line).toBe(2);

    // A clean edit clears the source's diagnostics from the panel.
    host.diagnostics.set(key, diagnoseHtml("<p>ok</p>"));
    expect(published).toHaveLength(2);
    expect(
      published[1].diags.some((d) => d.severity === "error"),
    ).toBe(false);

    host.diagnostics.clear(key);
    expect(cleared).toEqual([{ bundleId: "media.paged.web", key }]);
  });

  it("supports('diagnostics.publish@1') is advertised when the host wires a sink", () => {
    const { host } = createBundleHost(() => fakeEditor, manifest, {
      console: silent,
      storage: mapBacking(),
      diagnosticsSink: { publish() {}, clear() {} },
    });
    expect(host.supports("diagnostics.publish@1")).toBe(true);
  });
});
