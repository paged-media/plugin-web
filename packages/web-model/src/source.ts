// The webFrame source model — the concept paper's §5 shape, pure and
// host-free. Since core protocol v33 (W-02 carrier) the source
// persists as DOCUMENT METADATA — an `x-paged:paged.web` Label entry
// that round-trips IDML and survives foreign opens; the envelope
// helpers below are the bundle's single (de)serialization point.
// `sourceKeyFor` remains for the one-time legacy-storage migration
// and as the diagnostics key.

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

export interface WebFrameSource {
  html: string;
  css: string;
  options: WebFrameOptions;
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

/** Wrap a source for `host.document.setMetadata`. */
export function envelopeFor(source: WebFrameSource): WebSourceEnvelope {
  return { v: SOURCE_METADATA_VERSION, data: { ...source } };
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
  return { html: d.html, css: d.css, options };
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
