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

// DOCUMENT EDITED — one way to hear every change the canvas has to follow.
//
// The host's `document.onDidChange` reports mutations, undos and redos. The
// editor changes the document a second way: a canvas GESTURE (a frame
// resized or moved by its handles, a rotate) is begun, updated and committed
// on the engine, and its commit answers `gestureCommitted` — which that door
// does not report. A web frame resized by its handles therefore kept its old,
// clipped render until "Render frame" was run by hand.
//
// Until the door reports gesture commits, the editor client's raw broadcast
// (the `host.editor` escape hatch, the way document-opened.ts hears an open on
// an older host) fills the gap. A host without an editor handle reports what
// its door reports. Both together may report one change twice; every
// listener here is idempotent (a debounced pass, a geometry re-read).

import type { BundleHost, Disposable, DocumentChangeEvent, PageId } from "@paged-media/plugin-api";

/** A change the bundle follows: the door's event, or a gesture's commit. */
export type DocumentEdit =
  | DocumentChangeEvent
  | { kind: "gestureCommitted"; pageIds: PageId[]; reflow?: undefined };

/** Call `listener` after every change to the document — the host's change
 *  events and the editor's gesture commits. */
export function onDocumentEdited(host: BundleHost, listener: (e: DocumentEdit) => void): Disposable {
  const sub = host.document.onDidChange((e) => listener(e));
  let off: () => void = () => {};
  try {
    off = host.editor.client.subscribe((msg) => {
      if (msg.kind === "gestureCommitted") listener({ kind: "gestureCommitted", pageIds: msg.payload.pageIds });
    });
  } catch {
    // No editor handle: the door's events are all there is.
  }
  return {
    dispose() {
      sub.dispose();
      off();
    },
  };
}
