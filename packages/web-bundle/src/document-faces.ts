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
// at all.
//
// A document face lives as long as the document it was given to (plugin SDK
// ADR 330; on an older host, the engine session) and is not saved with it,
// while the baked text naming it is. So a bake keeps every face it gave the
// document in a content-addressed part (`faces/<hash>.json`, source-part.ts),
// and each time a document opens the faces its text names and lacks are given
// back from those parts (ADR 414) — with no engine and no re-bake, and also
// when the web frame and its source are gone.

import type { BundleHost, Disposable } from "@paged-media/plugin-api";
import type { WebDiagnostic } from "../../web-model/src";

import { onDocumentOpened } from "./document-opened";
import { heldFaces } from "./engine-inputs";
import type { WebEngine } from "./engine-loader";
import { keepFace, keptFaceFamily, keptFacePaths, readKeptFace, type KeptFace } from "./source-part";

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

/** What {@link provideDocumentFaces} did: the problems, and the faces the
 *  document took (to keep with it once the bake applied). */
export interface ProvidedFaces {
  diagnostics: WebDiagnostic[];
  given: KeptFace[];
}

/** Give the document a face for every family in `families` it holds none
 *  for, from the faces the bundle shaped with. Answers the problems: a family
 *  the bundle holds no face for (or a host without the door), or a face the
 *  document would not take. */
export async function provideDocumentFaces(
  host: BundleHost,
  engine: WebEngine,
  families: Iterable<string>,
): Promise<ProvidedFaces> {
  const out: WebDiagnostic[] = [];
  const given: KeptFace[] = [];
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
      } else {
        given.push({ family, ...(face.style ? { style: face.style } : {}), bytes: face.bytes });
      }
    }
  }
  return { diagnostics: out, given };
}

/** Keep the faces a bake gave the document with the document, so they come
 *  back when it opens again. Answers the problems: a face the document could
 *  not keep (its text is drawn in a substitute once the document reopens). */
export async function keepDocumentFaces(host: BundleHost, given: readonly KeptFace[]): Promise<WebDiagnostic[]> {
  const out: WebDiagnostic[] = [];
  for (const face of given) {
    if (await keepFace(host, face)) continue;
    out.push(
      problem(
        `the face “${face.family}${face.style ? ` ${face.style}` : ""}” could not be kept with the document: ` +
          "opened again, its baked text is drawn in a substitute",
      ),
    );
  }
  return out;
}

/** The problems the open pass found, under one key. */
export const FACE_DIAG_KEY = "media.paged.web#faces";

/** Give the open document back the faces its bakes kept, for the families
 *  its text names and has no face for. Reads no part when nothing is
 *  missing. Answers the problems (a face the document would not take back);
 *  never throws. */
export async function giveBackDocumentFaces(host: BundleHost): Promise<WebDiagnostic[]> {
  const problems: WebDiagnostic[] = [];
  if (!host.supports("assets.documentFont@1")) return problems;
  const paths = await keptFacePaths(host);
  if (paths.length === 0) return problems;
  let missing: Set<string>;
  try {
    const rows = await host.document.collection<{ family?: unknown; isMissing?: unknown }>("fonts");
    missing = new Set(
      rows
        .filter((r) => r.isMissing === true && typeof r.family === "string")
        .map((r) => (r.family as string).toLowerCase()),
    );
  } catch {
    return problems; // no document open
  }
  if (missing.size === 0) return problems;
  for (const path of paths) {
    const family = await keptFaceFamily(host, path);
    if (!family || !missing.has(family.toLowerCase())) continue;
    const face = await readKeptFace(host, path);
    if (!face) continue;
    const outcome = await host.assets.registerDocumentFont(face.bytes, face.family, face.style);
    if (outcome.status === "refused") {
      problems.push(
        problem(
          `the document did not take back the face “${face.family}${face.style ? ` ${face.style}` : ""}” ` +
            `its baked text is set in (${outcome.reason}): that text is drawn in a substitute`,
        ),
      );
    }
  }
  return problems;
}

/** Give the faces back for the document open at activation and every
 *  document opened after; the problems of the open document are published
 *  under {@link FACE_DIAG_KEY}. */
export function startDocumentFaces(host: BundleHost): Disposable {
  let pass: Promise<void> = Promise.resolve();
  let reported = false;
  const run = () => {
    pass = pass
      .then(async () => {
        const problems = await giveBackDocumentFaces(host);
        if (problems.length > 0 || reported) host.diagnostics.set(FACE_DIAG_KEY, problems);
        reported = problems.length > 0;
      })
      .catch((err: unknown) => {
        host.log.warn(`faces of the opened document: ${String(err)}`);
      });
  };
  const off = onDocumentOpened(host, run);
  run();
  return { dispose: off };
}
