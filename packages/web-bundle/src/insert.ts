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

// "Insert web frame" — ONE undoable batch: insertFrame + the default
// source written as DOCUMENT METADATA on the batch-created element
// (the protocol v34 `$created` sentinel; metadata round-trips IDML
// since v33). The new frame is selected and the source panel opened.
// The frame itself is an ordinary rectangle (the manifest's declared
// baked fallback); what makes it a webFrame is the metadata attached
// to it — the §5 model. A single undo removes frame AND source.

import type { BundleHost, PageId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  DEFAULT_SOURCE,
  envelopeFor,
} from "@paged-media/web-model";

/** Default frame bounds, page-local pt: [top, left, bottom, right]. */
const DEFAULT_BOUNDS: [number, number, number, number] = [60, 60, 240, 300];

/** This plugin's metadata namespace — MUST equal the host's derived
 *  key (`x-paged:<manifest.id>`); the host gate rejects anything
 *  else, so a drift here fails loudly, not silently. */
const METADATA_KEY = "x-paged:media.paged.web";

interface PageSummaryLike {
  selfId: string;
}

async function activePageId(host: BundleHost): Promise<PageId | null> {
  const meta = await host.document.meta();
  if (meta.activePage) return meta.activePage;
  const pages = await host.document.collection<PageSummaryLike>("pages");
  return pages.length > 0 ? pages[0].selfId : null;
}

export async function insertWebFrame(
  host: BundleHost,
  panelId: string,
): Promise<void> {
  const pageId = await activePageId(host);
  if (!pageId) {
    host.log.warn("insertWebFrame: no page to insert into");
    return;
  }
  const outcome = await host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op: "insertFrame", args: { pageId, bounds: DEFAULT_BOUNDS } },
        {
          op: "setPluginMetadata",
          args: {
            // The v34 batch-created sentinel — resolves to the frame
            // minted by the insert above. The host gate verifies the
            // key is this plugin's own namespace.
            elementId: { kind: "rectangle", id: "$created" },
            key: METADATA_KEY,
            value: JSON.stringify(envelopeFor(DEFAULT_SOURCE)),
          },
        },
      ],
    },
  });
  if (!outcome.applied || !outcome.createdId) {
    host.log.warn("insertWebFrame rejected by engine", outcome);
    return;
  }
  if (!asFrameTarget(outcome.createdId)) {
    host.log.warn("insertWebFrame: created element is not a frame target");
    return;
  }
  await host.selection.set([outcome.createdId]);
  host.shell.openPanel(panelId);
}
