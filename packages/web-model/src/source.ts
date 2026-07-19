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

// The webFrame source model — the concept paper's §5 shape, pure and
// host-free. Since core protocol v33 (W-02 carrier) the source
// persists as DOCUMENT METADATA — an `x-paged:paged.web` Label entry
// that round-trips IDML and survives foreign opens; the envelope
// helpers below are the bundle's single (de)serialization point.
// `sourceKeyFor` remains for the one-time legacy-storage migration
// and as the diagnostics key.

import { engineStamp } from "./engine";

export interface WebFrameOptions {
  /** CSS media the frame renders under (§9: a DTP-native switch). */
  media: "print" | "screen";
  /** Overflow policy — v0 clips (the only honest option before the
   *  engine renders web frames on canvas). */
  overflow: "clip";
  /** Layout viewport width in CSS px. Absent = natural width (the
   *  frame/panel decides). In the source panel this is honestly real:
   *  the preview IFRAME takes this width, and an iframe's element size
   *  IS the CSS viewport its content lays out (and media-queries)
   *  against. Declarative for the engine rendering lane too (W0). */
  viewportWidth?: number;
}

/** Upper bound a viewport width is clamped to — guards malformed
 *  envelopes (and runaway typing) without being opinionated about
 *  real device/print widths. */
export const MAX_VIEWPORT_WIDTH = 10000;

/** Sanitize a viewport width from UNTRUSTED input (an envelope, a
 *  number field): any positive finite number rounds to an int and
 *  clamps to `MAX_VIEWPORT_WIDTH`; everything else (strings, NaN,
 *  Infinity, zero/negative) reads as "no override" (undefined). */
export function normalizeViewportWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const w = Math.round(value);
  if (w < 1) return undefined;
  return Math.min(w, MAX_VIEWPORT_WIDTH);
}

/** Template variables for the deterministic pre-render pass (§6.2's
 *  honest W1 slice — see `transform.ts`). Plain string→string: values
 *  are substituted into `{{name}}` placeholders. ABSENT = the pass is
 *  disabled (existing documents are untouched); PRESENT (even empty)
 *  = the pass runs and unknown placeholders get diagnostics. */
export type TemplateVars = Record<string, string>;

/** Sanitize a template-vars map from UNTRUSTED input (an envelope):
 *  a plain object whose string entries are kept and finite-number
 *  entries are stringified; everything else (arrays, null, non-object,
 *  nested values) reads as "no vars" / a dropped entry. Never throws. */
export function normalizeTemplateVars(
  value: unknown,
): TemplateVars | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: TemplateVars = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    // anything else: drop the entry, keep the map.
  }
  return out;
}

/** One recipient frame in a flow chain: a {@link FrameTarget} plus an
 *  optional CSS `flow-into` name (Regions MULTI-flow). Absent `flow` = the
 *  primary/default flow (the whole body, or the first `flow-into`). A named
 *  `flow` routes this frame to that named flow's content. */
export interface WebFlowRecipient extends FrameTarget {
  flow?: string;
}

/** A web frame's threaded FLOW chain (ADR-020 rung 2): the ORDERED recipient
 *  frames the source's content threads into. The source frame is implicit
 *  order 0 of the PRIMARY flow (it is NOT listed in `recipients`). Recipients
 *  may carry a `flow` name to route them to a named CSS flow (multi-flow);
 *  untagged recipients belong to the primary flow. Each recipient is a
 *  `{ kind, id }` (both strings) — enough to reconstruct the host `ElementId`
 *  at render time — while web-model stays dependency-free. Absent = a
 *  single-frame web frame. */
export interface WebFlowChain {
  recipients: WebFlowRecipient[];
}

/** One resolved flow group: a flow name (`""` = primary) + its ordered
 *  frames (the primary group starts with the source frame). */
export interface WebFlowGroup {
  name: string;
  frames: FrameTarget[];
}

/** Sanitize a flow chain from UNTRUSTED input (an envelope): a
 *  `{ recipients: FrameTarget[] }` whose recipients are well-formed
 *  `{ kind, id }` pairs (both non-empty strings), DE-DUPLICATED by `id`
 *  in order; anything else (non-object, non-array recipients, malformed
 *  entries, empty result) reads as "no chain" (undefined). Never throws. */
