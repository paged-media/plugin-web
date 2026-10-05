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

// The engine stamp recorded in every saved source envelope (web-model
// ENGINE_PIN) must name the stack the engine wasm is actually built from —
// packages/web-render/Cargo.lock. A stamp that drifts from the lock records
// a render stack no document was ever rendered with.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENGINE_PIN } from "@paged-media/web-model";

const LOCK = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web-render/Cargo.lock"),
  "utf8",
);

function locked(name: string): string | undefined {
  const m = LOCK.match(new RegExp(`\\nname = "${name}"\\nversion = "([^"]+)"`));
  return m?.[1];
}

describe("ENGINE_PIN = the web-render lockfile", () => {
  it("blitz = blitz-dom", () => expect(ENGINE_PIN.blitz).toBe(locked("blitz-dom")));
  it("stylo = stylo", () => expect(ENGINE_PIN.stylo).toBe(locked("stylo")));
  it("anyrender = anyrender", () => expect(ENGINE_PIN.anyrender).toBe(locked("anyrender")));
});
