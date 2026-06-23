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

// W3.2 — the paged.web OBJECT TYPE + EDIT CONTEXT (closes W-03).
//
// A webFrame is an ordinary rectangle with attached `x-paged:media.paged
// .web` SOURCE metadata (the §5 model). Before W3.2 the shell treated it
// as a plain rectangle — hit-testing, selection chrome, and double-click
// all descended into a group. W3.2 changes that:
//
//   · the OBJECT TYPE `webFrame` (matcher: the element carries a valid
//     source envelope — `sourceFromEnvelope` non-null) routes a
//     double-click to the `webFrame` EDIT CONTEXT instead of group
//     descent (the metadata-claimed half of the registry);
//   · the EDIT CONTEXT raises the source panel on enter (and re-raises
//     it via `host.shell.openPanel` from the bundle's onEnter hook), so
//     double-clicking a webFrame opens source editing.
//
// The matcher reads ONLY this plugin's own-namespace metadata envelope
// (the host pre-resolves it from the host-stamped `x-paged:media.paged
// .web` key and passes it as `candidate.metadata`). Validation reuses
// web-model's `sourceFromEnvelope` so "is a webFrame" matches exactly
// "has a loadable source" — no second predicate to drift.

import type {
  BundleHost,
  EditContextContribution,
  ObjectTypeContribution,
} from "@paged-media/plugin-api";
import {
  sourceFromEnvelope,
  type WebSourceEnvelope,
} from "../../web-model/src";

export const WEB_FRAME_TYPE = "webFrame";

/** The object type — recognizes a webFrame by its source metadata and
 *  routes the double-click to the source edit context. */
export const webFrameObjectType: ObjectTypeContribution = {
  type: WEB_FRAME_TYPE,
  // Metadata-claimed: a rectangle carrying a loadable source envelope IS
  // a webFrame. `candidate.metadata` is this plugin's own envelope,
  // pre-resolved by the host.
  matches: (candidate) =>
    sourceFromEnvelope(candidate.metadata as WebSourceEnvelope | null) !== null,
  // A double-click enters the source edit context (NOT group descent).
  editContextType: WEB_FRAME_TYPE,
  // The baked IDML form is a rectangle (the manifest's declared fallback)
  // — what the webFrame degrades to without the plugin.
  bakedFallback: "rectangle",
};

/** The edit context — entering it raises the source panel. The factory
 *  closes over the host + panel id so the onEnter hook can re-raise the
 *  panel (the host also emphasizes declared `panelIds`, but the hook
 *  makes the open explicit + survives a cockpit that ignores emphasis). */
export function makeWebFrameEditContext(
  host: BundleHost,
  panelId: string,
): EditContextContribution {
  return {
    type: WEB_FRAME_TYPE,
    entry: "doubleClick",
    // No `matches` here: the OBJECT TYPE already routes the double-click
    // to this context (path 1 of resolveDoubleClick). A bare-kind match
    // would be wrong — every rectangle is not a webFrame. The context is
    // reachable ONLY through the objectType claim.
    panelIds: [panelId],
    onEnter: () => {
      // Open / raise the source panel so double-click opens editing.
      host.shell.openPanel(panelId);
    },
  };
}
