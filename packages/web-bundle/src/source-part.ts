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

// `.paged` CONTAINER persistence for the web source (file-format.md §4/§8).
//
// The HTML/CSS source is the web frame's SPEC. Historically it lived in the
// frame's `x-paged:media.paged.web` metadata LABEL — but a Label is capped at
// 64 KiB (BREAKAGE D-08), too small for real pages. The source now ALSO rides
// the document as a `.paged` container part (`paged/media.paged.web/<id>/
// source.json`) via `host.parts`: uncapped, binary-friendly, and it travels
// WITH the file (unlike per-browser OPFS). The label stays as the webFrame
// MARKER (edit-context detection keys off it) + a backward-compat read source;
// the part is the portable home + the read PREFERENCE.
//
// Forward/backward-safe: a host with no container writer
// (`supports("storage.parts@1")` is false — an older editor) is a clean no-op,
// and a document with no part falls back to the label, so existing documents
// keep working unchanged.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  envelopeFor,
  sourceFromEnvelope,
  type WebFrameSource,
} from "@paged-media/web-model";

type PartsHost = Pick<BundleHost, "parts" | "supports">;

/** The container part path for a frame's source, relative to this plugin's
 *  `paged/media.paged.web/` namespace (the host prepends it). `null` when the
 *  element id has no string id (web frames are always rectangles). */
function partPath(id: ElementId): string | null {
  const raw = (id as { id?: unknown }).id;
  return typeof raw === "string" ? `${raw}/source.json` : null;
}

/** Write the web source to the container part (the portable, uncapped home).
 *  Best-effort: no container writer ⇒ no-op (the label remains the source). */
export async function writeSourcePart(
  host: PartsHost,
  id: ElementId,
  source: WebFrameSource,
): Promise<void> {
  const path = partPath(id);
  if (!path || !host.supports("storage.parts@1")) return;
  const bytes = new TextEncoder().encode(JSON.stringify(envelopeFor(source)));
  await host.parts.write(path, bytes);
}

/** Read the web source from the container part, or `null` when absent / no
 *  container writer — the caller then falls back to the metadata label. */
export async function readSourcePart(
  host: PartsHost,
  id: ElementId,
): Promise<WebFrameSource | null> {
  const path = partPath(id);
  if (!path || !host.supports("storage.parts@1")) return null;
  const bytes = await host.parts.read(path);
  if (!bytes) return null;
  try {
    return sourceFromEnvelope(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown as Parameters<
        typeof sourceFromEnvelope
      >[0],
    );
  } catch {
    return null;
  }
}
