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

// The faces BAKED TEXT names, given to the document (ADR 411, amendments
// 2026-10-12 and 2026-10-14).
//
// A baked run names the face the engine shaped it in (ADR 411): a document
// face, the bundled face, or a face a source's `@font-face` rule loaded. The
// last two are faces the document does not hold, so the native text named a
// family the document's font registry had no face for: the Fonts panel and
// preflight flagged it missing, and the canvas drew it in a substitute. (The
// web film's mailer names "IBM Plex Sans", which nobody holds, so every run is
// shaped — and baked — in the bundled Inter.)
//
// Before the bake writes its text, every family its runs name that the
// document holds no face for is given the bytes the bundle shaped it with,
// through the plugin API's document-face door
// (`host.assets.registerDocumentFont`). The door fills a gap and never
// replaces a face the document holds; a family the document already holds
// (`assets.getFontFace` answers from the document registry) is not offered
// at all. The engine keeps a registered face for the session (every document
// opened later starts with it).

import type { BundleHost } from "@paged-media/plugin-api";
import type { WebDiagnostic } from "../../web-model/src";

import { heldFaces } from "./engine-inputs";
import type { WebEngine } from "./engine-loader";

const problem = (message: string): WebDiagnostic => ({ severity: "warning", message, source: "render" });

/** Whether the document's font registry holds a face of `family` (null: the
 *  host cannot say). */
async function documentHolds(host: BundleHost, family: string): Promise<boolean | null> {
  try {
    return (await host.assets.getFontFace(family)) !== null;
  } catch {
    return null;
  }
}

/** Give the document a face for every family in `families` it holds none
 *  for, from the faces the bundle shaped with. Answers the problems: a family
 *  the bundle holds no face for (or a host without the door), or a face the
 *  document would not take. */
export async function provideDocumentFaces(
  host: BundleHost,
  engine: WebEngine,
  families: Iterable<string>,
): Promise<WebDiagnostic[]> {
  const out: WebDiagnostic[] = [];
  // Each capability is probed once, and only when a family needs it.
  let canTell: boolean | undefined;
  let door: boolean | undefined;
  const asked = new Set<string>();
  for (const family of families) {
    const key = family.toLowerCase();
    if (!family || asked.has(key)) continue;
    asked.add(key);
    // A family the document holds is left as the document has it.
    canTell ??= host.supports("assets.fonts@1");
    const holds = canTell ? await documentHolds(host, family) : null;
    if (holds === true) continue;
    const faces = heldFaces(host, engine, family);
    if (faces.length > 0) door ??= host.supports("assets.documentFont@1");
    if (faces.length === 0 || !door) {
      // Only a family the document is known to lack is a problem.
      if (holds === false) {
        out.push(problem(`baked text is set in “${family}”, a face the document does not have: it is drawn in a substitute`));
      }
      continue;
    }
    for (const face of faces) {
      const outcome = await host.assets.registerDocumentFont(face.bytes, family, face.style);
      if (outcome.status === "refused") {
        out.push(problem(`the document did not take the face “${family}${face.style ? ` ${face.style}` : ""}” (${outcome.reason})`));
      }
    }
  }
  return out;
}
