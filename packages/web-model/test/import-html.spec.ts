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

import { describe, expect, it } from "vitest";

import { sourceFromHtmlFile } from "../src/import-html";

describe("sourceFromHtmlFile", () => {
  it("splits <style> blocks into the css lane and takes the <body> inner", () => {
    const { source, removed } = sourceFromHtmlFile(
      `<!doctype html><html><head><title>x</title>
       <style>p { color: red; }</style>
       <style> h1 { margin: 0; } </style></head>
       <body><h1>Hi</h1><p>Text</p></body></html>`,
    );
    expect(source.css).toBe("p { color: red; }\n\nh1 { margin: 0; }");
    expect(source.html).toBe("<h1>Hi</h1><p>Text</p>");
    expect(removed).toEqual([]);
  });

  it("is total on fragments — no body/style means the whole text is html", () => {
    const { source } = sourceFromHtmlFile("<p>fragment</p>");
    expect(source.html).toBe("<p>fragment</p>");
    expect(source.css).toBe("");
  });

  it("sanitizes on ingest — scripts and handlers never reach the source", () => {
    const { source, removed } = sourceFromHtmlFile(
      `<body><p onclick="evil()">a</p><script>evil()</script></body>`,
    );
    expect(source.html).not.toContain("script");
    expect(source.html).not.toContain("onclick");
    expect(removed.length).toBeGreaterThan(0);
  });

  it("never throws on hostile input (scanner, not parser)", () => {
    expect(() => sourceFromHtmlFile("<style><body><style></p")).not.toThrow();
  });
});
