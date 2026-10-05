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

// The document the engine lays out for a source: the §6.2 template pass
// (`renderWebFrameSource`), then html + css composed into one document
// (`composeSrcdoc`, exactly as the preview composes). Every render and bake
// command goes through here.
//
// Memoized per source CONTENT, and only where it pays: a source without
// `vars` is a byte-identical passthrough whose composition costs less than
// hashing it would, so it is never cached; with `vars`, the template pass is
// the cost (measured ~7 ms for a 45 KB source, against ~0.1 ms for the
// key), and a re-render or bake of an unchanged source reuses the result.

import {
  composeSrcdoc,
  contentHash,
  renderWebFrameSource,
  type TemplateVars,
  type WebDiagnostic,
  type WebFrameSource,
} from "../../web-model/src";

/** What the engine renders for a source. */
export interface EngineDocument {
  /** The composed document (template pass applied). */
  html: string;
  /** The template-applied css (the flow-root / named-flow parsers read it). */
  css: string;
  /** The template pass's diagnostics. */
  diagnostics: WebDiagnostic[];
}

/** How many composed documents are kept (one per recently rendered source). */
const CACHE_SIZE = 8;
const cache = new Map<string, EngineDocument>();

/** Template passes actually run with `vars` (cache misses) — for tests. */
export const engineDocumentStats = { templatePasses: 0 };

const copy = (d: EngineDocument): EngineDocument => ({
  html: d.html,
  css: d.css,
  diagnostics: d.diagnostics.map((x) => ({ ...x })),
});

function compose(source: WebFrameSource, bound?: TemplateVars): EngineDocument {
  const rendered = renderWebFrameSource(source, bound);
  return {
    html: composeSrcdoc({ ...source, html: rendered.html, css: rendered.css }),
    css: rendered.css,
    diagnostics: rendered.diagnostics,
  };
}

/** The engine document for `source` (see the module note); `bound` are the
 *  values of its bound names (bindings.ts), when it uses any. */
export function engineDocument(source: WebFrameSource, bound?: TemplateVars): EngineDocument {
  const hasBound = !!bound && Object.keys(bound).length > 0;
  if (source.vars === undefined && !hasBound) return compose(source);
  const key = contentHash(
    JSON.stringify([source.html, source.css, source.vars, source.options, hasBound ? bound : null]),
  );
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return copy(hit);
  }
  engineDocumentStats.templatePasses += 1;
  const doc = compose(source, bound);
  cache.set(key, doc);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return copy(doc);
}