export function normalizeFlowChain(value: unknown): WebFlowChain | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = (value as { recipients?: unknown }).recipients;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const recipients: WebFlowRecipient[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const { kind, id, flow } = r as {
      kind?: unknown;
      id?: unknown;
      flow?: unknown;
    };
    if (
      typeof kind === "string" &&
      kind.length > 0 &&
      typeof id === "string" &&
      id.length > 0 &&
      !seen.has(id)
    ) {
      seen.add(id);
      const rec: WebFlowRecipient = { kind, id };
      if (typeof flow === "string" && flow.length > 0) rec.flow = flow;
      recipients.push(rec);
    }
  }
  return recipients.length > 0 ? { recipients } : undefined;
}

export interface WebFrameSource {
  html: string;
  css: string;
  options: WebFrameOptions;
  /** §6.2 deterministic slice — template variables for the pre-render
   *  pass. ADDITIVE-OPTIONAL within envelope v1 (legacy envelopes have
   *  none; the pass only runs when the map is present). The full
   *  Boa-scripted transform lane is the W2 follow-on (RFI W-08). */
  vars?: TemplateVars;
  /** ADR-020 rung 2 — the persisted flow region chain (the ordered
   *  recipient frames this source threads into). ADDITIVE-OPTIONAL within
   *  envelope v1: legacy/single-frame web frames have none; a malformed
   *  chain reads as "not threaded" rather than poisoning the source. */
  flow?: WebFlowChain;
}

export const DEFAULT_SOURCE: WebFrameSource = {
  html: '<h1>Web frame</h1>\n<p>Authored as HTML/CSS, placed on the page.</p>',
  css:
    'h1 { font: 600 18px/1.2 "IBM Plex Sans", sans-serif; margin: 0 0 6px; }\n' +
    'p  { font: 13px/1.45 "IBM Plex Sans", sans-serif; margin: 0; }',
  options: { media: "print", overflow: "clip" },
};

/** A frame-like element a web source can attach to — `ElementId` is
 *  a union that also carries structured ids (story ranges); web
 *  frames only ever target string-id page items. */
export interface FrameTarget {
  kind: string;
  id: string;
}

/** Narrow an `ElementId`-shaped value to a frame target, or null. */
export function asFrameTarget(element: {
  kind: string;
  id: unknown;
}): FrameTarget | null {
  return typeof element.id === "string"
    ? { kind: element.kind, id: element.id }
    : null;
}

/** Legacy storage key (pre-v33) — still the diagnostics key, and the
 *  read side of the one-time storage→metadata migration. */
export function sourceKeyFor(element: FrameTarget): string {
  return `source.${element.kind}:${element.id}`;
}

/** The plugin's metadata version for the source envelope. Bump on
 *  shape changes; migrations are plugin-owned (facility §2). */
export const SOURCE_METADATA_VERSION = 1;

/** Structural twin of the host's `PluginMetadataEnvelope` — kept
 *  local so this package stays dependency-free. */
export interface WebSourceEnvelope {
  v: number;
  data: Record<string, unknown>;
  engine?: Record<string, string>;
}

/** Wrap a source for `host.document.setMetadata`. Stamps the pinned
 *  web-engine stack into the envelope's `engine` record (ADR-011
 *  determinism — a re-render can detect when the document was last
 *  rendered under an older stack). The stamp is forward-declared today
 *  (the engine isn't built); recording it now keeps the door honest. */
export function envelopeFor(source: WebFrameSource): WebSourceEnvelope {
  return {
    v: SOURCE_METADATA_VERSION,
    data: { ...source },
    engine: engineStamp(),
  };
}

/** Unwrap + validate a `getMetadata` envelope. Unknown versions and
 *  malformed payloads read as "not a web frame" (null) rather than
 *  guessing — the convert affordance then offers a fresh start. */
export function sourceFromEnvelope(
  envelope: WebSourceEnvelope | null,
): WebFrameSource | null {
  if (!envelope || envelope.v !== SOURCE_METADATA_VERSION) return null;
  const d = envelope.data as Partial<WebFrameSource>;
  if (typeof d.html !== "string" || typeof d.css !== "string") return null;
  const media = d.options?.media === "screen" ? "screen" : "print";
  const options: WebFrameOptions = { media, overflow: "clip" };
  // `viewportWidth` is ADDITIVE-OPTIONAL within envelope v1: legacy
  // envelopes simply have none, and an invalid value reads as "no
  // override" rather than poisoning the whole source.
  const viewportWidth = normalizeViewportWidth(d.options?.viewportWidth);
  if (viewportWidth !== undefined) options.viewportWidth = viewportWidth;
  const source: WebFrameSource = { html: d.html, css: d.css, options };
  // `vars` is ADDITIVE-OPTIONAL within envelope v1 too (the §6.2
  // template slice): legacy envelopes have none; a malformed map reads
  // as "no vars" (pass disabled) rather than poisoning the source.
  if ("vars" in d) {
    const vars = normalizeTemplateVars(d.vars);
    if (vars !== undefined) source.vars = vars;
  }
  // `flow` is ADDITIVE-OPTIONAL within envelope v1 (ADR-020 rung 2): legacy
  // / single-frame web frames have none; a malformed chain reads as "not
  // threaded" rather than poisoning the source.
  if ("flow" in d) {
    const flow = normalizeFlowChain(d.flow);
    if (flow !== undefined) source.flow = flow;
  }
  return source;
}

