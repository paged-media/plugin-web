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

// "Insert web frame" — ONE undoable batch: insertFrame + the source label
// written as DOCUMENT METADATA on the batch-created element (the protocol
// v34 `$created` sentinel; metadata round-trips IDML since v33). A source
// too large for a label (the .html importer can hand in any size) is first
// written to a content-addressed container part and the label carries the
// pointer (source-part.ts). The new frame is selected and the source panel
// opened. A refusal is published as a diagnostic, not only logged.
// The frame itself is an ordinary rectangle (the manifest's declared
// baked fallback); what makes it a webFrame is the metadata attached
// to it — the §5 model. A single undo removes frame AND source.

import type { BundleHost, PageId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  DEFAULT_SOURCE,
  type WebFrameSource,
} from "../../web-model/src";

import { describeRefusal, prepareSourceLabel } from "./source-part";

/** Diagnostics key for insert/import refusals. */
export const INSERT_DIAG_KEY = "media.paged.web#insert";

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
  // The importer hands in a file-derived source; the command keeps the
  // starter default.
  source: WebFrameSource = DEFAULT_SOURCE,
): Promise<void> {
  const refuse = (message: string, detail?: unknown): void => {
    host.log.warn(`insertWebFrame: ${message}`, detail);
    host.diagnostics.set(INSERT_DIAG_KEY, [
      { severity: "error", message: `Web frame not inserted: ${message}`, source: "insert" },
    ]);
  };
  const pageId = await activePageId(host);
  if (!pageId) {
    refuse("there is no page to insert into");
    return;
  }
  const prepared = await prepareSourceLabel(host, source);
  if ("refused" in prepared) {
    refuse(prepared.refused);
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
            value: JSON.stringify(prepared.label),
          },
        },
      ],
    },
  });
  if (!outcome.applied || !outcome.createdId) {
    refuse(outcome.applied ? "the document created no frame" : describeRefusal(outcome.error), outcome);
    return;
  }
  if (!asFrameTarget(outcome.createdId)) {
    refuse("the created element is not a frame");
    return;
  }
  host.diagnostics.set(INSERT_DIAG_KEY, []);
  await host.selection.set([outcome.createdId]);
  host.shell.openPanel(panelId);
}
