// Pure HTML diagnostics for the source panel — the seed of the
// compatibility-table channel (§9: "a published compatibility table
// is part of the docs deliverable and the diagnostics source").
// Deliberately small and dependency-free: a tag-balance scan plus
// the policy checks the platform actually enforces today. The real
// engine-backed diagnostics (unsupported-property warnings from the
// pinned Blitz compatibility table) replace the scanner once the
// rendering lane lands; the Diagnostic SHAPE is the plugin-api one,
// so the panel does not change.

export interface WebDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
  line?: number;
}

/** Void elements — no close tag expected. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

const TAG = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/)?\s*>/g;

function lineOf(html: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i++) {
    if (html[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Scan an HTML fragment: policy violations (script — §6.1; page
 * JavaScript never executes), event-handler attributes, and
 * unbalanced non-void tags. Comments and raw text inside
 * `<style>`/`<script>` bodies are not parsed (the scanner is a
 * linter, not a parser — it must never crash on bad input).
 */
export function diagnoseHtml(html: string): WebDiagnostic[] {
  const out: WebDiagnostic[] = [];
  if (html.trim().length === 0) {
    return [{ severity: "info", message: "empty web frame", source: "html" }];
  }
  const stack: Array<{ tag: string; line: number }> = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    const [, closing, rawTag, attrs, selfClosing] = m;
    const tag = rawTag.toLowerCase();
    const line = lineOf(html, m.index);
    if (tag === "script") {
      if (!closing) {
        out.push({
          severity: "error",
          message:
            "page JavaScript never executes in a web frame (platform policy) — remove <script>",
          source: "html",
          line,
        });
      }
      continue;
    }
    if (!closing && /\son[a-z]+\s*=/.test(attrs ?? "")) {
      out.push({
        severity: "warning",
        message: `event-handler attribute on <${tag}> is ignored (no page JavaScript)`,
        source: "html",
        line,
      });
    }
    if (VOID.has(tag) || selfClosing) continue;
    if (closing) {
      // Pop to the matching open tag; report skipped unclosed tags.
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at === -1) {
        out.push({
          severity: "warning",
          message: `</${tag}> has no matching open tag`,
          source: "html",
          line,
        });
        continue;
      }
      for (let i = stack.length - 1; i > at; i--) {
        out.push({
          severity: "warning",
          message: `<${stack[i].tag}> is never closed`,
          source: "html",
          line: stack[i].line,
        });
      }
      stack.length = at;
    } else {
      stack.push({ tag, line });
    }
  }
  for (const open of stack) {
    out.push({
      severity: "warning",
      message: `<${open.tag}> is never closed`,
      source: "html",
      line: open.line,
    });
  }
  return out;
}
