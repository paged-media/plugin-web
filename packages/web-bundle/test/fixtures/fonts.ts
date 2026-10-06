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

// Real font bytes for the face specs: the engine's bundled Inter, and the
// same face RENAMED in its `name` table, so a spec can tell a face loaded
// from the container apart from the bundled one by the family a run names.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INTER = fileURLToPath(new URL("../../../web-render/assets/fonts/Inter.ttf", import.meta.url));

/** The bundled Inter face (TrueType). */
export function interBytes(): Uint8Array {
  return new Uint8Array(readFileSync(INTER));
}

/** Inter with every "Inter" in its `name` table replaced by `name` (five
 *  letters, so no offset moves): a face whose own family is `name`. */
export function renamedFace(name: string): Uint8Array {
  if (name.length !== 5) throw new Error("the new name keeps the length of 'Inter'");
  const bytes = interBytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = view.getUint16(4);
  let start = -1;
  let length = 0;
  for (let i = 0; i < tables; i += 1) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4));
    if (tag === "name") {
      start = view.getUint32(rec + 8);
      length = view.getUint32(rec + 12);
    }
  }
  if (start < 0) throw new Error("no name table");
  const replace = (from: number[], to: number[]) => {
    for (let i = start; i + from.length <= start + length; i += 1) {
      if (from.every((b, k) => bytes[i + k] === b)) to.forEach((b, k) => (bytes[i + k] = b));
    }
  };
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const utf16 = (s: string) => [...s].flatMap((c) => [0, c.charCodeAt(0)]);
  replace(utf16("Inter"), utf16(name));
  replace(ascii("Inter"), ascii(name));
  return bytes;
}
