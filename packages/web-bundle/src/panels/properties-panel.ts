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

// ADR 323 (object-model design §4 "Panels") — the web frame's object
// properties as a SCHEMA panel of property rows: the host renders each row
// with its one schema-driven `PropertyField` over `host.objects` (the
// widget comes from the webFrame / templateVar / cssVar schema row, a
// commit is one undo step, and every field offers "Bind to data…"). The
// bundle declares fields, never widgets. The source panel keeps its
// draft-based code editors; this panel writes the persisted source.

import type { BundleHost, Disposable, PanelSchema } from "@paged-media/plugin-api";
import { propertyRows, publishObjectList } from "@paged-media/plugin-sdk";

import { PANEL_FIELDS, PLUGIN_ID } from "../object-model";

export const PROPERTIES_PANEL_ID = "media.paged.web.panel.properties";

const WEB_FRAME = `plugin:${PLUGIN_ID}/webFrame`;
const TEMPLATE_VAR = `plugin:${PLUGIN_ID}/templateVar`;
const CSS_VAR = `plugin:${PLUGIN_ID}/cssVar`;

/** Published bindings the lists and their property rows share. */
export const BIND = {
  templateVars: "web.properties.templateVars",
  templateVar: "web.properties.templateVar",
  cssVars: "web.properties.cssVars",
  cssVar: "web.properties.cssVar",
} as const;

const paths = (kind: string, group: string) =>
  PANEL_FIELDS.filter((f) => `plugin:${PLUGIN_ID}/${f.kind}` === kind && f.group === group).map((f) => f.path);

const list = (rows: string, select: string) => ({
  widget: "paged.list",
  list: { items: { kind: "binding" as const, bind: rows }, labelField: "name", secondaryField: "secondary", selectionBinding: select },
});

/** The panel, from `PANEL_FIELDS` (every entry is a row of its kind). */
export const WEB_PROPERTIES_PANEL: PanelSchema = {
  id: PROPERTIES_PANEL_ID,
  title: "Web properties",
  icon: "panel-canvas",
  defaultDock: "right",
  sections: [
    {
      title: "Render",
      // The selected frame's web frame (`<selected> > webFrame`).
      rows: propertyRows(WEB_FRAME, paths(WEB_FRAME, "Render"), "selection"),
    },
    {
      title: "Source",
      collapsible: true,
      rows: propertyRows(WEB_FRAME, [...paths(WEB_FRAME, "Source"), ...paths(WEB_FRAME, "Template"), ...paths(WEB_FRAME, "Flow")], "selection"),
    },
    {
      title: "Bound values",
      rows: [
        list(BIND.templateVars, BIND.templateVar),
        ...propertyRows(TEMPLATE_VAR, paths(TEMPLATE_VAR, "Bound values"), { bind: BIND.templateVar }),
      ],
    },
    {
      title: "CSS variables",
      rows: [
        list(BIND.cssVars, BIND.cssVar),
        ...propertyRows(CSS_VAR, paths(CSS_VAR, "CSS variables"), { bind: BIND.cssVar }),
      ],
    },
  ],
};

/** Keep the two lists live: the document's template values, and the CSS
 *  variables of the selected web frame. */
export function publishPropertyLists(host: BundleHost): Disposable {
  const a = publishObjectList(host, {
    rows: BIND.templateVars,
    select: BIND.templateVar,
    selector: () => TEMPLATE_VAR,
    secondaryPath: "value",
  });
  const b = publishObjectList(host, {
    rows: BIND.cssVars,
    select: BIND.cssVar,
    selector: (sel) => (sel.length === 1 ? `${sel[0]} > ${CSS_VAR}` : null),
    secondaryPath: "value",
  });
  return { dispose: () => (a.dispose(), b.dispose()) };
}
