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

// The real Blitz engine for conformance specs, plus a scene channel on the
// headless host.
//
// · `blitzPresent` / `requireBlitz(name)`: the dual gate every real-engine
//   spec uses — skip locally when the artifact is absent, FAIL under
//   REQUIRE_REAL_ENGINE=1.
// · `primeBlitz(host)`: load the artifact from disk (Node has no relative
//   fetch → initSync) INTO the bundle's memoized loader, so every command
//   and the auto renderer use the real engine.
// · `recordScene(h)`: the headless editor wires no scene channel; this
//   installs a recording one on the editor handle BEFORE the bundle loads,
//   so `supports("rendering.sceneLayer@1")` is true and the bundle's real
//   submit/clear calls land somewhere a spec can read.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { SceneLayer } from "@paged-media/web-model";

import { _resetWebEngineCache, loadWebEngine, type WebEngine } from "../../src/engine-loader";

const binDir = fileURLToPath(new URL("../../bin/", import.meta.url));
const gluePath = binDir + "blitz_web.js";
const wasmPath = binDir + "blitz_web_bg.wasm";

export const blitzPresent = existsSync(gluePath) && existsSync(wasmPath);

/** Register the REQUIRED failure when the artifact is missing under
 *  REQUIRE_REAL_ENGINE=1 (call at module scope). */
export function requireBlitz(suite: string): void {
  if (process.env.REQUIRE_REAL_ENGINE === "1" && !blitzPresent) {
    describe(`${suite} — REQUIRED`, () => {
      it("FAILS: REQUIRE_REAL_ENGINE=1 but the engine artifact is missing", () => {
        throw new Error(
          `REQUIRE_REAL_ENGINE=1 but ${wasmPath} (or its glue) is missing — ` +
            "build it with `bash scripts/build-wasm.sh --engine`",
        );
      });
    });
  }
}

/** Load the real engine into the bundle's memoized loader. */
export async function primeBlitz(host: BundleHost): Promise<WebEngine> {
  _resetWebEngineCache();
  const glue = (await import(new URL("../../bin/blitz_web.js", import.meta.url).href)) as {
    initSync: (m: { module: Uint8Array }) => unknown;
  };
  glue.initSync({ module: readFileSync(wasmPath) });
  const engine = await loadWebEngine(host, {
    importGlue: async () =>
      ({ ...glue, default: async () => undefined }) as never,
  });
  if (!engine) throw new Error("the Blitz engine did not load");
  return engine;
}

/** What the recording scene channel saw. */
export interface SceneRecord {
  /** The live layer per frame id (absent = cleared / never submitted). */
  layers: Map<string, SceneLayer>;
  submits: string[];
  clears: string[];
}

/** Install a recording scene channel on the headless editor. Must run
 *  before `loadBundle` (the host computes its features when it is built). */
export function recordScene(h: HeadlessHost): SceneRecord {
  const rec: SceneRecord = { layers: new Map(), submits: [], clears: [] };
  const editor = h.host.editor as unknown as { sceneLayers?: unknown };
  editor.sceneLayers = {
    async submit(id: string, layer: SceneLayer) {
      rec.submits.push(id);
      rec.layers.set(id, layer);
    },
    async clear(id: string) {
      rec.clears.push(id);
      rec.layers.delete(id);
    },
  };
  return rec;
}

/** Every text run of a layer, joined — what the frame shows. */
export function layerText(layer: SceneLayer | null | undefined): string {
  return (layer?.items ?? [])
    .filter((i) => i.kind === "text")
    .map((i) => (i as { text: string }).text)
    .join(" ");
}

/** The lowest painted y (points) of a layer's text runs. */
export function maxTextY(layer: SceneLayer | null | undefined): number {
  let y = 0;
  for (const i of layer?.items ?? []) if (i.kind === "text") y = Math.max(y, (i as { y: number }).y);
  return y;
}
