// The tag OUTLINE scan — the source-side subset of click-to-inspect.
//
// ===================== HONEST SEAM — READ THIS =====================
// Full live element inspection (hover a rendered box → highlight its
// source, read computed layout/box metrics) needs the element to be
// LAID OUT, which needs the Blitz/WASM render lane (RFI §6 W-01). That
// lane is not built. What IS honest today, with only the static source
// and a `sandbox=""` preview that runs no JS, is the SOURCE side: scan
// the markup for its element tags and expose, per tag, the exact
// character range of its OPEN tag in the source. The panel lists those
// tags; clicking one selects/scrolls to that range in the code editor
// ("Find in source"). It is a navigation aid over the text, NOT
// inspection of a rendered box — the panel says so.
// =================================================================
//
// A scanner, not a parser (the `diagnose.ts` discipline): zero deps, no
// DOM, never crashes on bad input. Void elements and close tags are not
// emitted (there is no open-tag range to jump to for a `</div>`); each
// emitted entry is one OPENING tag with its `[sourceStart, sourceEnd)`
// half-open character offsets into the input string.

/** Same tag grammar as the linter's TAG, so the outline and the
 *  diagnostics agree on what counts as a tag. */
const TAG = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/)?\s*>/g;

export interface TagOutlineEntry {
  /** Lowercased element tag name (`div`, `h1`, `img`). */
  tag: string;
  /** Character offset of the `<` that opens this tag (inclusive). */
  sourceStart: number;
  /** Character offset just past the `>` that closes this tag (exclusive)
   *  — `html.slice(sourceStart, sourceEnd)` is exactly the open tag. */
  sourceEnd: number;
  /** 1-based source line of the opening `<` (for a list label / gutter
   *  parity with the diagnostics lane). */
  line: number;
}

function lineOf(html: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i++) {
    if (html[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Scan an HTML fragment for its OPENING element tags, in source order,
 * each with the character range of the open tag. Close tags (`</div>`)
 * are skipped (nothing to navigate to). `<script>` open tags ARE
 * emitted — the author may want to find one to delete it (the linter
 * flags it; the outline helps locate it). Pure and total: malformed
 * input yields whatever well-formed tags it can find and never throws.
 */
export function tagOutline(html: string): TagOutlineEntry[] {
  const out: TagOutlineEntry[] = [];
  if (typeof html !== "string" || html.length === 0) return out;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    const [whole, closing, rawTag] = m;
    if (closing) continue; // a close tag has no open-tag range to jump to
    const tag = rawTag.toLowerCase();
    const sourceStart = m.index;
    const sourceEnd = m.index + whole.length;
    // A void/self-closing element is still ONE opening tag with a
    // findable range — emitted like any other (the outline is about
    // where a tag is, not whether it has a body).
    out.push({ tag, sourceStart, sourceEnd, line: lineOf(html, sourceStart) });
  }
  return out;
}
