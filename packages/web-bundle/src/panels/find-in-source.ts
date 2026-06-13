// "Find in source" — the panel-side selection glue over web-model's
// `tagOutline`.
//
// HONEST SUBSET (the W-01 boundary): the sandboxed preview runs no JS
// and nothing is laid out (the Blitz render lane is not built), so there
// is no rendered box to hover. What works today is the SOURCE side:
// `tagOutline` scans the markup for its opening tags, the panel lists
// them, and clicking one SELECTS that tag's character range in the code
// editor. That is a navigation aid over the text — NOT inspection of a
// rendered element. The panel names it so.
//
// The selection itself only works in the BUNDLE-OWNED textarea lane
// (the fallback editor), where the bundle controls the DOM element and
// can set `selectionStart/selectionEnd` + scroll it into view. The HOST
// code-editor widget is a controlled value-only surface
// (`CodeEditorProps` has no selection prop), so there is no contract to
// drive its caret — in that lane the panel still lists the tags with
// their line numbers (a "go to line N" hint) but cannot move the host
// widget's caret. That gap is the honest seam; widening `CodeEditorProps`
// with a selection channel is a plugin-api decision, not faked here.

/** The textarea fields this helper touches — narrowed so the logic is
 *  pure/testable without a real DOM (jsdom isn't wired here). A real
 *  `HTMLTextAreaElement` satisfies it. */
export interface SelectableTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  /** Optional — present on real elements; used to scroll the selection
   *  into view. Absent in tests. */
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

/**
 * Select `[start, end)` in a textarea and focus it, clamping the range
 * to the current value length (defensive: the source could have changed
 * since the outline was scanned). Returns the clamped range actually
 * applied. Pure aside from the element mutation; never throws.
 */
export function selectRange(
  el: SelectableTextarea,
  start: number,
  end: number,
): { start: number; end: number } {
  const len = el.value.length;
  const s = Math.max(0, Math.min(start, len));
  const e = Math.max(s, Math.min(end, len));
  el.focus();
  el.setSelectionRange(s, e);
  // Best-effort scroll: proportion the selection start into the
  // scrollable height. Only when the element exposes scroll metrics.
  if (
    typeof el.scrollHeight === "number" &&
    typeof el.clientHeight === "number" &&
    el.scrollHeight > el.clientHeight &&
    len > 0
  ) {
    const ratio = s / len;
    el.scrollTop = Math.round(ratio * (el.scrollHeight - el.clientHeight));
  }
  return { start: s, end: e };
}
