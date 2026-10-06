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

// DOCUMENT OPENED — one way to hear that the active document was replaced
// (a file opened, a new document made): auto render (auto-render.ts) resets
// its bookkeeping and renders the new document's web frames; the source-part
// collector (parts-gc.ts) marks what the opened file carried.
//
// A host with `document.onDidOpen@1` reports it through that door. An older
// host has only the editor client's raw `documentLoaded` broadcast; a host
// with neither never announces an open, and activation's pass is the only
// open pass.

import type { BundleHost } from "@paged-media/plugin-api";

/** Call `listener` whenever another document opens; the returned function
 *  stops listening. Not called for the document already open. */
export function onDocumentOpened(host: BundleHost, listener: () => void): () => void {
  if (typeof host.document.onDidOpen === "function" && host.supports("document.onDidOpen@1")) {
    const sub = host.document.onDidOpen(() => listener());
    return () => sub.dispose();
  }
  try {
    return host.editor.client.subscribe((msg) => {
      if (msg.kind === "documentLoaded") listener();
    });
  } catch {
    return () => {};
  }
}
