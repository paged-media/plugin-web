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

// Property tests (fast-check) for the claims sanitize.ts, transform.ts and
// source.ts make in prose: the sanitizer is total, idempotent and leaves no
// executable surface; the template pass substitutes exactly and leaves what
// it cannot resolve verbatim; a source survives its envelope.
//
// Inputs are built from fragments that matter to the scanners (tag
// openers, `on…=` attributes, `javascript:` spellings, braces) mixed with
// arbitrary strings, so the generators reach the interesting states in a
// few hundred runs instead of hoping a random string spells `<script`.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "../src/sanitize";
import { envelopeFor, sourceFromEnvelope, type WebFrameSource } from "../src/source";
import { applyTemplate, TEMPLATE_FILTERS } from "../src/transform";

const RUNS = { numRuns: 400, seed: 20261005 };

const HTML_PIECES = [
  "<script>", "</script>", "<SCRIPT src=x>", "< script >", "</ script >", "<script",
  "<scr", "ipt>", "<p>", "</p>", "<a href=\"", "<a href='", "<img ", " src=", "\"", "'", ">", "<", "=",
  " onclick=\"go()\"", " onload='x'", " onerror=y", " ON", "on", "click", "mouseover=",
  "javascript:", "JavaScript:", "java\tscript:", "&#106;avascript:", " href=javascript:alert(1)",
  " ", "\n", "x", "<!--", "-->", "<style>", "</style>",
];

const htmlish = fc
  .array(fc.oneof(fc.constantFrom(...HTML_PIECES), fc.string({ maxLength: 6 })), { maxLength: 24 })
  .map((parts) => parts.join(""));

/** Executable surface as the sanitizer defines it. A script tag counts
 *  when it is terminated by `>`; the unterminated tail is DEFECT S-01. */
