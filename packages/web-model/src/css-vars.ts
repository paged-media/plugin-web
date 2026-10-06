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

// CSS custom properties as a VIEW over the css lane (ADR 323 object model:
// `plugin:media.paged.web/cssVar/<frame>/--name`). There is no CSS-variable
// model in paged.web — the source text is the truth — so this is a scanner,
// not a parser: it finds `--name: value` declarations inside rule blocks
// (skipping comments and strings, at any nesting depth, `@media` included),
// and a write SPLICES one declaration's value, leaving every other byte of
// the source as the author wrote it. Never throws on bad input.

/** One `--name: value` declaration in a css text. */
export interface CssVarDeclaration {
  /** The property name, `--` included (`--brand`). */
  name: string;
  /** The value as written, trimmed, without a trailing `!important`. */
  value: string;
  /** `[start, end)` of `value` in the css text (UTF-16 offsets). */
  start: number;
  end: number;
  /** Whether the declaration carries `!important`. */
  important: boolean;
  /** The preludes of the enclosing blocks, outermost first
   *  (`["@media print", ":root"]`), each trimmed. */
  context: string[];
}

const NAME = /^--[A-Za-z0-9_-]+$/;

/** Whether `name` is a custom property name we address (`--` + ident chars). */
export function isCssVarName(name: string): boolean {
  return NAME.test(name);
}

/** Skip a comment or string at `i`; the index after it, or `i` when there is
 *  none. An unterminated one runs to the end. */
function skipOpaque(css: string, i: number): number {
  if (css.startsWith("/*", i)) {
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }
  const q = css[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== q) {
      if (css[j] === "\\") j += 1;
      j += 1;
    }
    return Math.min(j + 1, css.length);
  }
  return i;
}

/** Every custom property declaration in `css`, in source order. */
export function scanCssVars(css: string): CssVarDeclaration[] {
  const out: CssVarDeclaration[] = [];
  const stack: string[] = [];
  let preludeStart = 0;
  // At a statement start inside a block (after `{`, `;` or `}`).
  let statementStart = 0;
  let i = 0;
  while (i < css.length) {
    const skipped = skipOpaque(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = css[i];
    if (ch === "{") {
      stack.push(css.slice(preludeStart, i).replace(/\/\*[\s\S]*?\*\//g, "").trim());
      i += 1;
      preludeStart = statementStart = i;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i += 1;
      preludeStart = statementStart = i;
      continue;
    }
    if (ch === ";") {
      i += 1;
      preludeStart = statementStart = i;
      continue;
    }
    // A declaration starts at the first non-space, non-comment character of
    // a statement inside a block.
    if (stack.length > 0 && ch === "-" && css.startsWith("--", i) && css.slice(statementStart, i).replace(/\/\*[\s\S]*?\*\//g, "").trim() === "") {
      const m = /^--[A-Za-z0-9_-]+/.exec(css.slice(i));
      let j = i + (m ? m[0].length : 0);
      while (j < css.length && /\s/.test(css[j])) j += 1;
      if (m && css[j] === ":") {
        // The value runs to `;` or the block's `}` at bracket depth 0.
        const valueFrom = j + 1;
        let k = valueFrom;
        let depth = 0;
        while (k < css.length) {
          const s = skipOpaque(css, k);
          if (s !== k) {
            k = s;
            continue;
          }
          const c = css[k];
          if (c === "(" || c === "[" || c === "{") depth += 1;
          else if ((c === ")" || c === "]") && depth > 0) depth -= 1;
          else if (c === "}") {
            if (depth === 0) break;
            depth -= 1;
          } else if (c === ";" && depth === 0) break;
          k += 1;
        }
        let raw = css.slice(valueFrom, k);
        let important = false;
        const imp = /\s*!\s*important\s*$/i.exec(raw);
        if (imp) {
          important = true;
          raw = raw.slice(0, imp.index);
        }
        const lead = raw.length - raw.trimStart().length;
        const value = raw.trim();
        const start = valueFrom + lead;
        out.push({ name: m[0], value, start, end: start + value.length, important, context: [...stack] });
        i = k;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** The distinct custom property names a css text declares, first-use order. */
export function cssVarNames(css: string): string[] {
  const names: string[] = [];
  for (const d of scanCssVars(css)) if (!names.includes(d.name)) names.push(d.name);
  return names;
}

/** Why `value` cannot be spliced in as a declaration value, or null. A value
 *  may not end the declaration or the block early, nor open a comment or a
 *  string it does not close. */
export function cssVarValueProblem(value: string): string | null {
  if (value.trim().length === 0) return "a custom property value may not be empty";
  let i = 0;
  let depth = 0;
  while (i < value.length) {
    if (value.startsWith("/*", i) || value.startsWith("*/", i)) return "a value may not contain a comment";
    const c = value[i];
    if (c === '"' || c === "'") {
      const s = skipOpaque(value, i);
      if (value[s - 1] !== c || s - 1 === i) return "a value may not leave a string open";
      i = s;
      continue;
    }
    if (c === ";") return 'a value may not contain ";"';
    if (c === "(" || c === "[" || c === "{") depth += 1;
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth < 0) return `a value may not close a bracket it did not open ("${c}")`;
    }
    i += 1;
  }
  return depth === 0 ? null : "a value may not leave a bracket open";
}

/** The css with `name`'s FIRST declaration set to `value` (the rest of the
 *  text byte-identical); a name the css does not declare is appended as a
 *  `:root` rule. Returns the reason instead when the name or value is not
 *  one we can splice safely. */
export function setCssVar(css: string, name: string, value: string): { css: string } | { refused: string } {
  if (!isCssVarName(name)) return { refused: `"${name}" is not a custom property name (--ident)` };
  const problem = cssVarValueProblem(value);
  if (problem) return { refused: problem };
  const v = value.trim();
  const first = scanCssVars(css).find((d) => d.name === name);
  if (first) return { css: css.slice(0, first.start) + v + css.slice(first.end) };
  const sep = css.length === 0 || css.endsWith("\n") ? "" : "\n";
  return { css: `${css}${sep}:root { ${name}: ${v}; }\n` };
}
