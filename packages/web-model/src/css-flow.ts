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

// CSS Regions SYNTAX (spec Phase 4) — `flow-into` / `flow-from`. Stylo/Blitz
// do not implement these (deprecated) properties, so the plugin parses them
// itself and drives the flow from them. This is a SCANNER (like diagnose.ts),
// not a real CSS parser: it matches flat `selector { … }` rule blocks and
// never throws. It recognises the syntax + names the flow's content root; the
// engine flows that root's content across the frame chain (single-named-flow
// MVP — the first `flow-into` rule wins).

import type { WebDiagnostic } from "./diagnose";

/** One `flow-into` / `flow-from` rule: the rule's selector + the flow name. */
export interface NamedFlowRule {
  selector: string;
  name: string;
}

/** Scan a stylesheet for `<prop>: <name>` rules (`prop` = `flow-into` /
 *  `flow-from`), returning each rule's selector + flow name in source order.
 *  `<name>` of `none` is skipped (the initial value = not flowed). Never
 *  throws; ignores at-rules / nesting (flat block match). */
function scanFlowProp(css: string, prop: string): NamedFlowRule[] {
  const out: NamedFlowRule[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  const decl = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([A-Za-z_][\\w-]*)`, "i");
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css)) !== null) {
    const d = decl.exec(m[2]);
    if (d && d[1].toLowerCase() !== "none") {
      out.push({ selector: m[1].trim(), name: d[1] });
    }
  }
  return out;
}

/** The `flow-into` rules in a stylesheet (content pulled into a named flow). */
export function parseFlowInto(css: string): NamedFlowRule[] {
  return scanFlowProp(css, "flow-into");
}

/** One flow a source offers to thread into — the panel flow picker's model. */
export interface FlowThreadOption {
  /** The flow name to pass to `threadSelectedIntoFlow(host, flowName?)`:
   *  `undefined` for the PRIMARY flow (its recipients ride UNTAGGED, per
   *  `flowGroups`), the declared name for a secondary flow. */
  flowName: string | undefined;
  /** The flow's declared name, for display (same string for primary + named). */
  name: string;
  /** Whether this is the primary (first-declared) flow. */
  primary: boolean;
}

/**
 * The pick-list of flows a source declares — one option per DISTINCT
 * `flow-into` name, in source order. The FIRST declared flow is the primary
 * (recipients ride it untagged → `flowName: undefined`); each later name is a
 * secondary flow (`flowName` = its name). This is what makes an arbitrary
 * named flow (the 3rd, 4th, …) reachable: `threadWebFlow` only hits the
 * primary and `threadWebFlowNamed` only the 2nd, but the picker offers them
 * all. Empty when the source declares no `flow-into` (no picker shown). Pure.
 */
export function flowThreadOptions(css: string): FlowThreadOption[] {
  const rules = parseFlowInto(css);
  const seen = new Set<string>();
  const out: FlowThreadOption[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    const name = rules[i].name;
    if (seen.has(name)) continue; // a name repeated across selectors = one flow
    seen.add(name);
    out.push({ flowName: i === 0 ? undefined : name, name, primary: i === 0 });
  }
  return out;
}

/** The `flow-from` rules in a stylesheet (DOM regions receiving a named flow).
 *  In paged.web the recipients are usually publication FRAMES (the host chain),
 *  so DOM `flow-from` is informational — surfaced via {@link namedFlowDiagnostics}. */
export function parseFlowFrom(css: string): NamedFlowRule[] {
  return scanFlowProp(css, "flow-from");
}

/**
 * The selector of the FIRST `flow-into` rule — the flow's content ROOT that the
 * engine flows across the frame chain (single-named-flow MVP). `undefined` =
 * no `flow-into`, so the whole `<body>` flows.
 */
export function flowRootSelector(css: string): string | undefined {
  return parseFlowInto(css)[0]?.selector;
}

/**
 * The flow-into selector for a given flow NAME (CSS multi-flow). `""` = the
 * primary flow → the first `flow-into` rule's selector (or `undefined` = the
 * whole body). A named flow → the `flow-into` rule declaring that name.
 * `undefined` when no such rule exists (the group then flows the whole body).
 */
export function flowSelectorFor(css: string, name: string): string | undefined {
  const rules = parseFlowInto(css);
  if (name === "") return rules[0]?.selector;
  return rules.find((r) => r.name === name)?.selector;
}

/**
 * Honest diagnostics for the CSS Regions syntax the source uses: which content
 * flows where, and what the MVP does NOT yet do (multiple named flows; DOM
 * `flow-from` regions — recipients are the host frame chain). Never throws.
 */
export function namedFlowDiagnostics(css: string): WebDiagnostic[] {
  const into = parseFlowInto(css);
  const from = parseFlowFrom(css);
  if (into.length === 0 && from.length === 0) return [];

  const out: WebDiagnostic[] = [];
  const names = new Set(into.map((r) => r.name));

  if (into.length > 0) {
    const first = into[0];
    out.push({
      severity: "info",
      message: `CSS Regions: '${first.selector}' flows into '${first.name}' across the frame chain`,
      source: "css",
    });
  }
  if (names.size > 1) {
    out.push({
      severity: "info",
      message: `multiple named flows (${[...names].join(", ")}); thread frames into any of them via the Web frame panel's flow picker`,
      source: "css",
    });
  }
  for (const r of from) {
    out.push({
      severity: "info",
      message: `flow-from '${r.name}' on '${r.selector}' — DOM regions are not used; the frame chain receives the flow`,
      source: "css",
    });
  }
  return out;
}
