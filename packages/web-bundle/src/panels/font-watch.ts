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

// The source panel's document-font watch, extracted from the panel effect
// so the perf budgets drive the SAME code the panel runs (no test-side
// mirror). The `fonts` collection crosses family NAMES (no bytes); it is
// read once on mount and again on every document change — registering or
// removing a document font changes which families resolve. Failures read
// as "no registry" (empty), never a crash.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

/** The `fonts` collection's row shape we read — family NAMES only.
 *  Structural twin of the wire `FontSummary` (not re-exported from
 *  plugin-api), so the bundle stays decoupled from the vendored wire
 *  types. The wire shape carries no face BYTES; those come from the
 *  asset store (`font-resolution.ts`). */
interface FontSummaryLike {
  family: string;
}

/**
 * Watch the document's registered font families: `onFamilies` receives the
 * list once now and after every document change. Returns the subscription;
 * disposing it also drops replies still in flight.
 */
export function watchDocumentFonts(
  host: Pick<BundleHost, "document">,
  onFamilies: (families: string[]) => void,
): Disposable {
  let stale = false;
  const refresh = (): void => {
    void host.document
      .collection<FontSummaryLike>("fonts")
      .then((rows) => {
        if (stale) return;
        onFamilies(
          rows
            .map((r) => (typeof r.family === "string" ? r.family : ""))
            .filter((f) => f.length > 0),
        );
      })
      .catch(() => {
        if (!stale) onFamilies([]);
      });
  };
  refresh();
  const sub = host.document.onDidChange(() => refresh());
  return {
    dispose: () => {
      stale = true;
      sub.dispose();
    },
  };
}
