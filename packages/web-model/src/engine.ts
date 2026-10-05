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

// Engine version PINNING — the determinism record ADR-011 requires.
// A rendered web frame is reproducible only if the exact engine stack
// that painted it is recorded: re-rendering the same source under the
// same pins must yield the same scene. This module is the pin's single
// source of truth, stamped into the source envelope's `engine` field on
// save so a later render can detect a stack drift. It must equal the
// versions in packages/web-render/Cargo.lock — web-bundle's
// engine-pin.spec.ts fails when it does not.

/** The pinned web-engine stack (ADR 401: the Blitz stack is pinned
 *  exactly). Bump in lockstep with the web-render lockfile. */
export interface EnginePin {
  /** blitz-dom / blitz-paint version. */
  blitz: string;
  /** Stylo (servo CSS) version. */
  stylo: string;
  /** anyrender version (the paint-scene trait the capture implements). */
  anyrender: string;
}

/** The current pin. Frozen so it can't be mutated by a stamp round-trip. */
export const ENGINE_PIN: Readonly<EnginePin> = Object.freeze({
  blitz: "0.3.0-alpha.4",
  stylo: "0.17.0",
  anyrender: "0.10.0",
});

/** Flatten an {@link EnginePin} to the envelope's `engine` record
 *  (`Record<string, string>` — the structural twin of the host's
 *  `PluginMetadataEnvelope.engine`). Stamped on every save so the
 *  document records which stack a render used. */
export function engineStamp(pin: Readonly<EnginePin> = ENGINE_PIN): Record<
  string,
  string
> {
  return { blitz: pin.blitz, stylo: pin.stylo, anyrender: pin.anyrender };
}

/** Read a pin back from an envelope `engine` record. Missing/garbage
 *  fields read as "" rather than throwing — a legacy envelope (no
 *  stamp) reads as an empty pin, which a re-render treats as "unknown
 *  prior stack" (always re-render), never a crash. */
export function pinFromStamp(
  stamp: Record<string, string> | undefined,
): EnginePin {
  const s = stamp ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return { blitz: str(s.blitz), stylo: str(s.stylo), anyrender: str(s.anyrender) };
}

/** Whether two pins describe the same stack (a re-render under a
 *  matching pin is byte-reproducible; a mismatch means the engine moved
 *  and the cached scene is stale). */
export function pinMatches(a: EnginePin, b: EnginePin): boolean {
  return a.blitz === b.blitz && a.stylo === b.stylo && a.anyrender === b.anyrender;
}
