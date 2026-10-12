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
    for (const text of ["<!--", "<!-- <style>", "<body><!--", "<script>", "<style", "<body", "<", "<a b='>"]) {
      expect(() => sourceFromHtmlFile(text)).not.toThrow();
    }
  });

  // A comment is not markup: a `<style>` or `<body>` it names is text. The
  // spring mailer the web film opens said, in its head comment, that the
  // importer "takes the <style> block as the frame's CSS"; the CSS then began
  // inside that comment and ran over the head into the real rule.
  it("reads no <style> or <body> out of an HTML comment", () => {
    const { source } = sourceFromHtmlFile(
      `<!doctype html>
<!-- One file: paged.web takes the <style> block as the frame's CSS
     and the <body> as its HTML. -->
<html lang="en"><head><title>Mailer</title>
<style>.mailer { color: #241c12; }</style>
</head>
<body><div class="mailer"><p>Hi</p></div></body></html>`,
    );
    expect(source.css).toBe(".mailer { color: #241c12; }");
    expect(source.html).toBe(`<div class="mailer"><p>Hi</p></div>`);
  });

  it("keeps a comment inside the body as html, and the style it names out of the css", () => {
    const { source } = sourceFromHtmlFile(
      `<head><style>p{margin:0}</style></head><body><!-- not css: <style>h1{color:red}</style> --><p>a</p></body>`,
    );
    expect(source.css).toBe("p{margin:0}");
    expect(source.html).toBe(`<!-- not css: <style>h1{color:red}</style> --><p>a</p>`);
  });

  it("reads no tags out of raw-text elements (a title, a script's strings)", () => {
    const { source } = sourceFromHtmlFile(
      `<head><title>The <style> and <body> tags</title><style>p{margin:0}</style></head>` +
        `<body><script>var s = "<style>h1{color:red}</style>";</script><p>a</p></body>`,
    );
    expect(source.css).toBe("p{margin:0}");
    expect(source.html).toBe("<p>a</p>");
  });

  it("keeps a style block's legacy comment wrapper as css (CDO/CDC are css tokens)", () => {
    const { source } = sourceFromHtmlFile(`<style><!-- p { color: red; } --></style><body><p>a</p></body>`);
    expect(source.css).toBe("<!-- p { color: red; } -->");
    expect(source.html).toBe("<p>a</p>");
  });

  it("takes the body to the end of the file when </body> is missing", () => {
    const { source } = sourceFromHtmlFile(`<html><head><style>p{margin:0}</style></head><body><p>a</p></html>`);
    expect(source.css).toBe("p{margin:0}");
    expect(source.html).toBe("<p>a</p>");
  });
});
