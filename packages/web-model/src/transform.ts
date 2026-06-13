// Pre-render transforms — the DETERMINISTIC, NON-TURING W1 slice of
// the concept's §6.2 (Boa-powered generation JavaScript).
//
// ===================== LOUD SEAM — READ THIS =====================
// This is NOT the Boa lane, and it must not quietly grow into one.
// §6.2's end state runs a real ECMAScript transform inside the core's
// pinned Boa engine (ADR-001 — Boa over QuickJS) under the W3.9
// ScriptBudget surface (wall-clock / iteration / recursion caps).
// Shipping that from the BUNDLE today would mean embedding a second
// JS engine as plugin wasm — the W-07 plugin-wasm lane plus the W-08
// Boa-transforms row, both still open platform work. Until that lands
// (the W2 follow-on), the honest slice is this pure TEMPLATE PASS:
// `{{name}}` substitution plus a CLOSED whitelist of pure filters.
//
//   · no expressions, no loops, no conditionals, no property access;
//   · no I/O, no Date, no Math.random, no locale APIs — the output is
//     a total function of (text, vars), reproducible across machines
//     and years (the §6.2 determinism contract, trivially satisfied
//     because nothing Turing-complete exists to budget);
//   · failures NEVER throw and NEVER guess: a malformed/unknown
//     placeholder stays VERBATIM in the output and emits a diagnostic.
//
// Do NOT add arbitrary logic here — that is the Boa lane's job, with
// real budget enforcement. Faking it with an ad-hoc expression
// language would be the exact dishonesty this plugin's seams exist to
// avoid.
// =================================================================

import type { WebDiagnostic } from "./diagnose";
import type { TemplateVars, WebFrameSource } from "./source";

/** The CLOSED filter whitelist — pure, deterministic, locale-free.
 *  Growing this list is an API decision, not a convenience patch. */
export const TEMPLATE_FILTERS = [
  "upper",
  "lower",
  "trim",
  "number-format",
] as const;
export type TemplateFilter = (typeof TEMPLATE_FILTERS)[number];

const FILTER_SET = new Set<string>(TEMPLATE_FILTERS);

