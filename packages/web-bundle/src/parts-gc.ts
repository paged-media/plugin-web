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

// The SOURCE-PART COLLECTOR (ADR 410): drop, on save, the container parts
// no label and no undo step can reach.
//
// Parts take no part in undo, so a part a label stopped naming may still be
// needed by an undo step of this session. The undo history starts empty
// when a document opens, though, so what was unreachable THEN can only be
// reached again by a write of this session. The collector therefore
//   · at open (activation, or another document opening —
//     document-opened.ts), lists the
//     parts and marks as garbage those no label names: a content-addressed
//     `sources/<hash>.json` whose hash no web label points to, and a legacy
//     `<frame>/source.json` whose frame the document does not have;
//   · on save (`document.onWillSave`), deletes each marked part that is
//     still unnamed and that this session did not write (source-part.ts
//     records every write).
// Parts written this session are never dropped; the next open collects
// them. Deleting needs `storage.parts@2`; without it nothing is removed.
//
// A kept face (`faces/<hash>.json`, ADR 414) is garbage once no text in the
// document names its family — after the bake that kept it was undone, or its
// text deleted — at the same two moments.
//
// The old document-values part (`web/document-values.json`) follows the
// same two moments: it is garbage once the document metadata carries the
// value map (source-part.ts `documentValuesMigrated`) both when the document
// opened and at the save. The session that migrates it keeps it, so an undo
// of the migration still finds the values; the next session drops it.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import { sourceRefOf, type WebSourceEnvelope } from "../../web-model/src";

import { discoverWebFrames } from "./auto-render";
import { onDocumentOpened } from "./document-opened";
import {
  DOCUMENT_VALUES_PART,
  documentValuesMigrated,
  FACE_PART,
  keptFaceFamily,
  partsWrittenThisSession,
} from "./source-part";

const SOURCE_PART = /^sources\/([0-9a-f]{16})\.json$/;
const LEGACY_PART = /^([^/]+)\/source\.json$/;

interface Reach {
  hashes: Set<string>;
  items: Set<string>;
  /** The document metadata carries the value map: the old part is unread. */
  valuesMigrated: boolean;
  /** Each kept face among the parts asked about: whether the document's
   *  text names its family (an unreadable part names nothing). */
  facesNamed: Map<string, boolean>;
}

/** Whether the document's text names the family of each kept face in
 *  `paths` (the Fonts collection: every family a run or style names). */
async function facesNamed(host: BundleHost, paths: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const faces = paths.filter((p) => FACE_PART.test(p));
  if (faces.length === 0) return out;
  const rows = await host.document.collection<{ family?: unknown }>("fonts");
  const named = new Set(rows.map((r) => (typeof r.family === "string" ? r.family.toLowerCase() : "")));
  for (const path of faces) {
    const family = await keptFaceFamily(host, path);
    out.set(path, family !== null && named.has(family.toLowerCase()));
  }
  return out;
}

async function reachable(host: BundleHost, paths: readonly string[] = []): Promise<Reach> {
  const { items, found } = await discoverWebFrames(host);
  const hashes = new Set<string>();
  for (const f of found) {
    try {
      const ref = sourceRefOf(JSON.parse(f.label) as WebSourceEnvelope);
      if (ref) hashes.add(ref.hash);
    } catch {
      // an unreadable label names nothing
    }
  }
  const valuesMigrated = await documentValuesMigrated(host).catch(() => false);
  return {
    hashes,
    items: new Set(items.map((i) => (i as { id: string }).id)),
    valuesMigrated,
    facesNamed: await facesNamed(host, paths),
  };
}

function unreachable(path: string, reach: Reach): boolean {
  if (path === DOCUMENT_VALUES_PART) return reach.valuesMigrated;
  if (FACE_PART.test(path)) return reach.facesNamed.get(path) === false;
  const content = SOURCE_PART.exec(path);
  if (content) return !reach.hashes.has(content[1]);
  const legacy = LEGACY_PART.exec(path);
  if (legacy) return !reach.items.has(legacy[1]);
  return false; // not a source or values part: never ours to judge
}

export function startPartsCollector(host: BundleHost): Disposable {
  let garbage: Promise<string[]> = Promise.resolve([]);

  const markAtOpen = (): void => {
    garbage = (async () => {
      if (!host.supports("storage.parts@1")) return [];
      try {
        const paths = await host.parts.list("");
        const reach = await reachable(host, paths);
        return paths.filter((p) => unreachable(p, reach));
      } catch {
        return []; // no document yet, or no parts: nothing to collect
      }
    })();
  };

  const willSave = host.document.onWillSave(async () => {
    const marked = await garbage;
    if (marked.length === 0 || !host.supports("storage.parts@2")) return;
    const reach = await reachable(host, marked);
    const written = partsWrittenThisSession(host);
    const dropped: string[] = [];
    for (const p of marked) {
      if (written.has(p) || !unreachable(p, reach)) continue;
      try {
        if (await host.parts.delete(p)) dropped.push(p);
      } catch (err) {
        // An engine without the delete door (before protocol 66) refuses;
        // the part stays and the save goes on.
        host.log.debug(`source part ${p} not dropped: ${String(err)}`);
        break;
      }
    }
    garbage = Promise.resolve(marked.filter((p) => !dropped.includes(p)));
    if (dropped.length > 0) {
      host.log.info(`dropped ${dropped.length} unreachable part(s) on save`);
    }
  });

  const offLoaded = onDocumentOpened(host, markAtOpen);
  markAtOpen();

  return {
    dispose() {
      willSave.dispose();
      offLoaded();
    },
  };
}
