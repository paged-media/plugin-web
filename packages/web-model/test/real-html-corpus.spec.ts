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

/**
 * Real HTML — the first corpus lane plugin-web has ever had.
 *
 * `corpus/html` holds 2,855 files from commercial web templates: 184
 * HTML documents plus the CSS, SCSS, JS, webfonts and imagery they pull
 * in. Until now every fragment this package had parsed or sanitized was
 * a string literal in the spec beside this one — the corpus catalogue
 * said so out loud, listing the lane as "importer exists; its specs use
 * inline strings today".
 *
 * The sanitizer is the reason this matters most. `sanitize.ts` documents
 * three properties — **total** (garbage never throws), **idempotent**
 * (sanitizing the output is a no-op), and complete removal of every
 * executable surface (`<script>` elements, inline `on…=` handlers,
 * `javascript:` URLs). Those are security properties, and they were
 * being verified against inputs we wrote ourselves, which is precisely
 * the population least likely to contain the case we did not think of.
 *
 * Real commercial templates are the opposite: they are dense with
 * inline scripts, analytics snippets, deferred loaders, `onclick`
 * handlers, and markup that has been through minifiers and back. Every
 * assertion below is the property the source file already claims — this
 * lane just stops taking our word for it.
 *
 * OPT-IN — the assets live in the private corpus checkout:
 *
 *     PAGED_HTML_CORPUS=1 pnpm --filter @paged-media/web-model test
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { namedFlowDiagnostics, parseFlowFrom, parseFlowInto, flowThreadOptions } from "../src/css-flow";
import { diagnoseHtml } from "../src/diagnose";
import { familiesUsed } from "../src/fonts";
import { sourceFromHtmlFile } from "../src/import-html";
import { tagOutline } from "../src/outline";
import { sanitizeHtml } from "../src/sanitize";

/** Directories under `corpus/html` that hold pack payloads. */
function corpusRoot(): string | null {
  const sw = process.env.PAGED_HTML_CORPUS;
  if (!sw) return null;
  if (sw === "1") return join(__dirname, "../../../../../corpus");
  return sw;
}

/** Every file under `corpus/html` matching `re`, recursively. */
function filesMatching(re: RegExp): { path: string; text: string }[] {
  const root = corpusRoot();
  if (!root) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (re.test(n)) out.push(p);
    }
  };
  walk(join(root, "html"));
  out.sort();
  return out.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

const files = filesMatching(/\.html?$/i);
// Real stylesheets: minified, vendor-prefixed, thick with @media and
// @supports. `.scss` is deliberately included — it is NOT CSS, so it is
// also the cheapest check that a preprocessor source handed to a CSS
// reader degrades rather than crashes.
const styles = filesMatching(/\.(css|scss)$/i);
// The template JS. These are never PARSED — plugin-web strips script
// rather than running it — so they are here as sanitizer payloads, and
// they are the nastiest ones available: 38 carry a `<script` tag inside
// their own source and 26 carry a literal `</script>`, which is exactly
// what makes script-stripping non-trivial.
//
// `.jsx` is included with `.js` — 100 more files, every one of them
// JavaScript that is dense with markup (`<Header />`, `<div>`), which is
// the shape a script-stripper is most likely to mis-end on. Note what
// they are not: not one of the 100 carries a `<script` tag or a
// `javascript:` URL, so the two counts above are unchanged by them. They
// widen the payload population; they do not add new nasty cases.
const scripts = filesMatching(/\.(js|jsx)$/i);
const gated = files.length > 0;
const short = (p: string) => p.split("/").slice(-2).join("/");

