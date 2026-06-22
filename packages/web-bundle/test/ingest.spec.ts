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

// Paste-HTML ingestion — the panel-side glue over web-model's
// sanitizer. Tested as pure units (like the rest of the panel's seams):
// the sanitizing wrapper, the removal summary, the clipboard-gating, and
// the K-6 clipboard read path against a fake host.

import { describe, expect, it } from "vitest";

import type { BundleHost, ClipboardPayload } from "@paged-media/plugin-api";

import {
  clipboardAvailable,
  describeRemoval,
  ingestFromClipboard,
  ingestHtml,
} from "../src/panels/ingest";

describe("ingestHtml — sanitize on the way in", () => {
  it("strips a script block and reports it", () => {
    const r = ingestHtml('<p>ok</p><script>evil()</script>');
    expect(r.html).toBe("<p>ok</p>");
    expect(r.removed).toContain("<script> element");
  });

  it("strips an event handler and a javascript: URL together", () => {
    const r = ingestHtml('<a href="javascript:x()" onclick="y()">go</a>');
    expect(r.html).toBe('<a href="">go</a>');
    expect(r.removed).toEqual([
      "event-handler attribute",
      "javascript: URL",
    ]);
  });

  it("passes clean HTML through with empty removed", () => {
    const html = '<div class="a"><p>hi</p></div>';
    const r = ingestHtml(html);
    expect(r.html).toBe(html);
    expect(r.removed).toEqual([]);
  });
});

describe("describeRemoval", () => {
  it("returns null when nothing was removed", () => {
    expect(describeRemoval([])).toBeNull();
  });

  it("names each removed class in a readable clause", () => {
    const note = describeRemoval([
      "<script> element",
      "event-handler attribute",
      "javascript: URL",
    ]);
    expect(note).toMatch(/script blocks/);
    expect(note).toMatch(/inline event handlers/);
    expect(note).toMatch(/javascript: URLs/);
    expect(note).toMatch(/page JavaScript never runs/);
  });
});

// ----------------------------------------------- clipboard (K-6) path

function hostWith(
  supports: (f: string) => boolean,
  read: () => Promise<ClipboardPayload | null>,
): Pick<BundleHost, "supports" | "clipboard"> {
  return {
    supports,
    clipboard: {
      read,
      write: async () => {},
    },
  } as Pick<BundleHost, "supports" | "clipboard">;
}

describe("clipboardAvailable", () => {
  it("reflects supports('clipboard@1')", () => {
    expect(
      clipboardAvailable({ supports: (f) => f === "clipboard@1" }),
    ).toBe(true);
    expect(clipboardAvailable({ supports: () => false })).toBe(false);
  });
});

describe("ingestFromClipboard — the K-6 door", () => {
  it("returns null when the clipboard door is not wired", async () => {
    const host = hostWith(
      () => false,
      async () => ({ text: "<p>x</p>" }),
    );
    await expect(ingestFromClipboard(host)).resolves.toBeNull();
  });

  it("reads, sanitizes, and reports removals when wired", async () => {
    const host = hostWith(
      (f) => f === "clipboard@1",
      async () => ({ text: '<p>ok</p><script>bad()</script>' }),
    );
    const r = await ingestFromClipboard(host);
    expect(r).not.toBeNull();
    expect(r!.html).toBe("<p>ok</p>");
    expect(r!.removed).toContain("<script> element");
  });

  it("returns null on an empty or non-text clipboard", async () => {
    const empty = hostWith((f) => f === "clipboard@1", async () => ({ text: "" }));
    await expect(ingestFromClipboard(empty)).resolves.toBeNull();
    const none = hostWith((f) => f === "clipboard@1", async () => null);
    await expect(ingestFromClipboard(none)).resolves.toBeNull();
  });

  it("never throws on a clipboard read rejection (honest no-op)", async () => {
    const host = hostWith((f) => f === "clipboard@1", async () => {
      throw new Error("denied");
    });
    await expect(ingestFromClipboard(host)).resolves.toBeNull();
  });
});
