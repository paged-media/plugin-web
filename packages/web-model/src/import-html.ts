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

// `.html` FILE intake → a WebFrameSource. A SCANNER, not a parser (the
// linter's stance — it must never crash on bad input): `<style>` bodies
// are collected into the source's css lane and excised from the html;
// when a `<body>` exists its inner content becomes the html (the
// document shell around it — doctype/head — is meaningless inside a
// frame). The result then rides the normal sanitize pass (script/
// handler/javascript: removal) in the caller.

import { sanitizeHtml, type SanitizeResult } from "./sanitize";
import { DEFAULT_SOURCE, type WebFrameSource } from "./source";

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const BODY_INNER = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;

export interface HtmlFileImport {
  source: WebFrameSource;
  /** What the sanitize pass removed (script blocks, handlers, js: URLs). */
  removed: SanitizeResult["removed"];
}

/** Split a whole `.html` FILE into the panel's two lanes and sanitize.
 *  Total on any input: no `<style>`/`<body>` → css stays empty and the
 *  full (sanitized) text is the html. */
export function sourceFromHtmlFile(text: string): HtmlFileImport {
  const css: string[] = [];
  const withoutStyles = text.replace(STYLE_BLOCK, (_, body: string) => {
    if (body.trim().length > 0) css.push(body.trim());
    return "";
  });
  const bodyMatch = BODY_INNER.exec(withoutStyles);
  const rawHtml = (bodyMatch ? bodyMatch[1] : withoutStyles).trim();
  const { html, removed } = sanitizeHtml(rawHtml);
  return {
    source: { html, css: css.join("\n\n"), options: { ...DEFAULT_SOURCE.options } },
    removed,
  };
}
