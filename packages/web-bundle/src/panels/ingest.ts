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

// Paste-HTML INGESTION — the panel-side glue over web-model's
// `sanitizeHtml`. HTML brought in from OUTSIDE the editor (the system
// clipboard via the K-6 door, or a paste into the affordance's box) is
// SANITIZED on the way in: the page-JavaScript-never-executes rule
// (§6.1) is ENFORCED at ingest, not merely diagnosed. The diagnostics
// linter still runs afterward over the sanitized result (the panel
// already lints `draft.html`); this module's job is the strip + a human
// summary of what it cleaned.
//
// Pure and host-light: `ingestHtml` is a thin, testable wrapper; the
// clipboard read is gated behind `host.supports("clipboard@1")` so a
// host with no clipboard backend falls back to the paste box (the
// affordance the panel always offers).

import type { BundleHost } from "@paged-media/plugin-api";
import { sanitizeHtml, type SanitizeRemoval } from "@paged-media/web-model";

export interface IngestResult {
  /** The sanitized HTML to seed into the source. */
  html: string;
  /** Which executable-surface classes were stripped (empty = clean). */
  removed: SanitizeRemoval[];
}

/**
 * Sanitize HTML for ingestion. A thin wrapper over `sanitizeHtml` kept
 * as the panel's single ingest seam (so the affordance and any future
 * drop-target share one path). Pure; never throws.
 */
export function ingestHtml(html: string): IngestResult {
  const { html: clean, removed } = sanitizeHtml(html);
  return { html: clean, removed };
}

/**
 * A short human summary of what an ingest stripped — for the panel's
 * status note. `null` when nothing was removed (the caller shows a
 * "pasted, nothing to clean" affordance instead).
 */
export function describeRemoval(removed: readonly SanitizeRemoval[]): string | null {
  if (removed.length === 0) return null;
  // Pluralize the class labels into a readable clause.
  const parts = removed.map((r) => {
    switch (r) {
      case "<script> element":
        return "script blocks";
      case "event-handler attribute":
        return "inline event handlers";
      case "javascript: URL":
        return "javascript: URLs";
    }
  });
  return `Removed ${parts.join(", ")} on ingest (page JavaScript never runs).`;
}

/** Whether the K-6 system-clipboard door is actually wired. */
export function clipboardAvailable(
  host: Pick<BundleHost, "supports">,
): boolean {
  return host.supports("clipboard@1");
}

/**
 * Read HTML from the system clipboard through the K-6 door, sanitize
 * it, and return the ingest result — or `null` when the clipboard is
 * unavailable / empty / non-text (the caller then uses the paste box).
 * The clipboard surface carries a `text` half (web-model has no HTML
 * MIME reader; the text half is the markup a user copied). Never
 * throws: a denied/empty read resolves to `null`.
 */
export async function ingestFromClipboard(
  host: Pick<BundleHost, "supports" | "clipboard">,
): Promise<IngestResult | null> {
  if (!clipboardAvailable(host)) return null;
  let payload: Awaited<ReturnType<BundleHost["clipboard"]["read"]>> = null;
  try {
    payload = await host.clipboard.read();
  } catch {
    return null;
  }
  const text = payload?.text;
  if (typeof text !== "string" || text.length === 0) return null;
  return ingestHtml(text);
}
