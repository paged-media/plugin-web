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

// Shared headless-host bootstrap for the paged.web conformance specs.
// One wasm boot per SUITE FILE (in `beforeAll`), reused across the
// file's tests — booting per test would dominate the runtime.

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

export const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

export const openHost = (): Promise<HeadlessHost> =>
  createHeadlessHost({ console: silent, storage: mapBacking() });
