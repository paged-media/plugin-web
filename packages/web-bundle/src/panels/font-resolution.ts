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

// W-06 — the REAL bytes path, extracted from the panel so the spec
// exercises the same code the effect runs (not a test-side mirror).
//
// For each family the source CSS uses AND the document registers, ask
// the capability-gated asset store for the face BYTES
// (`host.assets.getFontFace` — the editor serves engine-registered
// families for real since W-06 landed v43) and inline them as a
// `data:` URL `@font-face` source. `data:` — not an object URL — is
// deliberate: the preview iframe is `sandbox=""` (opaque origin), and
// `blob:` URLs are origin-bound to their creator, so the sandboxed
// document cannot fetch them; a data URL carries the bytes inline and
// resolves anywhere. A `null`/failed/empty answer is the honest miss:
// the family stays OUT of `shown`, the preview substitutes, and the
// badge says so.

import type { BundleHost } from "@paged-media/plugin-api";
import {
  fontFaceDataUrl,
  fontParity,
  type ResolvedFontFace,
} from "../../../web-model/src";

export interface ResolvedPreviewFonts {
  /** `@font-face` inputs (data-url src) for `composeFontFaces`. */
  faces: ResolvedFontFace[];
  /** Families whose bytes were actually served — the badge/diagnostic
   *  "shown" set. */
  shown: string[];
}

const NOTHING: ResolvedPreviewFonts = { faces: [], shown: [] };

/**
 * Resolve the used+registered families to data-url `@font-face`
 * entries. Only families that are BOTH used by the css AND registered
 * by the document are asked for (an unregistered family has no
 * document bytes by definition). Without the `assets.fonts@1` feature
 * (no byte source injected — the headless/older-host path), resolves
 * to nothing and the honest substitution badge stays. Never throws.
 */
export async function resolvePreviewFontFaces(
  host: Pick<BundleHost, "supports" | "assets">,
  css: string,
  registered: readonly string[],
): Promise<ResolvedPreviewFonts> {
  if (!host.supports("assets.fonts@1")) return NOTHING;
  const { matched } = fontParity(css, registered);
  if (matched.length === 0) return NOTHING;
  const faces: ResolvedFontFace[] = [];
  const shown: string[] = [];
  for (const family of matched) {
    try {
      const asset = await host.assets.getFontFace(family);
      if (!asset || asset.bytes.byteLength === 0) continue;
      const src = fontFaceDataUrl(asset.bytes, asset.format);
      if (src.length === 0) continue;
      faces.push({ family, src, format: asset.format });
      shown.push(family);
    } catch {
      // A failing read is just "no bytes" — substitute + badge.
    }
  }
  return { faces, shown };
}
