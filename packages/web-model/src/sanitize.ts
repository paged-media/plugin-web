// Pure HTML sanitization for the PASTE-INGEST lane — the enforcement
// twin of `diagnoseHtml`. The linter only *reports* a policy violation;
// when HTML is brought in from OUTSIDE the editor (clipboard, a paste),
// the platform's "page JavaScript never executes" rule (§6.1) must be
// ENFORCED, not merely diagnosed: a pasted `<script>` or `onclick=` is
// stripped on the way in so it can never reach the source at all.
//
// Like the linter, this is a SCANNER not a parser — zero dependencies,
// no DOM APIs, and it must never crash on malformed input. It removes
// exactly three classes of executable surface (the same three the
// sandboxed preview + `sandbox=""` already neutralize, made permanent
// in the stored source):
//
//   · `<script>…</script>` elements (open tag → matching close, body
//     and all) — and a stray/orphan `<script>`/`</script>` tag;
//   · inline event-handler attributes (`on…=` — onclick, onload, …)
//     on any tag, value stripped;
//   · `javascript:` URLs in `href`/`src`/any attribute value.
//
// Everything else passes through BYTE-FOR-BYTE. `removed` names each
// class that was actually stripped (deduplicated, stable order) so the
// paste affordance can report what it cleaned ("removed 2 <script>
// blocks, 1 event handler").

/** A label for one class of removed executable surface. */
export type SanitizeRemoval =
  | "<script> element"
  | "event-handler attribute"
  | "javascript: URL";

export interface SanitizeResult {
  /** The sanitized HTML — identical to the input when nothing matched. */
  html: string;
  /** Which classes of executable surface were stripped (deduplicated,
   *  in first-seen order). Empty when the input was already clean. */
  removed: SanitizeRemoval[];
}

/** A `<script …>` open tag OR a `</script>` close tag, case-insensitive,
 *  tolerant of whitespace. Matched first so a script body is excised
 *  wholesale before the attribute/URL passes ever see it. */
const SCRIPT_OPEN = /<\s*script\b[^>]*>/i;
const SCRIPT_CLOSE = /<\s*\/\s*script\s*>/i;

/** An inline event-handler attribute: `on<name>=` with a quoted,
 *  apostrophe-quoted, or bare value. `\son` so we match a real
 *  attribute boundary (`data-online` is mid-name, never matched), never
 *  a substring of another attribute name. CONSERVATIVE by design — any
 *  `on<word>=` at an attribute boundary is stripped (the same scan
 *  `diagnoseHtml` flags); the browser would run it if it WERE a handler,
 *  so removing a rare non-standard `on…` attribute is the safe posture. */
const EVENT_ATTR = /\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;

/** A `javascript:` scheme inside an attribute VALUE (quoted or bare),
 *  tolerant of leading whitespace and HTML-entity/control padding the
 *  browser would strip before parsing the scheme (e.g. `java\tscript:`
 *  or `&#9;`). We match the WHOLE attribute and neutralize its value
 *  rather than guess where the URL ends. */
const JS_URL_ATTR =
  /(\s[a-zA-Z][a-zA-Z0-9-]*\s*=\s*)("(?:\s|&#x?[0-9a-f]+;?)*j[\s]*a[\s]*v[\s]*a[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t\s*:[^"]*"|'(?:\s|&#x?[0-9a-f]+;?)*j[\s]*a[\s]*v[\s]*a[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t\s*:[^']*'|(?:&#x?[0-9a-f]+;?)*j[\s]*a[\s]*v[\s]*a[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t\s*:[^\s"'>]*)/gi;

/**
 * Strip every executable surface from an HTML fragment brought in from
 * outside the editor. Pure and total: garbage input never throws, and a
 * fragment with nothing to strip returns byte-identical with an empty
 * `removed`. Idempotent — sanitizing the output again is a no-op.
 *
 * Order matters: `<script>` bodies are excised FIRST (so handler/URL
 * scanning never runs over removed script text), then event handlers,
 * then `javascript:` URLs.
 */
export function sanitizeHtml(html: string): SanitizeResult {
  if (typeof html !== "string" || html.length === 0) {
    return { html: typeof html === "string" ? html : "", removed: [] };
  }
  const removed = new Set<SanitizeRemoval>();
  let out = html;

  // 1) <script>…</script> — paired removal, then orphan tags. Loop so
  //    multiple blocks all go; a non-greedy body match keeps adjacent
  //    blocks separate.
  const PAIRED = new RegExp(
    SCRIPT_OPEN.source + "[\\s\\S]*?" + SCRIPT_CLOSE.source,
    "i",
  );
  while (PAIRED.test(out)) {
    out = out.replace(PAIRED, "");
    removed.add("<script> element");
  }
  // Orphan open or close tags (an unterminated `<script>` at the end, a
  // stray `</script>`): drop the tag, keep any trailing text honest.
  if (SCRIPT_OPEN.test(out) || SCRIPT_CLOSE.test(out)) {
    out = out
      .replace(new RegExp(SCRIPT_OPEN.source, "gi"), "")
      .replace(new RegExp(SCRIPT_CLOSE.source, "gi"), "");
    removed.add("<script> element");
  }

  // 2) inline event-handler attributes, anywhere in an open tag.
  if (EVENT_ATTR.test(out)) {
    EVENT_ATTR.lastIndex = 0;
    out = out.replace(EVENT_ATTR, "");
    removed.add("event-handler attribute");
  }

  // 3) javascript: URLs in attribute values — neutralize the value to an
  //    empty string rather than dropping the attribute (keeps the
  //    surrounding markup well-formed: `href=""` not a dangling `href`).
  if (JS_URL_ATTR.test(out)) {
    JS_URL_ATTR.lastIndex = 0;
    out = out.replace(JS_URL_ATTR, (_m, prefix: string, value: string) => {
      const quote = value.startsWith('"')
        ? '"'
        : value.startsWith("'")
          ? "'"
          : "";
      return `${prefix}${quote}${quote}`;
    });
    removed.add("javascript: URL");
  }

  return { html: out, removed: [...removed] };
}
