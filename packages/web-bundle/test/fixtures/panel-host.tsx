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

// A minimal host for the source panel's react-test-renderer specs: one
// frame "uA" with a default source, settable geometry, recorded label
// writes, and emitters for selection and document events.

import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, envelopeFor } from "@paged-media/web-model";

import { makeWebSourcePanel } from "../../src/panels/web-source-panel";

export const A = { kind: "rectangle", id: "uA" } as ElementId;

export function reachHost(bounds: [number, number, number, number] = [0, 0, 150, 300]) {
  let selection: ElementId[] = [];
  const selectionListeners = new Set<(ids: ElementId[]) => void>();
  const docListeners = new Set<(e: unknown) => void>();
  const labels = new Map<string, unknown>([["uA", envelopeFor(DEFAULT_SOURCE)]]);
  const geometry = { bounds };
  const host = {
    supports: () => false,
    widgets: {},
    selection: {
      get: () => selection,
      onDidChange: (l: (ids: ElementId[]) => void) => {
        selectionListeners.add(l);
        return { dispose: () => selectionListeners.delete(l) };
      },
    },
    document: {
      getMetadata: async (id: ElementId) => labels.get(String((id as { id: unknown }).id)) ?? null,
      setMetadata: async (id: ElementId, env: unknown) => {
        labels.set(String((id as { id: unknown }).id), env);
        return { applied: true, createdId: null, pageIds: [] };
      },
      elementGeometry: async (ids: ElementId[]) => ids.map((id) => ({ id, bounds: geometry.bounds })),
      collection: async () => [],
      onDidChange: (l: (e: unknown) => void) => {
        docListeners.add(l);
        return { dispose: () => docListeners.delete(l) };
      },
    },
    parts: { read: async () => null, write: async () => {}, list: async () => [] },
    storage: { get: () => undefined, delete: () => {} },
    diagnostics: { set: () => {} },
    assets: { getFontFace: async () => null },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as BundleHost;
  return {
    host,
    labels,
    geometry,
    select: (ids: ElementId[]) => {
      selection = ids;
      for (const l of selectionListeners) l(ids);
    },
    emit: (e: unknown) => {
      for (const l of docListeners) l(e);
    },
  };
}

export const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

export async function mountPanel(h: ReturnType<typeof reachHost>, id: ElementId = A) {
  const Panel = makeWebSourcePanel(h.host);
  let r!: ReactTestRenderer;
  h.select([id]);
  await act(async () => {
    r = create(<Panel />);
  });
  await settle();
  return r;
}

