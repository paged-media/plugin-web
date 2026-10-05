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

// The engine document (template pass + composition) is memoized per source
// content when the source has `vars`, and the cached result is what a fresh
// composition would give.

import { describe, expect, it } from "vitest";

import {
  composeSrcdoc,
  DEFAULT_SOURCE,
  renderWebFrameSource,
  type WebFrameSource,
} from "@paged-media/web-model";

import { engineDocument, engineDocumentStats } from "../src/engine-document";

const withVars: WebFrameSource = {
  ...DEFAULT_SOURCE,
  html: "<h1>{{title}}</h1><p>{{missing}}</p>",
  css: "h1{color:red}",
  vars: { title: "Hello" },
};

const fresh = (s: WebFrameSource) => {
  const r = renderWebFrameSource(s);
  return { html: composeSrcdoc({ ...s, html: r.html, css: r.css }), css: r.css, diagnostics: r.diagnostics };
};

describe("engineDocument [plugin-web.engine-rendering]", () => {
  it("runs the template pass once per source content, and answers what a fresh pass would", () => {
    const before = engineDocumentStats.templatePasses;
    const a = engineDocument({ ...withVars });
    const b = engineDocument({ ...withVars, vars: { title: "Hello" } });
    expect(engineDocumentStats.templatePasses - before).toBe(1);
    expect(a).toEqual(fresh(withVars));
    expect(b).toEqual(a);
    expect(a.html).toContain("<h1>Hello</h1>");

    // A different source content is a different entry.
    engineDocument({ ...withVars, vars: { title: "Other" } });
    expect(engineDocumentStats.templatePasses - before).toBe(2);
  });

  it("a caller mutating its result does not change the next caller's", () => {
    const a = engineDocument(withVars);
    a.diagnostics.length = 0;
    a.html = "";
    expect(engineDocument(withVars)).toEqual(fresh(withVars));
  });

  it("a source without vars is composed directly (never cached)", () => {
    const before = engineDocumentStats.templatePasses;
    expect(engineDocument(DEFAULT_SOURCE)).toEqual(fresh(DEFAULT_SOURCE));
    expect(engineDocumentStats.templatePasses).toBe(before);
  });
});
