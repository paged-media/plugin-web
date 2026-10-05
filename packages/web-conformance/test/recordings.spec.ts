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

// The Chrome recordings are only an oracle while they describe the fixture
// bytes in the repo. A fixture edited without re-running the recorder would
// make the Rust replay compare Blitz against a different document, so this
// fails when any recording's source hash no longer matches its fixture.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHROME = fileURLToPath(new URL("../chrome/", import.meta.url));
const WIDTHS = [240, 400];

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const htmlIn = (dir: string) =>
  readdirSync(join(CHROME, dir))
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.slice(0, -5))
    .sort();

describe("chrome recordings are fresh", () => {
  const fixtures = htmlIn("fixtures");

  it("there are at least 30 layout fixtures across the families", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    const families = new Set(fixtures.map((f) => f.split("-")[0]));
    for (const fam of ["blocks", "inline", "text", "lists", "table", "flex", "grid", "floats", "positioned", "multicol", "pseudo", "paint"]) {
      expect(families, fam).toContain(fam);
    }
  });

  it.each(fixtures)("%s: recorded at every width from the current bytes", (name) => {
    const hash = sha(join(CHROME, "fixtures", `${name}.html`));
    for (const w of WIDTHS) {
      const json = join(CHROME, "recorded", `${name}@${w}.json`);
      expect(existsSync(json), `${name}@${w}.json`).toBe(true);
      expect(existsSync(join(CHROME, "recorded", `${name}@${w}.png`)), `${name}@${w}.png`).toBe(true);
      const rec = JSON.parse(readFileSync(json, "utf8"));
      expect(rec.sourceSha256, `${name} changed after recording — run chrome/record.mjs`).toBe(hash);
      expect(rec.width).toBe(w);
      expect(rec.elements.length).toBeGreaterThan(0);
    }
  });

  it.each(htmlIn("flow-fixtures"))("flow %s: recorded from the current bytes", (name) => {
    const rec = JSON.parse(readFileSync(join(CHROME, "recorded-flow", `${name}.json`), "utf8"));
    expect(rec.sourceSha256).toBe(sha(join(CHROME, "flow-fixtures", `${name}.html`)));
    expect(rec.frameText.length).toBe(rec.frames.length);
  });

  it("no recording is left without its fixture", () => {
    const names = new Set(fixtures);
    for (const f of readdirSync(join(CHROME, "recorded"))) {
      expect(names.has(f.replace(/@\d+\.(json|png)$/, "")), f).toBe(true);
    }
  });
});