/** The three executable surfaces `sanitize.ts` promises to remove. */
const SCRIPT_TAG = /<\s*\/?\s*script\b/i;
const EVENT_ATTR = /\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i;
const JS_URL = /=\s*(?:"|')?\s*javascript\s*:/i;

describe.skipIf(!gated)("real HTML corpus", () => {
  it("sanitizes every real template without throwing, and leaves nothing executable", () => {
    const threw: string[] = [];
    const leftScript: string[] = [];
    const leftHandler: string[] = [];
    const leftJsUrl: string[] = [];
    let hadSomethingToStrip = 0;

    for (const { path, text } of files) {
      let result;
      try {
        result = sanitizeHtml(text);
      } catch (e) {
        threw.push(`${short(path)}: ${(e as Error).message}`);
        continue;
      }
      if (result.removed.length > 0) hadSomethingToStrip += 1;
      if (SCRIPT_TAG.test(result.html)) leftScript.push(short(path));
      if (EVENT_ATTR.test(result.html)) leftHandler.push(short(path));
      if (JS_URL.test(result.html)) leftJsUrl.push(short(path));
    }

    console.log(
      `real HTML corpus: ${files.length} template(s), ` +
        `${hadSomethingToStrip} carried something to strip`,
    );

    expect(threw, `sanitizeHtml THREW — it is documented total:\n  ${threw.join("\n  ")}`).toEqual(
      [],
    );
    expect(
      leftScript,
      `<script> survived sanitization in ${leftScript.length} real template(s):\n  ` +
        leftScript.join("\n  "),
    ).toEqual([]);
    expect(
      leftHandler,
      `an inline event handler survived sanitization in ${leftHandler.length} ` +
        `real template(s):\n  ${leftHandler.join("\n  ")}`,
    ).toEqual([]);
    expect(
      leftJsUrl,
      `a javascript: URL survived sanitization in ${leftJsUrl.length} real ` +
        `template(s):\n  ${leftJsUrl.join("\n  ")}`,
    ).toEqual([]);

    // If nothing in 184 commercial templates had anything to strip, the
    // sanitizer is not matching what real markup looks like and every
    // assertion above is vacuous.
    expect(
      hadSomethingToStrip,
      `not one of ${files.length} real templates contained a <script>, an event ` +
        `handler or a javascript: URL — commercial web templates are dense with ` +
        `all three, so this means the scan is not matching real markup and the ` +
        `assertions above are passing vacuously`,
    ).toBeGreaterThan(0);
  });

  it("is idempotent on every real template", () => {
    // `sanitize.ts`: "Idempotent — sanitizing the output again is a
    // no-op." A second pass that removes MORE means the first pass left
    // executable surface behind that the second one could see.
    const notIdempotent: string[] = [];
    for (const { path, text } of files) {
      const once = sanitizeHtml(text);
      const twice = sanitizeHtml(once.html);
      if (twice.html !== once.html || twice.removed.length > 0) {
        notIdempotent.push(
          `${short(path)} (second pass removed ${JSON.stringify(twice.removed)})`,
        );
      }
    }
    expect(
      notIdempotent,
      `sanitizeHtml is documented idempotent but a second pass changed ` +
        `${notIdempotent.length} real template(s):\n  ${notIdempotent.join("\n  ")}`,
    ).toEqual([]);
  });

  it("imports, diagnoses and outlines every real template without throwing", () => {
    const threw: string[] = [];
    let withBody = 0;
    let withCss = 0;
    let diagnostics = 0;
    let outlineRows = 0;

    for (const { path, text } of files) {
      try {
        // The two lanes the panel actually gets: `source.html` is the
        // sanitized <body> inner (or the whole file when there is no
        // <body>), `source.css` the concatenated <style> blocks.
        const { source } = sourceFromHtmlFile(text);
        if (source.html.trim().length > 0) withBody += 1;
        if (source.css.trim().length > 0) withCss += 1;
        diagnostics += diagnoseHtml(text).length;
        outlineRows += tagOutline(text).length;
      } catch (e) {
        threw.push(`${short(path)}: ${(e as Error).message}`);
      }
    }

    console.log(
      `  imported ${withBody}/${files.length} with a non-empty body, ` +
        `${withCss} with extracted <style> css, ` +
        `${diagnostics} diagnostic(s), ${outlineRows} outline row(s)`,
    );

    expect(
      threw,
      `these entry points are the importer's front door and must not throw on a ` +
        `file a user can hand them:\n  ${threw.join("\n  ")}`,
    ).toEqual([]);

    // A front door that returns nothing for every real document is not a
    // front door — the same floor the other corpus lanes use.
    expect(
      withBody,
      `not one of ${files.length} real templates produced a non-empty body — ` +
        `the importer has only ever been fed inline spec strings, so this means ` +
        `it cannot read what real templates look like`,
    ).toBeGreaterThan(0);
  });
});

describe.skipIf(styles.length === 0)("real CSS corpus", () => {
  it("reads every real stylesheet without throwing", () => {
    // Every one of these takes raw CSS text and is called on whatever a
    // user pastes into the source panel. Their specs feed them a few
    // hand-written rules; commercial template CSS is tens of thousands
    // of lines, minified, and full of at-rules these were never shown.
    const threw: string[] = [];
    let withFamilies = 0;
    let flowRules = 0;
    let diagnostics = 0;

    for (const { path, text } of styles) {
      try {
        const fams = familiesUsed(text);
        if (fams.length > 0) withFamilies += 1;
        flowRules += parseFlowInto(text).length + parseFlowFrom(text).length;
        flowThreadOptions(text);
        diagnostics += namedFlowDiagnostics(text).length;
      } catch (e) {
        threw.push(`${short(path)}: ${(e as Error).message}`);
      }
    }

    console.log(
      `real CSS corpus: ${styles.length} stylesheet(s), ` +
        `${withFamilies} declared font families, ${flowRules} named-flow rule(s), ` +
        `${diagnostics} diagnostic(s)`,
    );

    expect(
      threw,
      `a CSS reader threw on real stylesheet input:\n  ${threw.join("\n  ")}`,
    ).toEqual([]);

    // `familiesUsed` drives font parity, which drives what the renderer
    // can actually show. Finding none across every commercial template
    // in the corpus would mean it is not matching real `font-family`
    // declarations at all.
    expect(
      withFamilies,
      `not one of ${styles.length} real stylesheets yielded a font family — ` +
        `familiesUsed drives font parity, so this means it cannot read what real ` +
        `stylesheets declare`,
    ).toBeGreaterThan(0);
  });
});

describe.skipIf(scripts.length === 0)("real JavaScript corpus", () => {
  it("leaves no executable surface when a real script payload is embedded", () => {
    // plugin-web never executes or parses JS — `sanitizeHtml` exists to
    // take it out. So the honest way to point the corpus's 245 real
    // template scripts at this package is to put each one where a
    // template author puts it, inside a <script> block, and require
    // that nothing executable survives.
    //
    // These are a much harsher payload than the spec's hand-written
    // one-liners: minified jQuery plugins, bundler output and React
    // sources whose own text contains `<script>` and `</script>`.
    const threw: string[] = [];
    const leftScript: string[] = [];
    const leftHandler: string[] = [];
    const leftJsUrl: string[] = [];

    for (const { path, text } of scripts) {
      const doc = `<div class="wrap"><script>${text}</script><p>after</p></div>`;
      let out;
      try {
        out = sanitizeHtml(doc).html;
      } catch (e) {
        threw.push(`${short(path)}: ${(e as Error).message}`);
        continue;
      }
      if (SCRIPT_TAG.test(out)) leftScript.push(short(path));
      if (EVENT_ATTR.test(out)) leftHandler.push(short(path));
      if (JS_URL.test(out)) leftJsUrl.push(short(path));
    }

    console.log(`real JS corpus: ${scripts.length} script payload(s)`);

    expect(threw, `sanitizeHtml THREW on a real script payload:\n  ${threw.join("\n  ")}`).toEqual(
      [],
    );
    expect(
      leftScript,
      `a <script> tag survived for ${leftScript.length} payload(s):\n  ` +
        leftScript.join("\n  "),
    ).toEqual([]);
    expect(
      leftHandler,
      `an event handler survived for ${leftHandler.length} payload(s):\n  ` +
        leftHandler.join("\n  "),
    ).toEqual([]);
    expect(
      leftJsUrl,
      `a javascript: URL survived for ${leftJsUrl.length} payload(s):\n  ` +
        leftJsUrl.join("\n  "),
    ).toEqual([]);
  });

  it("ends a script element where a browser would, and sanitizes what follows", () => {
    // This pins a behaviour that LOOKS like a bug and is not, so nobody
    // "fixes" it later.
    //
    // 26 of these files contain a literal `</script>` in their own text
    // (React sources that render <script> tags). Embed one and the
    // sanitizer's non-greedy match ends the element at that first
    // `</script>` — leaving the rest of the file behind as MARKUP rather
    // than as script body. That is not a leak: HTML says a script
    // element ends at the first `</script>`, so a browser ends it in
    // exactly the same place. Our stripper and the parser agree.
    //
    // What matters is what happens to the remainder, and this is where
    // the layered passes earn their keep: whatever survives as markup is
    // then run through the handler and `javascript:` passes in its own
    // right. Four of these files carry a `javascript:` URL, so that is a
    // real assertion and not a vacuous one.
    const withCloseTag = scripts.filter(({ text }) => /<\s*\/\s*script\s*>/i.test(text));
    const withJsUrl = scripts.filter(({ text }) => /javascript\s*:/i.test(text));

    expect(
      withCloseTag.length,
      "no corpus script contains a literal </script> — this test is about that " +
        "case, so it would be asserting nothing",
    ).toBeGreaterThan(0);

    const unsafe: string[] = [];
    for (const { path, text } of [...withCloseTag, ...withJsUrl]) {
      const out = sanitizeHtml(`<div><script>${text}</script></div>`).html;
      if (SCRIPT_TAG.test(out) || EVENT_ATTR.test(out) || JS_URL.test(out)) {
        unsafe.push(short(path));
      }
    }

    console.log(
      `  ${withCloseTag.length} payload(s) contain a literal </script>, ` +
        `${withJsUrl.length} contain a javascript: URL — all neutralised`,
    );
    expect(
      unsafe,
      `the remainder left behind after a script element ended early was NOT ` +
        `sanitized for ${unsafe.length} payload(s) — the layered handler and ` +
        `javascript: passes are what must catch this:\n  ${unsafe.join("\n  ")}`,
    ).toEqual([]);
  });

  it("is idempotent on every real script payload", () => {
    const notIdempotent: string[] = [];
    for (const { path, text } of scripts) {
      const once = sanitizeHtml(`<div><script>${text}</script></div>`);
      const twice = sanitizeHtml(once.html);
      if (twice.html !== once.html || twice.removed.length > 0) {
        notIdempotent.push(`${short(path)} (second pass: ${JSON.stringify(twice.removed)})`);
      }
    }
    expect(
      notIdempotent,
      `sanitizeHtml is documented idempotent but a second pass changed ` +
        `${notIdempotent.length} script payload(s):\n  ${notIdempotent.join("\n  ")}`,
    ).toEqual([]);
  });
});
