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

import { diagnoseHtml } from "../src/diagnose";
import {
  WEB_TEMPLATES,
  sourceFromTemplate,
  templateById,
  type WebTemplate,
} from "../src/templates";
import { DEFAULT_SOURCE } from "../src/source";

describe("WEB_TEMPLATES — the vetted set", () => {
  it("ships at least the four expected starters, Empty first", () => {
    const ids = WEB_TEMPLATES.map((t) => t.id);
    expect(ids[0]).toBe("empty");
    expect(ids).toEqual(
      expect.arrayContaining(["empty", "title-block", "card", "two-column"]),
    );
  });

  it("has unique ids and non-empty labels/descriptions", () => {
    const ids = WEB_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of WEB_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  // The vetting GATE — every template's HTML passes the policy linter
  // with no ERROR. (Empty is allowed its "empty web frame" info.)
  it.each(WEB_TEMPLATES.map((t) => [t.id, t] as [string, WebTemplate]))(
    "template %s passes diagnoseHtml with no errors",
    (_id, t) => {
      const errors = diagnoseHtml(t.html).filter((d) => d.severity === "error");
      expect(errors).toEqual([]);
    },
  );

  it("non-empty templates are also balanced (no warnings either)", () => {
    for (const t of WEB_TEMPLATES.filter((x) => x.id !== "empty")) {
      const diags = diagnoseHtml(t.html);
      expect(diags, `template ${t.id} produced ${JSON.stringify(diags)}`).toEqual(
        [],
      );
    }
  });

  it("carries no <script>, event handler, or javascript: URL", () => {
    for (const t of WEB_TEMPLATES) {
      const both = `${t.html}\n${t.css}`;
      expect(both).not.toMatch(/<\s*script/i);
      expect(both).not.toMatch(/\son[a-z]+\s*=/i);
      expect(both).not.toMatch(/javascript:/i);
    }
  });

  it("references no network URL (offline / dependency-free)", () => {
    for (const t of WEB_TEMPLATES) {
      const both = `${t.html}\n${t.css}`;
      expect(both, `template ${t.id} pulls a remote URL`).not.toMatch(
        /https?:\/\//i,
      );
      expect(both).not.toMatch(/@import/i);
      expect(both).not.toMatch(/url\(\s*['"]?https?:/i);
    }
  });
});

describe("templateById", () => {
  it("finds a template by id", () => {
    expect(templateById("card")?.label).toBe("Card");
  });
  it("returns undefined for an unknown id", () => {
    expect(templateById("nope")).toBeUndefined();
  });
});

describe("sourceFromTemplate", () => {
  it("seeds html/css from the template over the caller's options", () => {
    const card = templateById("card")!;
    const opts = { media: "screen", overflow: "clip", viewportWidth: 480 } as const;
    const src = sourceFromTemplate(card, opts);
    expect(src.html).toBe(card.html);
    expect(src.css).toBe(card.css);
    expect(src.options).toEqual(opts);
    // Options are COPIED, not aliased (seeding must not mutate the input).
    expect(src.options).not.toBe(opts);
    // A seeded frame starts with the §6.2 pass disabled.
    expect(src.vars).toBeUndefined();
  });

  it("the Empty template seeds a genuinely blank source", () => {
    const empty = templateById("empty")!;
    const src = sourceFromTemplate(empty, DEFAULT_SOURCE.options);
    expect(src.html).toBe("");
    expect(src.css).toBe("");
  });
});
