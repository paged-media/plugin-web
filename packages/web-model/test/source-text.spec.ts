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
import fc from "fast-check";

import { editTextNode, scanTextNodes } from "../src/source-text";

describe("scanTextNodes @feat:plugin-web.in-frame-edit", () => {
  it("numbers the non-white-space text nodes in document order", () => {
    const nodes = scanTextNodes("<h1>Title</h1>\n  <p>Hello <b>bold</b>  world</p><!-- c -->x");
    expect(nodes.map((n) => n.text)).toEqual(["Title", "Hello ", "bold", "  world", "x"]);
    expect(nodes.map((n) => n.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it("decodes references and CRLF, and maps back to the raw source", () => {
    const html = "<p>Fish &amp; chips&nbsp;&#x41;\r\nend</p>";
    const [n] = scanTextNodes(html);
    expect(n.text).toBe("Fish & chips A\nend");
    expect(html.slice(n.start, n.end)).toBe("Fish &amp; chips&nbsp;&#x41;\r\nend");
  });

  it("skips raw-text and form content, comments and doctype-like markup", () => {
    const nodes = scanTextNodes(
      "<style>p{}</style><script>x<y</script><textarea>t</textarea><!doctype x><p>a < b</p>",
    );
    expect(nodes.map((n) => n.text)).toEqual(["a < b"]);
  });

  it("drops the newline right after <pre> as the parser does", () => {
    const [n] = scanTextNodes("<pre>\ncode</pre>");
    expect(n.text).toBe("code");
  });

  it("never throws on broken input", () => {
    for (const s of ["<", "<p", "<!--", "&", "&#;", "<p a='>", "</", "<script>"]) {
      expect(() => scanTextNodes(s)).not.toThrow();
    }
  });
});

describe("editTextNode @feat:plugin-web.in-frame-edit", () => {
  it("replaces only the changed middle, keeping markup and untouched entities", () => {
    const html = '<p class="a">Fish &amp; chips &mdash; <b>hot</b></p>';
    const [n] = scanTextNodes(html);
    const out = editTextNode(html, n, "Fish & fries — ");
    expect(out).toBe('<p class="a">Fish &amp; fries &mdash; <b>hot</b></p>');
  });

  it("escapes what the user types", () => {
    const html = "<p>a</p>";
    const [n] = scanTextNodes(html);
    expect(editTextNode(html, n, "a<b>&")).toBe("<p>a&lt;b&gt;&amp;</p>");
  });

  it("never splits a character reference", () => {
    const html = "<p>x&amp;y</p>";
    const [n] = scanTextNodes(html);
    expect(editTextNode(html, n, "x&&y")).toBe("<p>x&amp;&amp;y</p>");
  });

  it("round-trips: the edited source scans to the new text, other nodes unchanged", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (a, typed) => {
        const html = `<h1>Head &amp; more</h1><p>${a.replace(/[<&>\r]/g, "")}x</p><p>tail</p>`;
        const nodes = scanTextNodes(html);
        const target = nodes[1];
        const next = typed.replace(/\r/g, "") + "y";
        const out = editTextNode(html, target, next);
        const after = scanTextNodes(out);
        expect(after[1].text).toBe(next);
        expect(after[0].text).toBe("Head & more");
        expect(after[after.length - 1].text).toBe("tail");
      }),
    );
  });
});
