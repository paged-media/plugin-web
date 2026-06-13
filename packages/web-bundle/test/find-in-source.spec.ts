// "Find in source" — the panel-side selection glue. Tested as a pure
// unit against a minimal SelectableTextarea fake (no jsdom is wired
// here; the helper is narrowed to the fields it touches so it stays
// testable). The tag-position SCAN itself is web-model's tagOutline
// (covered in outline.spec.ts); this proves the selection mapping.

import { describe, expect, it, vi } from "vitest";

import { tagOutline } from "@paged-media/web-model";

import { selectRange, type SelectableTextarea } from "../src/panels/find-in-source";

function fakeTextarea(value: string): SelectableTextarea & {
  setSelectionRange: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  return {
    value,
    selectionStart: 0,
    selectionEnd: 0,
    focus: vi.fn(),
    setSelectionRange: vi.fn(function (this: SelectableTextarea, s: number, e: number) {
      this.selectionStart = s;
      this.selectionEnd = e;
    }),
  };
}

describe("selectRange", () => {
  it("focuses and selects the exact tag range from the outline", () => {
    const html = "<div><p>hi</p></div>";
    const el = fakeTextarea(html);
    // The outline entry for <p> (second opening tag).
    const p = tagOutline(html)[1];
    expect(p.tag).toBe("p");
    const applied = selectRange(el, p.sourceStart, p.sourceEnd);
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(applied).toEqual({ start: p.sourceStart, end: p.sourceEnd });
    expect(html.slice(applied.start, applied.end)).toBe("<p>");
  });

  it("clamps an out-of-range request to the current value length", () => {
    const el = fakeTextarea("<p>x</p>");
    const applied = selectRange(el, 100, 200);
    expect(applied).toEqual({ start: 8, end: 8 }); // both clamped to length
  });

  it("keeps end >= start even when given a reversed range", () => {
    const el = fakeTextarea("<div></div>");
    const applied = selectRange(el, 5, 2);
    expect(applied.end).toBeGreaterThanOrEqual(applied.start);
  });

  it("scrolls proportionally when the element exposes scroll metrics", () => {
    const html = "a".repeat(100);
    const el: SelectableTextarea = {
      ...fakeTextarea(html),
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
    };
    selectRange(el, 50, 60); // halfway through the value
    // ratio 0.5 over (1000-200)=800 → 400.
    expect(el.scrollTop).toBe(400);
  });

  it("does not throw when scroll metrics are absent", () => {
    const el = fakeTextarea("<p>x</p>");
    expect(() => selectRange(el, 0, 3)).not.toThrow();
  });
});
