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
// mirror). The `fonts` collection crosses family NAMES (no bytes). Failures
// read as "no registry" (empty), never a crash.
//
// WHEN it reads. Registering or removing a document font — or any edit that
// changes which families the document references — can change the list, but
// the change event carries no hint of WHICH kind of edit happened
// (`DocumentChangeEvent` is `{ kind, pageIds, reflow? }`), so it cannot be
// filtered by kind. It used to re-read the whole collection on EVERY change
// (1 001 reads for 1 000 edits). Now a burst of changes collapses into ONE
// trailing read `delayMs` after the last change, and `onFamilies` fires only
// when the family list actually differs from the one last delivered (a
// sorted fingerprint), so an edit that touches no font re-renders nothing.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

/** The `fonts` collection's row shape we read — family NAMES only.
 *  Structural twin of the wire `FontSummary` (not re-exported from
 *  plugin-api), so the bundle stays decoupled from the vendored wire
 *  types. The wire shape carries no face BYTES; those come from the
 *  asset store (`font-resolution.ts`). */
interface FontSummaryLike {
  family: string;
}

/** Quiet time after the last document change before the list is re-read.
 *  Long enough to swallow a burst (a drag, a paste, a batch of edits),
 *  short enough that a newly registered font shows in the panel promptly. */
export const FONT_WATCH_DELAY_MS = 250;

export interface FontWatchOptions {
  /** Trailing quiet time before a re-read (default {@link FONT_WATCH_DELAY_MS}). */
  delayMs?: number;
}

/** The watch's subscription. `flush()` runs a pending re-read now and
 *  resolves once it has been delivered (or immediately when none is
 *  pending) — for tests and for a caller that must not wait the delay. */
export interface FontWatch extends Disposable {
  flush(): Promise<void>;
}

const fingerprint = (families: readonly string[]): string =>
  [...new Set(families)].sort().join("\u0000");

/**
 * Watch the document's registered font families: `onFamilies` receives the
 * list once now, and again after document changes WHEN the list changed.
 * Returns the subscription; disposing it also drops replies still in flight
 * and any pending re-read.
 */
export function watchDocumentFonts(
  host: Pick<BundleHost, "document">,
  onFamilies: (families: string[]) => void,
  options: FontWatchOptions = {},
): FontWatch {
  const delayMs = options.delayMs ?? FONT_WATCH_DELAY_MS;
  let stale = false;
  let last: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const deliver = (families: string[]): void => {
    if (stale) return;
    const fp = fingerprint(families);
    if (fp === last) return;
    last = fp;
    onFamilies(families);
  };

  const refresh = (): Promise<void> => {
    inFlight = host.document
      .collection<FontSummaryLike>("fonts")
      .then(
        (rows) =>
          deliver(
            rows
              .map((r) => (typeof r.family === "string" ? r.family : ""))
              .filter((f) => f.length > 0),
          ),
        () => deliver([]),
      );
    return inFlight;
  };

  const cancelTimer = (): boolean => {
    if (timer === null) return false;
    clearTimeout(timer);
    timer = null;
    return true;
  };

  void refresh();
  const sub = host.document.onDidChange(() => {
    if (stale) return;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, delayMs);
  });

  return {
    flush: () => (cancelTimer() && !stale ? refresh() : inFlight),
    dispose: () => {
      stale = true;
      cancelTimer();
      sub.dispose();
    },
  };
}
