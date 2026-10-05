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

// Shared by the two Chrome recorders: the font injection (the SAME Inter
// file the engine bakes in, packages/web-render/assets/fonts/Inter.ttf) and
// the fixture hash that ties a recording to the exact fixture bytes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FONT_PATH = resolve(HERE, "../../web-render/assets/fonts/Inter.ttf");

/** sha256 of a file's bytes, hex — the recording's freshness key. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The `@font-face` the recorder injects ahead of the fixture's own styles.
 * One face, weight 400 normal — exactly what the engine registers — so
 * bold/italic are whatever Chrome synthesises from it (the engine has no
 * other face either). Inlined as a data: URL so loading is synchronous with
 * `setContent` and nothing touches the network.
 */
export function fontFaceStyle() {
  const b64 = readFileSync(FONT_PATH).toString("base64");
  return (
    `<style data-paged-recorder>@font-face { font-family: Inter; ` +
    `src: url(data:font/ttf;base64,${b64}) format("truetype"); ` +
    `font-weight: 100 900; font-style: normal; }</style>`
  );
}

/** Insert `snippet` right after `<head>` (or at the start). */
export function injectHead(html, snippet) {
  const m = /<head[^>]*>/i.exec(html);
  if (!m) return snippet + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

/** Launch headless Chromium and verify Inter actually loaded. */
export async function assertInterLoaded(page) {
  const ok = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("16px Inter");
  });
  if (!ok) throw new Error("record: the bundled Inter face did not load");
}
