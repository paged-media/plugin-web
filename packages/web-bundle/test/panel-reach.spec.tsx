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

import { DEFAULT_SOURCE, envelopeFor, sourceFromEnvelope, type WebSourceEnvelope } from "@paged-media/web-model";

import { makeWebSourcePanel } from "../src/panels/web-source-panel";
import { mountPanel, reachHost, settle } from "./fixtures/panel-host";

const byData = (r: ReactTestRenderer, attr: string) =>
  r.root.find((n) => typeof n.type === "string" && n.props[attr] !== undefined);

const textOf = (node: { children: unknown[] }): string =>
  node.children.map((c) => (typeof c === "string" ? c : textOf(c as { children: unknown[] }))).join("");

describe("empty and refused states say so in the panel", () => {
  it("with nothing selected the panel offers Insert web frame, and shows a refusal inline", async () => {
    const h = reachHost();
    (h.host.document as unknown as { meta: () => Promise<unknown> }).meta = async () => ({ activePage: null });
    const Panel = makeWebSourcePanel(h.host);
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<Panel />);
    });
    await settle();
    const insert = byData(r, "data-web-insert");
    expect(textOf(insert)).toBe("Insert web frame");
    await act(async () => insert.props.onClick());
    await settle();
    expect(textOf(byData(r, "data-web-panel-error"))).toMatch(/no page to insert into/);
  });

  it("a refused Make web frame shows its reason inline", async () => {
    const h = reachHost();
    h.labels.delete("uA");
    (h.host.document as unknown as { setMetadata: () => Promise<unknown> }).setMetadata = async () => ({
      applied: false,
      error: { kind: "rejected", reason: "locked" },
    });
    const r = await mountPanel(h);
    await act(async () => byData(r, "data-web-make").props.onClick());
    await settle();
    expect(textOf(byData(r, "data-web-panel-error"))).toMatch(/^Not made a web frame/);
  });
});

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

describe("preview = canvas", () => {
  const iframe = (r: ReactTestRenderer) => byData(r, "data-web-preview");

  it("the preview lays out at the frame's size (points → CSS px), not a viewport option", async () => {
    const h = reachHost([10, 20, 160, 320]); // 300 × 150 pt
    h.labels.set("uA", envelopeFor({ ...DEFAULT_SOURCE, options: { media: "print", overflow: "clip", viewportWidth: 999 } }));
    const r = await mountPanel(h);
    expect(iframe(r).props.style.width).toBe("400px");
    expect(iframe(r).props.style.height).toBe("200px");
    expect(r.root.findAll((n) => typeof n.type === "string" && n.props["data-web-viewport"] !== undefined)).toHaveLength(0);
  });

  it("a resize of the frame resizes the preview", async () => {
    const h = reachHost([0, 0, 150, 300]);
    const r = await mountPanel(h);
    h.geometry.bounds = [0, 0, 150, 450];
    await act(async () => h.emit({ kind: "mutationApplied", pageIds: [], reflow: { frameId: "uA", contentBox: [0, 0, 150, 450] } }));
    await settle();
    expect(iframe(r).props.style.width).toBe("600px");
  });

  // The editor resizes by the handles as a canvas gesture; its commit is the
  // editor client's `gestureCommitted`, not a document change event.
  it("a resize by the frame's handles (the editor's gesture commit) resizes the preview", async () => {
    const h = reachHost([0, 0, 150, 300]);
    const r = await mountPanel(h);
    h.geometry.bounds = [0, 0, 150, 450];
    await act(async () => h.broadcast({ kind: "gestureCommitted", payload: { handle: 1, appliedSeq: 2, pageIds: [] } }));
    await settle();
    expect(iframe(r).props.style.width).toBe("600px");
  });

  it("an undo that resizes the frame resizes the preview", async () => {
    const h = reachHost([0, 0, 150, 300]);
    const r = await mountPanel(h);
    h.geometry.bounds = [0, 0, 300, 300];
    await act(async () => h.emit({ kind: "undoApplied", pageIds: [] }));
    await settle();
    expect(iframe(r).props.style.height).toBe("400px");
  });

  it("the panel says the canvas follows a save, not a command", async () => {
    const h = reachHost();
    const r = await mountPanel(h);
    const note = byData(r, "data-web-preview-note");
    const text = [note.props.children].flat().join("");
    expect(text).not.toMatch(/when you run/);
    expect(text).toMatch(/save/i);
  });

  it("the media option says how @media is evaluated", async () => {
    const h = reachHost();
    const r = await mountPanel(h);
    const text = [byData(r, "data-web-media-note").props.children].flat().join("");
    expect(text).toMatch(/@media/);
  });
});

describe("no stale promises in the panel", () => {
  it("no text promises a lane that ships later", async () => {
    const h = reachHost();
    const r = await mountPanel(h);
    const texts: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === "string") texts.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object" && "children" in node) walk((node as { children: unknown }).children);
    };
    walk(r.toJSON());
    const all = texts.join(" ");
    expect(all).not.toMatch(/ships? with|W2 lane|render lane|not built yet|when you run/i);
  });
});
