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

// The source panel's reach into the canvas: the overflow policy is a live
// choice that persists. Rendered with react-test-renderer against a minimal
// host.

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, envelopeFor, sourceFromEnvelope, type WebSourceEnvelope } from "@paged-media/web-model";

import { makeWebSourcePanel } from "../src/panels/web-source-panel";

const A = { kind: "rectangle", id: "uA" } as ElementId;

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

const byData = (r: ReactTestRenderer, attr: string) =>
  r.root.find((n) => typeof n.type === "string" && n.props[attr] !== undefined);

describe("overflow policy in the panel", () => {
  it("the select offers the four policies and is enabled", async () => {
    const h = reachHost();
    const r = await mountPanel(h);
    const select = byData(r, "data-web-overflow");
    expect(select.props.disabled).toBeFalsy();
    const values = select.findAll((n) => n.type === "option").map((o) => o.props.value);
    expect(values).toEqual(["clip", "shrink", "grow", "thread"]);
  });

  it("choosing a policy is a draft edit; saving persists it", async () => {
    const h = reachHost();
    const r = await mountPanel(h);
    await act(async () => byData(r, "data-web-overflow").props.onChange({ target: { value: "grow" } }));
    expect(byData(r, "data-web-dirty").props["data-web-dirty"]).toBe("true");
    await act(async () => byData(r, "data-web-commit").props.onClick());
    await settle();
    const saved = sourceFromEnvelope(h.labels.get("uA") as WebSourceEnvelope);
    expect(saved?.options.overflow).toBe("grow");
  });
});
