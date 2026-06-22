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

import { sanitizeHtml } from "../src/sanitize";
import { diagnoseHtml } from "../src/diagnose";
import { DEFAULT_SOURCE } from "../src/source";

describe("sanitizeHtml — script removal", () => {
  it("strips a <script>…</script> block, body and all", () => {
    const r = sanitizeHtml('<p>ok</p><script>alert(1)</script><p>after</p>');
    expect(r.html).toBe("<p>ok</p><p>after</p>");
    expect(r.removed).toContain("<script> element");
  });

  it("strips multiple script blocks", () => {
    const r = sanitizeHtml('<script>a()</script><div>x</div><script>b()</script>');
    expect(r.html).toBe("<div>x</div>");
    // One removal class, even across several blocks.
    expect(r.removed).toEqual(["<script> element"]);
  });

  it("strips a script with attributes and whitespace in the tag", () => {
    const r = sanitizeHtml('<p>x</p>< script type="text/javascript" >evil()</ script >');
    expect(r.html).toBe("<p>x</p>");
    expect(r.removed).toContain("<script> element");
  });

  it("strips an orphan/unterminated <script>", () => {
    const r = sanitizeHtml("<p>x</p><script>oops");
    expect(r.html).toBe("<p>x</p>oops");
    expect(r.removed).toContain("<script> element");
  });

  it("is idempotent — sanitizing the output again is a no-op", () => {
    const once = sanitizeHtml('<script>a()</script><b onclick="x()">y</b>');
    const twice = sanitizeHtml(once.html);
    expect(twice.html).toBe(once.html);
    expect(twice.removed).toEqual([]);
  });
});

describe("sanitizeHtml — event-handler attributes", () => {
  it("strips an onclick handler, keeping the rest of the tag", () => {
    const r = sanitizeHtml('<button onclick="doEvil()" class="b">Go</button>');
    expect(r.html).toBe('<button class="b">Go</button>');
    expect(r.removed).toContain("event-handler attribute");
  });

  it("strips handlers with single-quoted and bare values", () => {
    const r = sanitizeHtml("<img src=\"a.png\" onerror='boom()' onload=run>");
    expect(r.html).toBe('<img src="a.png">');
    expect(r.removed).toContain("event-handler attribute");
  });

  it("keeps a prefixed attribute (data-online) where 'on' is not the name start", () => {
    // The handler grammar is `on<name>=` at an attribute boundary, so a
    // `data-online` attribute (the `on` is mid-name) is untouched.
    const r = sanitizeHtml('<div data-online="yes" class="c">x</div>');
    expect(r.html).toBe('<div data-online="yes" class="c">x</div>');
    expect(r.removed).toEqual([]);
  });

  it("conservatively strips ANY on*= attribute (matches the linter's scan)", () => {
    // Like `diagnoseHtml`'s `\son[a-z]+=` scan, a bare `on<word>=` at an
    // attribute boundary is treated as a handler and removed — the safe
    // security posture (the browser would run it if it WERE a handler).
    const r = sanitizeHtml('<div onmouseover="evil()">x</div>');
    expect(r.html).toBe("<div>x</div>");
    expect(r.removed).toContain("event-handler attribute");
  });
});

describe("sanitizeHtml — javascript: URLs", () => {
  it("neutralizes a javascript: href to an empty value", () => {
    const r = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(r.html).toBe('<a href="">click</a>');
    expect(r.removed).toContain("javascript: URL");
  });

  it("neutralizes a javascript: src", () => {
    const r = sanitizeHtml("<iframe src='javascript:evil()'></iframe>");
    expect(r.html).toBe("<iframe src=''></iframe>");
    expect(r.removed).toContain("javascript: URL");
  });

  it("leaves a normal http/relative URL untouched", () => {
    const r = sanitizeHtml('<a href="https://paged.media">p</a><img src="a.png">');
    expect(r.html).toBe('<a href="https://paged.media">p</a><img src="a.png">');
    expect(r.removed).toEqual([]);
  });
});

describe("sanitizeHtml — well-formed passthrough + totality", () => {
  it("returns clean HTML byte-for-byte with empty removed", () => {
    const html =
      '<div class="a"><h1>Title</h1><p>Body <b>copy</b>.</p><img src="i.png"></div>';
    const r = sanitizeHtml(html);
    expect(r.html).toBe(html);
    expect(r.removed).toEqual([]);
  });

  it("passes the default source through unchanged", () => {
    const r = sanitizeHtml(DEFAULT_SOURCE.html);
    expect(r.html).toBe(DEFAULT_SOURCE.html);
    expect(r.removed).toEqual([]);
  });

  it("empty / non-string input never throws", () => {
    expect(sanitizeHtml("")).toEqual({ html: "", removed: [] });
    expect(sanitizeHtml(undefined as unknown as string)).toEqual({
      html: "",
      removed: [],
    });
  });

  it("reports every distinct class when several are present", () => {
    const r = sanitizeHtml(
      '<script>a()</script><a href="javascript:x()" onclick="y()">go</a>',
    );
    expect(r.removed).toContain("<script> element");
    expect(r.removed).toContain("event-handler attribute");
    expect(r.removed).toContain("javascript: URL");
    // Deduplicated, first-seen order (script → handler → URL pass order).
    expect(r.removed).toEqual([
      "<script> element",
      "event-handler attribute",
      "javascript: URL",
    ]);
  });

  it("the sanitized output is clean per the policy linter", () => {
    const r = sanitizeHtml(
      '<div><script>a()</script><button onclick="x()">b</button></div>',
    );
    // No ERROR-severity diagnostic survives (the <script> policy error is
    // gone because the element is gone).
    expect(diagnoseHtml(r.html).filter((d) => d.severity === "error")).toEqual(
      [],
    );
  });
});
