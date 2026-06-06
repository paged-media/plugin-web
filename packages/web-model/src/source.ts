// The webFrame source model — the `x-paged-web:source` /
// `x-paged-web:options` shape from the concept paper (§5), pure and
// host-free. Until the engine grows namespaced plugin metadata on
// document objects (BREAKAGE_LOG W-02), the bundle persists this
// through plugin storage keyed by element id; the SHAPE is already
// the document-metadata shape, so the move is a storage swap, not a
// model change.

export interface WebFrameOptions {
  /** CSS media the frame renders under (§9: a DTP-native switch). */
  media: "print" | "screen";
  /** Overflow policy — v0 clips (the only honest option before the
   *  engine renders web frames on canvas). */
  overflow: "clip";
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

/** Storage key for an element's web source (one entry per frame). */
export function sourceKeyFor(element: FrameTarget): string {
  return `source.${element.kind}:${element.id}`;
}

/**
 * Compose the full document the preview iframe renders via
 * `srcdoc`. The iframe is sandboxed with NO permissions (scripts
 * cannot run — §6.1: page JavaScript never executes); the composed
 * document carries the source CSS in a single <style> and the
 * declared media as a class hook for future print/screen styling.
 */
export function composeSrcdoc(source: WebFrameSource): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<style>${source.css}</style>` +
    `</head><body class="media-${source.options.media}">` +
    source.html +
    "</body></html>"
  );
}
