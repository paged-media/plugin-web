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

// The suite is evidence about the contract it RESOLVED, not the one a
// manifest names. Pinned here:
//
// 1. the installed plugin-api / plugin-sdk are the devDependency versions
//    (a stale node_modules or a sibling link would otherwise test some
//    other contract and report green);
// 2. plugin-api and plugin-sdk move together (they release together);
// 3. the published peer range admits the pin the specs ran against (the
//    floor itself stays a deliberate compatibility floor).

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Pkg {
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const bundle = JSON.parse(readFileSync(resolve(HERE, "../package.json"), "utf8")) as Pkg;

const API = "@paged-media/plugin-api";
const SDK = "@paged-media/plugin-sdk";
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** The version installed under `node_modules/<name>` — read from the file,
 *  because the packages' `exports` map hides `./package.json`. */
function installedVersion(name: string): string {
  const dir = realpathSync(resolve(HERE, "..", "node_modules", name));
  return (JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { version: string })
    .version;
}

/** Numeric compare of `a.b.c-canary.n` versions (enough for our pins). */
function cmp(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

describe("the SDK contract the specs run against", () => {
  for (const name of [API, SDK]) {
    const pin = bundle.devDependencies?.[name] ?? "";

    it(`${name}: web-bundle pins an exact version (no dist-tag, no range)`, () => {
      expect(pin).toMatch(EXACT);
    });

    it(`${name}: installed = the devDependency pin`, () => {
      expect(installedVersion(name)).toBe(pin);
    });

    it(`${name}: the peer range admits the tested pin`, () => {
      const peer = bundle.peerDependencies?.[name] ?? "";
      const floor = peer.match(/^>=(.+)$/)?.[1];
      expect(floor, `peer ${peer} is not a >= floor`).toBeDefined();
      expect(cmp(floor!, pin)).toBeLessThanOrEqual(0);
    });
  }

  it("plugin-api and plugin-sdk are pinned to the same version (they release together)", () => {
    expect(bundle.devDependencies?.[API]).toBe(bundle.devDependencies?.[SDK]);
  });
});
