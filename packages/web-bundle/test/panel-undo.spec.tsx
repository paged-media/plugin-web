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

// The host's Cmd+Z reaches the panel's source edits (ADR 012): while the web
// frame's edit context is active, the context's undo hooks step the frame's
// draft history; keystrokes in quick succession are one step; outside the
// context the hooks decline.

import { act, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";

import { makeWebFrameEditContext } from "../src/edit-context";
import { createDraftSession } from "../src/panels/draft-store";
import { makeWebSourcePanel } from "../src/panels/web-source-panel";
import { reachHost, settle } from "./fixtures/panel-host";
import { create } from "react-test-renderer";

const A = { kind: "rectangle", id: "uA" } as ElementId;

function setup() {
  let now = 0;
  const session = createDraftSession({ now: () => now });
  const h = reachHost();
  const ctx = makeWebFrameEditContext("panel", session);
  return {
    h,
    ctx,
    session,
    tick: (ms: number) => (now += ms),
    async mount() {
      const Panel = makeWebSourcePanel(h.host, session);
      let r!: ReactTestRenderer;
      h.select([A]);
      await act(async () => {
        r = create(<Panel />);
      });
      await settle();
      return r;
    },
  };
}

const html = (r: ReactTestRenderer) =>
  r.root.find((n) => n.type === "textarea" && n.props["aria-label"] === "Web frame HTML");
const type = async (r: ReactTestRenderer, value: string) =>
  act(async () => html(r).props.onChange({ target: { value } }));

describe("host undo reaches the panel's source edits", () => {
  it("the edit context declares the undo hooks", () => {
    const { ctx } = setup();
    expect(typeof ctx.onUndo).toBe("function");
    expect(typeof ctx.onRedo).toBe("function");
    expect(typeof ctx.onCanUndo).toBe("function");
    expect(typeof ctx.onCanRedo).toBe("function");
  });

  it("inside the context, undo and redo step the frame's draft", async () => {
    const s = setup();
    const r = await s.mount();
    const original = html(r).props.value;
    s.tick(5000);
    await type(r, "<p>one</p>");
    s.tick(5000);
    await type(r, "<p>two</p>");
    s.ctx.onEnter!({ type: "webFrame", id: A });

    expect(s.ctx.onCanUndo!()).toBe(true);
    await act(async () => void s.ctx.onUndo!());
    expect(html(r).props.value).toBe("<p>one</p>");
    await act(async () => void s.ctx.onUndo!());
    expect(html(r).props.value).toBe(original);
    expect(s.ctx.onCanUndo!()).toBe(false);
    expect(s.ctx.onUndo!()).toBe(false);

    expect(s.ctx.onCanRedo!()).toBe(true);
    await act(async () => void s.ctx.onRedo!());
    expect(html(r).props.value).toBe("<p>one</p>");
  });

  it("keystrokes in quick succession are one undo step", async () => {
    const s = setup();
    const r = await s.mount();
    const original = html(r).props.value;
    s.tick(5000);
    for (const v of ["<p>a", "<p>ab", "<p>abc</p>"]) {
      s.tick(100);
      await type(r, v);
    }
    s.ctx.onEnter!({ type: "webFrame", id: A });
    await act(async () => void s.ctx.onUndo!());
    expect(html(r).props.value).toBe(original);
  });

  it("a new edit after an undo drops the redo branch", async () => {
    const s = setup();
    const r = await s.mount();
    s.tick(5000);
    await type(r, "<p>one</p>");
    s.ctx.onEnter!({ type: "webFrame", id: A });
    await act(async () => void s.ctx.onUndo!());
    s.tick(5000);
    await type(r, "<p>other</p>");
    expect(s.ctx.onCanRedo!()).toBe(false);
  });

  it("outside the context the hooks decline", async () => {
    const s = setup();
    const r = await s.mount();
    s.tick(5000);
    await type(r, "<p>one</p>");
    s.ctx.onEnter!({ type: "webFrame", id: A });
    s.ctx.onExit!({ type: "webFrame", id: A });
    expect(s.ctx.onCanUndo!()).toBe(false);
    expect(s.ctx.onUndo!()).toBe(false);
    expect(html(r).props.value).toBe("<p>one</p>");
  });
});