const SCRIPT_TAG = /<\s*\/?\s*script\b[^>]*>/i;
/** A handler with a value (an empty `onx=` is DEFECT S-03). */
const EVENT_ATTR = /\son[a-z]+\s*=\s*(?:"|'|[^\s>])/i;
const JS_URL = /\s[a-z][a-z0-9-]*\s*=\s*["']?\s*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i;

describe("sanitizeHtml properties", () => {
  it("is total: never throws, always returns a string @feat:plugin-web.source-model", () => {
    fc.assert(
      fc.property(fc.oneof(htmlish, fc.string()), (s) => {
        const r = sanitizeHtml(s);
        expect(typeof r.html).toBe("string");
      }),
      RUNS,
    );
  });

  it("is idempotent on fragments whose removals splice nothing together @feat:plugin-web.source-model", () => {
    fc.assert(
      fc.property(htmlish, (s) => {
        const once = sanitizeHtml(s);
        // A removal that joins its neighbours into a new match is S-02.
        fc.pre((s.match(/scr|\son|j\s*a\s*v\s*a/gi) ?? []).length <= 1);
        const twice = sanitizeHtml(once.html);
        expect(twice.html).toBe(once.html);
        expect(twice.removed).toEqual([]);
      }),
      RUNS,
    );
  });

  it("leaves input without executable surface byte-for-byte @feat:plugin-web.source-model", () => {
    fc.assert(
      fc.property(htmlish, (s) => {
        fc.pre(!SCRIPT_TAG.test(s) && !EVENT_ATTR.test(s) && !JS_URL.test(s));
        expect(sanitizeHtml(s)).toEqual({ html: s, removed: [] });
      }),
      RUNS,
    );
  });

  it("never emits a <script> tag, an on…= handler or a javascript: URL @feat:plugin-web.source-model", () => {
    // Checked on CLOSED input: whatever quote or tag the fragment leaves
    // open is closed by the terminator. Open-ended input is DEFECT S-01.
    fc.assert(
      fc.property(htmlish, fc.constantFrom("", "'\">", "\"'>"), (s, term) => {
        const out = sanitizeHtml(s + term).html;
        // Outputs that are not a fixed point are DEFECT S-02.
        fc.pre(sanitizeHtml(out).html === out);
        const even = (t: string, q: string) => t.split(q).length % 2 === 1;
        fc.pre(!/<[^>]*$/.test(out));
        fc.pre((out.match(/<[^>]*>/g) ?? []).every((t) => even(t, "'") && even(t, '"')));
        expect(out).not.toMatch(SCRIPT_TAG);
        // Attributes live inside tags; text like "onclick=" is just text.
        for (const tag of out.match(/<[^>]*>/g) ?? []) {
          expect(tag).not.toMatch(EVENT_ATTR);
          expect(tag).not.toMatch(JS_URL);
        }
      }),
      RUNS,
    );
  });
});

describe("sanitizeHtml pinned defects", () => {
  // DEFECT S-02: removing one construct can splice its neighbours into a
  // new one — a single pass is not a fixed point.
  // `<scr<script>ipt>alert(1)</scr<script>ipt>` becomes `<script>alert(1)`;
  // `<a ON onclick="x"A=y>` becomes `<a ONA=y>`, a new handler;
  // ` href=javascript:a() javascript:` becomes ` href= javascript:`.
  // Found by the property hunt (fast-check, 5000 unseeded runs).
  it.fails("DEFECT S-02: a removal splices its neighbours into a new <script> tag @feat:plugin-web.source-model", () => {
    expect(sanitizeHtml("<scr<script>ipt>alert(1)</scr<script>ipt>").html).not.toMatch(SCRIPT_TAG);
  });
  it.fails("DEFECT S-02: a removal splices its neighbours into a new javascript: URL @feat:plugin-web.source-model", () => {
    const out = sanitizeHtml("<a href=javascript:alert(1) javascript:x>").html;
    expect(out).toBe(sanitizeHtml(out).html);
  });
  it.fails("DEFECT S-02: a removal splices its neighbours into a new event handler @feat:plugin-web.source-model", () => {
    const out = sanitizeHtml('<a ON onclick="go()"A=x>link</a>').html;
    expect(out).toBe(sanitizeHtml(out).html);
  });
  // DEFECT S-03: an event handler with an EMPTY unquoted value (`<img
  // onerror=>`) is kept — the pattern needs at least one value character.
  // Inert today (an empty handler runs nothing), but not removed.
  it.fails("DEFECT S-03: an empty on…= handler is not removed @feat:plugin-web.source-model", () => {
    expect(sanitizeHtml("<img onerror=>").html).not.toMatch(/\sonerror\s*=/i);
  });

  // DEFECT S-01: an unterminated tag at the very end of the input keeps
  // its executable surface: a trailing `<script` and a trailing
  // `<a href='javascript:` both survive. SCRIPT_OPEN needs the closing `>`, so the tag is left for
  // whatever follows it in the composed document to complete:
  // composeSrcdoc appends `</body></html>`, and `<script </body>` parses as
  // a script START tag (attributes `<` and `body`). It cannot run today
  // (the element is unclosed at EOF and the preview is sandbox=""), but it
  // breaks the documented "never reaches the source" property. Flip to
  // `it` when the scanner strips a trailing open `<script`.
  it.fails("DEFECT S-01: a trailing unterminated <script survives sanitizing @feat:plugin-web.source-model", () => {
    for (const s of ["<script", "<p>x</p><script ", "<SCRIPT src=https://example.invalid/x.js "]) {
      expect(sanitizeHtml(s).html).not.toMatch(/<\s*script\b/i);
    }
  });
  it.fails("DEFECT S-01: an unclosed javascript: attribute survives, and what follows the paste can close it @feat:plugin-web.source-model", () => {
    // Sanitized alone the quote is open, so the pattern (which needs the
    // closing quote) misses it; pasted ahead of existing source that
    // contains a `'`, the link becomes a closed javascript: href.
    const pasted = sanitizeHtml("<a href='javascript:alert(1)>Click").html;
    expect(pasted).not.toMatch(/javascript:/i);
  });
});

const NAME = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/);
/** Text with no template braces at all. */
const PLAIN = fc.string({ maxLength: 30 }).map((s) => s.replace(/[{}]/g, ""));

describe("template pass properties", () => {
  it("text without placeholders passes through with no diagnostics @feat:plugin-web.source-model", () => {
    fc.assert(
      fc.property(PLAIN, fc.dictionary(NAME, PLAIN), (text, vars) => {
        expect(applyTemplate(text, vars)).toEqual({ output: text, diagnostics: [] });
      }),
      RUNS,
    );
  });

  it("{{name}} is replaced by exactly the value, the rest kept @feat:plugin-web.source-model", () => {
    fc.assert(
      fc.property(PLAIN, NAME, PLAIN, PLAIN, (pre, name, value, post) => {
        const r = applyTemplate(`${pre}{{${name}}}${post}`, { [name]: value });
        expect(r.output).toBe(pre + value + post);
        expect(r.diagnostics).toEqual([]);
      }),
      RUNS,
    );
  });

  it("an unknown variable stays verbatim and is diagnosed once @feat:plugin-web.source-model", () => {
    fc.assert(
      fc.property(PLAIN, NAME, PLAIN, (pre, name, post) => {
        const text = `${pre}{{${name}}}${post}`;
        const r = applyTemplate(text, {});
        expect(r.output).toBe(text);
        expect(r.diagnostics).toHaveLength(1);
      }),
      RUNS,
    );
  });

  it("filters are deterministic and upper/lower round-trip on ASCII letters @feat:plugin-web.source-model", () => {
    expect(TEMPLATE_FILTERS).toContain("upper");
    fc.assert(
      fc.property(NAME, fc.stringMatching(/^[a-z]{0,12}$/), (name, value) => {
        const up = applyTemplate(`{{${name} | upper}}`, { [name]: value }).output;
        expect(up).toBe(value.toUpperCase());
        expect(applyTemplate(`{{${name} | lower}}`, { [name]: up }).output).toBe(value);
        expect(applyTemplate(`{{${name} | upper}}`, { [name]: value }).output).toBe(up);
      }),
      RUNS,
    );
  });
});

const SOURCE: fc.Arbitrary<WebFrameSource> = fc
  .record({
    html: fc.string({ maxLength: 40 }),
    css: fc.string({ maxLength: 40 }),
    media: fc.constantFrom("print" as const, "screen" as const),
    viewportWidth: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }),
    vars: fc.option(fc.dictionary(NAME, fc.string({ maxLength: 12 })), { nil: undefined }),
  })
  .map(({ html, css, media, viewportWidth, vars }) => {
    const s: WebFrameSource = { html, css, options: { media, overflow: "clip" } };
    if (viewportWidth !== undefined) s.options.viewportWidth = viewportWidth;
    if (vars !== undefined) s.vars = vars;
    return s;
  });

describe("source envelope round-trip", () => {
  it("sourceFromEnvelope(envelopeFor(s)) deep-equals s, also through JSON @feat:plugin-web.metadata-persistence", () => {
    fc.assert(
      fc.property(SOURCE, (s) => {
        expect(sourceFromEnvelope(envelopeFor(s))).toEqual(s);
        expect(sourceFromEnvelope(JSON.parse(JSON.stringify(envelopeFor(s))))).toEqual(s);
      }),
      RUNS,
    );
  });
});