/** Variable names: an identifier-ish token (dots/dashes allowed so
 *  `product.price`-style keys read naturally as FLAT map keys — there
 *  is NO property traversal; the dot is part of the key string). */
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A placeholder: `{{ … }}` with no nested braces inside. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export interface TemplateResult {
  /** The text with every RESOLVED placeholder substituted; unresolved
   *  ones (unknown variable / malformed / unknown filter) stay
   *  verbatim so the author sees exactly what didn't apply. */
  output: string;
  /** One diagnostic per unresolved/odd placeholder
   *  (`source: "template"`, line = the placeholder's line). */
  diagnostics: WebDiagnostic[];
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Deterministic en-style number formatting: fixed `,` thousands
 *  grouping, `.` decimal point, optional fixed decimal places. No
 *  locale APIs — same bytes on every machine, forever. */
function formatNumber(n: number, decimals?: number): string {
  const neg = n < 0 || Object.is(n, -0);
  const abs = Math.abs(n);
  const fixed = decimals !== undefined ? abs.toFixed(decimals) : String(abs);
  const dot = fixed.indexOf(".");
  const int = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? "" : fixed.slice(dot + 1);
  // Group only a plain digit run (scientific notation passes through).
  const grouped = /^\d+$/.test(int)
    ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : int;
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}

interface FilterStep {
  name: string;
  arg?: string;
}

/** Parse the inside of `{{ … }}`: `name | filter | filter:arg …`.
 *  Returns null when the shape isn't a placeholder we understand. */
function parsePlaceholder(
  inner: string,
): { name: string; filters: FilterStep[] } | null {
  const segments = inner.split("|").map((s) => s.trim());
  const name = segments[0];
  if (!NAME.test(name)) return null;
  const filters: FilterStep[] = [];
  for (const seg of segments.slice(1)) {
    if (seg.length === 0) return null;
    const colon = seg.indexOf(":");
    if (colon === -1) filters.push({ name: seg });
    else {
      filters.push({
        name: seg.slice(0, colon).trim(),
        arg: seg.slice(colon + 1).trim(),
      });
    }
  }
  return { name, filters };
}

/**
 * Apply the deterministic template pass to one text. Pure and total:
 * the same (text, vars) always yields the same result; garbage input
 * never throws. Unresolved placeholders stay VERBATIM + diagnose —
 * silent emptiness would hide authoring mistakes in print output.
 */
export function applyTemplate(
  text: string,
  vars: TemplateVars,
): TemplateResult {
  if (typeof text !== "string" || text.length === 0) {
    return { output: typeof text === "string" ? text : "", diagnostics: [] };
  }
  const map = vars && typeof vars === "object" ? vars : {};
  const diagnostics: WebDiagnostic[] = [];
  PLACEHOLDER.lastIndex = 0;
  const output = text.replace(PLACEHOLDER, (whole, inner: string, index: number) => {
    const line = lineOf(text, index);
    const parsed = parsePlaceholder(inner);
    if (!parsed) {
      diagnostics.push({
        severity: "warning",
        message: `malformed template placeholder ${whole} — expected {{name}} or {{name | filter}}`,
        source: "template",
        line,
      });
      return whole;
    }
    if (!Object.prototype.hasOwnProperty.call(map, parsed.name)) {
      diagnostics.push({
        severity: "warning",
        message: `unknown template variable “${parsed.name}” — add it in the Variables section`,
        source: "template",
        line,
      });
      return whole;
    }
    let value = String(map[parsed.name]);
    for (const f of parsed.filters) {
      if (!FILTER_SET.has(f.name)) {
        diagnostics.push({
          severity: "warning",
          message:
            `unknown template filter “${f.name}” — available: ${TEMPLATE_FILTERS.join(", ")}` +
            ` (scripted transforms are the Boa lane, not yet available)`,
          source: "template",
          line,
        });
        return whole; // unresolved: leave the placeholder verbatim
      }
      switch (f.name as TemplateFilter) {
        case "upper":
          value = value.toUpperCase();
          break;
        case "lower":
          value = value.toLowerCase();
          break;
        case "trim":
          value = value.trim();
          break;
        case "number-format": {
          const n = Number(value.trim());
          if (!Number.isFinite(n)) {
            diagnostics.push({
              severity: "warning",
              message: `number-format: “${value}” is not a number — value passed through unformatted`,
              source: "template",
              line,
            });
            break; // keep the unformatted value, stay substituted
          }
          let decimals: number | undefined;
          if (f.arg !== undefined && f.arg.length > 0) {
            const d = Number(f.arg);
            if (Number.isInteger(d) && d >= 0 && d <= 20) decimals = d;
            else {
              diagnostics.push({
                severity: "warning",
                message: `number-format: invalid decimals “${f.arg}” (0–20) — ignored`,
                source: "template",
                line,
              });
            }
          }
          value = formatNumber(n, decimals);
          break;
        }
      }
    }
    return value;
  });
  return { output, diagnostics };
}

export interface RenderedWebFrame {
  /** The html the preview/persist lane should consume. */
  html: string;
  /** The css the preview/persist lane should consume. */
  css: string;
  /** Template diagnostics. HTML-lane entries carry editor LINE numbers
   *  (the html editor has the diagnostics gutter); CSS-lane entries are
   *  line-less and "css: "-prefixed (no css gutter exists — a line
   *  number would land in the WRONG editor's gutter). */
  diagnostics: WebDiagnostic[];
  /** Whether the pass ran at all (`source.vars` present). */
  applied: boolean;
}

/**
 * The single seam between an authored source and everything downstream
 * (preview srcdoc, lint, font parity — and the engine-render lane once
 * it exists): apply the template pass when, and only when, the source
 * carries a `vars` map. Absent map = byte-identical passthrough — a
 * document that never opted in is untouched, and literal `{{` in plain
 * content never warns.
 */
export function renderWebFrameSource(source: WebFrameSource): RenderedWebFrame {
  if (source.vars === undefined) {
    return {
      html: source.html,
      css: source.css,
      diagnostics: [],
      applied: false,
    };
  }
  const html = applyTemplate(source.html, source.vars);
  const css = applyTemplate(source.css, source.vars);
  return {
    html: html.output,
    css: css.output,
    diagnostics: [
      ...html.diagnostics,
      ...css.diagnostics.map((d) => ({
        ...d,
        message: `css: ${d.message}`,
        line: undefined,
      })),
    ],
    applied: true,
  };
}
