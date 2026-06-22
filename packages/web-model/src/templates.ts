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

// Starter templates — vetted, offline, dependency-free HTML/CSS seeds
// the insert/source panel offers so a new web frame is never a blank
// box (a poor first run). Clean-room and HAND-AUTHORED: no external CSS
// framework, no webfont, no render-time fetch — the concept forbids any
// network at render time (§4/§9), so a template that pulled in a CDN
// reset would be a lie. A small INLINE reset (box-sizing + margin zero)
// is bundled by hand where a layout needs it.
//
// Every template's HTML is VETTED: it passes `diagnoseHtml` with no
// ERROR-severity findings (balanced tags, no `<script>`, no event
// handlers) — `templates.spec.ts` asserts this for all of them, so a
// future edit that introduces a policy error fails the suite. The CSS
// references only generic font families and IBM Plex Sans (the
// document's default; substitution is honest, not a hidden dependency).

import type { WebFrameSource } from "./source";

export interface WebTemplate {
  /** Stable id (used as the picker option value / persisted choice). */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** One-line description of what the template seeds. */
  description: string;
  /** Seed HTML — the frame's `source.html`. */
  html: string;
  /** Seed CSS — the frame's `source.css`. */
  css: string;
}

const SANS = '"IBM Plex Sans", system-ui, sans-serif';

/** The vetted set. Order is the picker order: Empty first (the explicit
 *  blank-slate choice), then progressively richer layouts. */
export const WEB_TEMPLATES: readonly WebTemplate[] = [
  {
    id: "empty",
    label: "Empty",
    description: "A blank frame — start from nothing.",
    html: "",
    css: "",
  },
  {
    id: "title-block",
    label: "Title block",
    description: "A heading and a subtitle — a section opener.",
    html:
      '<div class="title">\n' +
      "  <h1>Section title</h1>\n" +
      "  <p>A short subtitle that sits under the heading.</p>\n" +
      "</div>",
    css:
      ".title { padding: 4px 0; }\n" +
      `.title h1 { font: 600 24px/1.2 ${SANS}; margin: 0 0 4px; }\n` +
      `.title p  { font: 14px/1.45 ${SANS}; margin: 0; color: #555; }`,
  },
  {
    id: "card",
    label: "Card",
    description: "A bordered card with a title and body copy.",
    html:
      '<div class="card">\n' +
      "  <h2>Card title</h2>\n" +
      "  <p>Body copy for the card. Replace this with your content.</p>\n" +
      "</div>",
    css:
      "* { box-sizing: border-box; }\n" +
      ".card {\n" +
      "  border: 1px solid #ddd;\n" +
      "  border-radius: 8px;\n" +
      "  padding: 16px;\n" +
      "  background: #fff;\n" +
      "}\n" +
      `.card h2 { font: 600 16px/1.3 ${SANS}; margin: 0 0 8px; }\n` +
      `.card p  { font: 13px/1.5 ${SANS}; margin: 0; color: #444; }`,
  },
  {
    id: "two-column",
    label: "Two-column",
    description: "A two-column grid — text left, text right.",
    html:
      '<div class="cols">\n' +
      '  <div class="col">\n' +
      "    <h3>Left column</h3>\n" +
      "    <p>Content for the left column.</p>\n" +
      "  </div>\n" +
      '  <div class="col">\n' +
      "    <h3>Right column</h3>\n" +
      "    <p>Content for the right column.</p>\n" +
      "  </div>\n" +
      "</div>",
    css:
      "* { box-sizing: border-box; }\n" +
      ".cols {\n" +
      "  display: grid;\n" +
      "  grid-template-columns: 1fr 1fr;\n" +
      "  gap: 16px;\n" +
      "}\n" +
      `.col h3 { font: 600 14px/1.3 ${SANS}; margin: 0 0 6px; }\n` +
      `.col p  { font: 13px/1.5 ${SANS}; margin: 0; color: #444; }`,
  },
];

/** Look a template up by id, or `undefined`. */
export function templateById(id: string): WebTemplate | undefined {
  return WEB_TEMPLATES.find((t) => t.id === id);
}

/**
 * Seed a fresh `WebFrameSource` from a template — its HTML/CSS over the
 * caller's frame OPTIONS (so seeding a template does not silently reset
 * the media/viewport the author already chose). Pure; never mutates the
 * input options. A template never carries `vars` — the §6.2 pass stays
 * opt-in (a seeded frame starts with the pass disabled).
 */
export function sourceFromTemplate(
  template: WebTemplate,
  options: WebFrameSource["options"],
): WebFrameSource {
  return { html: template.html, css: template.css, options: { ...options } };
}