/** The PRIMARY flow chain for a source anchored on `sourceFrame`:
 *  `[sourceFrame, ...untagged recipients]` (recipients routed to a NAMED flow
 *  are excluded — see {@link flowGroups}). For a non-threaded source this is
 *  just `[sourceFrame]`. */
export function flowChainOf(
  source: WebFrameSource,
  sourceFrame: FrameTarget,
): FrameTarget[] {
  const primary = (source.flow?.recipients ?? []).filter((r) => !r.flow);
  return [sourceFrame, ...primary.map((r) => ({ kind: r.kind, id: r.id }))];
}

/** All flow groups for a source, keyed by flow name (`""` = primary, whose
 *  frames start with the source frame). Recipients routed to a named CSS flow
 *  form their own groups. Used by the multi-flow render. */
export function flowGroups(
  source: WebFrameSource,
  sourceFrame: FrameTarget,
): WebFlowGroup[] {
  const groups = new Map<string, FrameTarget[]>();
  groups.set("", [{ kind: sourceFrame.kind, id: sourceFrame.id }]);
  for (const r of source.flow?.recipients ?? []) {
    const name = r.flow ?? "";
    const arr = groups.get(name) ?? [];
    arr.push({ kind: r.kind, id: r.id });
    groups.set(name, arr);
  }
  return [...groups.entries()].map(([name, frames]) => ({ name, frames }));
}

/** Return a source with `recipient` appended to its flow chain, optionally
 *  routed to the named flow `flow` (CSS multi-flow). No-op if it is already a
 *  recipient (by id) or equals the source frame (a frame never threads into
 *  itself). Pure — returns a NEW source; the caller persists it. */
export function withRecipient(
  source: WebFrameSource,
  sourceFrame: FrameTarget,
  recipient: FrameTarget,
  flow?: string,
): WebFrameSource {
  if (recipient.id === sourceFrame.id) return source;
  const current = source.flow?.recipients ?? [];
  if (current.some((r) => r.id === recipient.id)) return source;
  const rec: WebFlowRecipient = { kind: recipient.kind, id: recipient.id };
  if (flow) rec.flow = flow;
  return { ...source, flow: { recipients: [...current, rec] } };
}

/** Return a source with the recipient identified by `recipientId` removed
 *  from its flow chain (the `flow` field is dropped entirely when the last
 *  recipient goes). Pure. */
export function withoutRecipient(
  source: WebFrameSource,
  recipientId: string,
): WebFrameSource {
  const current = source.flow?.recipients ?? [];
  if (!current.some((r) => r.id === recipientId)) return source;
  const recipients = current.filter((r) => r.id !== recipientId);
  const next: WebFrameSource = { ...source };
  if (recipients.length > 0) next.flow = { recipients };
  else delete next.flow;
  return next;
}

/**
 * Compose the full document the preview iframe renders via
 * `srcdoc`. The iframe is sandboxed with NO permissions (scripts
 * cannot run — §6.1: page JavaScript never executes); the composed
 * document carries the source CSS in a single <style> and the
 * declared media as a class hook for future print/screen styling.
 *
 * W-06: an optional `fontFaceCss` prelude (composed by
 * `composeFontFaces` from the asset store's served bytes) lands FIRST
 * in the <style>, so the preview uses the DOCUMENT's actual faces
 * before the source CSS references them. It is plain `@font-face` CSS
 * with object-URL `src` — NO script, so `sandbox=""` is unchanged.
 */
export function composeSrcdoc(
  source: WebFrameSource,
  fontFaceCss = "",
): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<style>${fontFaceCss}${source.css}</style>` +
    `</head><body class="media-${source.options.media}">` +
    source.html +
    "</body></html>"
  );
}
