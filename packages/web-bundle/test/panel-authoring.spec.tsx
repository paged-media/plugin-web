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

// The panel's authoring surfaces: the bound data a draft names (with the
// values the canvas substitutes, and the document value map), and the
// outline following a press on the canvas.

import { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { BundleHost } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, envelopeFor } from "@paged-media/web-model";

import { reportCanvasPick } from "../src/outline-highlight";
import { mountPanel, reachHost, settle } from "./fixtures/panel-host";

const byData = (r: ReactTestRenderer, attr: string, value?: string) =>
  r.root.find(
    (n) => typeof n.type === "string" && n.props[attr] !== undefined && (value === undefined || n.props[attr] === value),
  );

function boundHost(html: string) {
  const h = reachHost();
  h.labels.set("uA", envelopeFor({ ...DEFAULT_SOURCE, html }));
  const parts = new Map<string, Uint8Array>();
  const host = h.host as unknown as Record<string, any>;
  host.supports = (f: string) => f === "storage.parts@1";
  host.parts = {
    read: async (p: string) => parts.get(p) ?? null,
    write: async (p: string, b: Uint8Array) => void parts.set(p, b),
    list: async () => [...parts.keys()],
  };
  host.document.meta = async () => ({ documentName: "Annual", pageCount: 4 });
  host.document.elementGeometry = async (ids: unknown[]) =>
    ids.map((id) => ({ id, pageId: "p3", bounds: h.geometry.bounds }));
  host.document.collection = async (name: string) => (name === "pages" ? [{ selfId: "p3", index: 3 }] : []);
  return { h, parts };
}

describe("bound data in the panel @feat:plugin-web.data-binding", () => {
  it("lists the bound names the draft uses with their values, and the preview substitutes them", async () => {
    const { h } = boundHost("<h1>{{doc.title}}</h1><p>page {{frame.page}} of {{doc.pages}} {{data.city}}</p>");
    const r = await mountPanel(h);
    await settle();
    expect(byData(r, "data-web-bound-value", "doc.title").props.children).toBe("Annual");
    expect(byData(r, "data-web-bound-value", "frame.page").props.children).toBe("3");
    expect(byData(r, "data-web-bound-value", "doc.pages").props.children).toBe("4");
    expect(byData(r, "data-web-bound-value", "data.city").props.children).toBe("not bound");
    await act(async () => new Promise((res) => setTimeout(res, 350))); // the preview debounce
    await settle();
    expect(byData(r, "data-web-preview").props.srcDoc).toContain("<h1>Annual</h1>");
  });

  it("a document value is set from the panel into the document value map", async () => {
    const { h, parts } = boundHost("<p>{{doc.edition}}</p>");
    const r = await mountPanel(h);
    await act(async () => byData(r, "data-web-bound-input", "doc.edition").props.onChange({ target: { value: "Spring" } }));
    await act(async () => byData(r, "data-web-bound-set", "doc.edition").props.onClick());
    await settle();
    const saved = JSON.parse(new TextDecoder().decode(parts.get("web/document-values.json")!));
    expect(saved).toEqual({ edition: "Spring" });
  });

  it("shows nothing when the draft names no bound value", async () => {
    const h = reachHost();
    const r = await mountPanel(h);
    expect(r.root.findAll((n) => typeof n.type === "string" && n.props["data-web-bound"] !== undefined)).toHaveLength(0);
  });
});

describe("outline follows the canvas @feat:plugin-web.outline-canvas", () => {
  it("a press on the canvas inside the frame marks the element's tag", async () => {
    const h = reachHost();
    h.labels.set("uA", envelopeFor({ ...DEFAULT_SOURCE, html: "<p>a</p><div><p>b</p></div>" }));
    const r = await mountPanel(h);
    await act(async () => reportCanvasPick(h.host as BundleHost, "uA", 2));
    const active = r.root.findAll((n) => typeof n.type === "string" && n.props["data-web-outline-active"] === "true");
    expect(active).toHaveLength(1);
    expect(active[0].props["data-web-outline-tag"]).toBe("p");
    await act(async () => reportCanvasPick(h.host as BundleHost, "uOther", 0));
    expect(
      r.root.findAll((n) => typeof n.type === "string" && n.props["data-web-outline-active"] === "true")[0].props[
        "data-web-outline-line"
      ],
    ).toBeDefined();
  });
});
