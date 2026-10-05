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

// The CI-able corpus lane. real-html-corpus.spec.ts reads commercial
// templates from the private corpus checkout (opt-in, PAGED_HTML_CORPUS) and
// none of them may be copied into this public repo. The hand-written
// conformance fixtures (packages/web-conformance: Chrome layout, flow and
// InDesign fixtures) are license-clear, so every CI run puts them through
// the same readers: importer, linter, outline, font scan, flow scanners and
// sanitizer. They contain nothing executable, so the sanitizer must leave
// them byte-for-byte; they are valid documents, so the linter must find no
// error.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseFlowFrom, parseFlowInto } from "../src/css-flow";
import { diagnoseHtml } from "../src/diagnose";
import { familiesUsed } from "../src/fonts";
import { sourceFromHtmlFile } from "../src/import-html";
import { tagOutline } from "../src/outline";
import { sanitizeHtml } from "../src/sanitize";

const ROOT = fileURLToPath(new URL("../../web-conformance/", import.meta.url));
const DIRS = ["chrome/fixtures", "chrome/flow-fixtures", "indesign/fixtures"];

const files = DIRS.flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ name: `${d}/${f}`, text: readFileSync(join(ROOT, d, f), "utf8") })),
);

describe("hand-authored corpus (license-clear, runs in CI)", () => {
  it("has the conformance fixtures to read @feat:plugin-web.html-importer", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  it.each(files.map((f) => [f.name, f.text]))("%s: every reader accepts it @feat:plugin-web.html-importer", (_name, text) => {
    const { source } = sourceFromHtmlFile(text);
    expect(source.html.length).toBeGreaterThan(0);
    expect(source.css).toContain("font-family: Inter");
    expect(familiesUsed(source.css)).toContain("Inter");
    expect(tagOutline(text).length).toBeGreaterThan(0);
    expect(parseFlowInto(source.css)).toEqual([]);
    expect(parseFlowFrom(source.css)).toEqual([]);
    expect(diagnoseHtml(source.html).filter((d) => d.severity === "error")).toEqual([]);
    expect(sanitizeHtml(text)).toEqual({ html: text, removed: [] });
  });
});
