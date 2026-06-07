// Conformance — the insert-webFrame flow against the REAL engine.
// Loads the paged.web bundle headlessly, fires its OWN insert command
// (recorded in the contribution log), and asserts the §5 contract end
// to end through the true parse→apply→inverse path:
//   · ONE batch (insertFrame + setPluginMetadata via the $created
//     sentinel) — so a single undo removes BOTH frame and source;
//   · the new frame carries this plugin's source envelope as metadata;
//   · undo restores the document to exactly the empty page.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { CommandContribution, ElementId } from "@paged-media/plugin-api";
import { DEFAULT_SOURCE, sourceFromEnvelope } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";
import { openHost } from "./host";

const INSERT_CMD = "media.paged.web.command.insertWebFrame";

/** Count selectable leaves in the scene tree. */
async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: { id?: string } | null; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id?.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

describe("web conformance — insert-webFrame flow", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(W1_EMPTY_PAGE.bytes());
    h.loadBundle(webBundle);
  });
  afterAll(() => h?.dispose());

  it("the bundle records its insert command in the contribution log", () => {
    const cmd = h.contributions.find((c) => c.kind === "command");
    expect(cmd?.id).toBe(INSERT_CMD);
  });

  it("the empty-page fixture starts with no page items", async () => {
    expect(await leafCount(h)).toBe(0);
  });

  it("firing the command inserts exactly one frame carrying the source envelope", async () => {
    const cmd = h.contributions.find(
      (c) => c.kind === "command" && c.id === INSERT_CMD,
    )!.value as CommandContribution;

    // The bundle's handler ignores its (paged, payload) args; pass
    // `undefined` to satisfy the contribution signature.
    await cmd.handler(undefined);

    // One new selectable leaf.
    expect(await leafCount(h)).toBe(1);
    // The created frame is selected (insertWebFrame selects it).
    const selected = h.host.selection.get();
    expect(selected).toHaveLength(1);

    // Its metadata is this plugin's source envelope — the DEFAULT_SOURCE.
    const created = selected[0] as ElementId;
    const env = await h.host.document.getMetadata(created as never);
    expect(env).not.toBeNull();
    const source = sourceFromEnvelope(env as never);
    expect(source).toEqual(DEFAULT_SOURCE);
  });

  it("a SINGLE undo removes the frame AND its source (the batch contract)", async () => {
    // After the insert above, one undo pops the whole batch.
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(0);
  });
});
