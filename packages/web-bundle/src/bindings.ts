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

// BOUND DATA for templates — the values a source names under the reserved
// namespaces, resolved from outside the source:
//
//   {{doc.title}}            the document's name (`document.meta()`)
//   {{doc.pages}}            its page count
//   {{doc.<key>}}            the document value map (a container part,
//                            source-part.ts `readDocumentValues`)
//   {{frame.page}}           the 1-based number of the page the frame is on
//   {{data.<field>}}         a field of the first record of the first
//   {{data.<provider>.<field>}}  `dataset` provider (paged.data publishes
//                            one), or of the named provider
//
// Nothing is read unless the source names a bound value
// (`referencesBoundData`), so a source without one costs no host call.
// What a value depends on is also its KEY (`bindingKey`): the auto renderer
// re-renders a frame when it changes, and re-runs when a provider announces
// a new revision.

import type { BundleHost, Disposable, ElementId } from "@paged-media/plugin-api";
import { referencesBoundData, type TemplateVars, type WebFrameSource } from "../../web-model/src";

import { readDocumentValues } from "./source-part";

/** The provider category paged.web reads records from. */
export const DATA_CATEGORY = "dataset";

export interface Bindings {
  /** The bound values, by full name (`doc.title`, `frame.page`, …). */
  vars: TemplateVars;
  /** Everything the values were derived from (provider revisions included) —
   *  equal keys mean equal values. */
  key: string;
}

const NONE: Bindings = { vars: {}, key: "" };

function providersOf(host: BundleHost) {
  if (!host.supports("dataProviders@1")) return [];
  try {
    return host.dataProviders.discover(DATA_CATEGORY);
  } catch {
    return []; // the capability is not granted
  }
}

/** Resolve the bound values a source can name, for the frame `id`. Never
 *  throws: a door that is missing or refuses leaves its values out (the
 *  template pass then reports the unknown name). */
export async function resolveBindings(
  host: BundleHost,
  id: ElementId,
  source: Pick<WebFrameSource, "html" | "css">,
): Promise<Bindings> {
  if (!referencesBoundData(source)) return NONE;
  const vars: TemplateVars = {};
  const parts: string[] = [];
  try {
    const meta = await host.document.meta();
    vars["doc.title"] = meta.documentName ?? "";
    vars["doc.pages"] = String(meta.pageCount ?? "");
  } catch {
    // no document
  }
  try {
    const values = await readDocumentValues(host);
    for (const [k, v] of Object.entries(values)) {
      if (k !== "title" && k !== "pages") vars[`doc.${k}`] = v;
    }
  } catch {
    // no parts
  }
  try {
    const [geo] = await host.document.elementGeometry([id]);
    const pageId = geo?.pageId ?? null;
    if (pageId) {
      const pages = await host.document.collection<{ selfId: string; index: number }>("pages");
      const page = pages.find((p) => p.selfId === pageId);
      if (page) vars["frame.page"] = String(page.index);
    }
  } catch {
    // no geometry
  }
  const providers = providersOf(host);
  for (let i = 0; i < providers.length; i += 1) {
    const info = providers[i];
    parts.push(`${info.id}@${info.revision}`);
    try {
      const snap = await host.dataProviders.get(info.id);
      if (!snap || snap.records.rowCount < 1) continue;
      snap.records.schema.fields.forEach((f, col) => {
        const v = snap.records.columns[col]?.[0];
        const s = v === null || v === undefined ? "" : String(v);
        vars[`data.${info.id}.${f.name}`] = s;
        if (i === 0) vars[`data.${f.name}`] = s;
      });
    } catch {
      // the provider went away
    }
  }
  const key = JSON.stringify([vars, parts]);
  return { vars, key };
}

/** Follow the `dataset` providers: `onChange` fires when one announces a new
 *  revision (or the set of providers changes, checked on `refresh`). */
export function watchProviders(host: BundleHost, onChange: () => void): {
  refresh(): void;
  dispose(): void;
} {
  const subs = new Map<string, Disposable>();
  const refresh = () => {
    const ids = new Set(providersOf(host).map((p) => p.id));
    for (const [id, sub] of subs) {
      if (!ids.has(id)) {
        sub.dispose();
        subs.delete(id);
      }
    }
    for (const id of ids) {
      if (subs.has(id)) continue;
      try {
        subs.set(id, host.dataProviders.onDidChange(id, () => onChange()));
      } catch {
        // not granted
      }
    }
  };
  refresh();
  return {
    refresh,
    dispose() {
      for (const s of subs.values()) s.dispose();
      subs.clear();
    },
  };
}
