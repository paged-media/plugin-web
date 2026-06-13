// @paged-media/web-model — the webFrame source model + diagnostics,
// pure TS, zero dependencies, host-free. The distillation layer of
// paged.web (the same role draw-geometry/draw-tools play for
// paged.draw): everything here survives unchanged when the engine
// rendering lane (Blitz/WASM, concept §4) and document metadata
// (§5) land.

export {
  DEFAULT_SOURCE,
  MAX_VIEWPORT_WIDTH,
  SOURCE_METADATA_VERSION,
  asFrameTarget,
  composeSrcdoc,
  envelopeFor,
  normalizeTemplateVars,
  normalizeViewportWidth,
  sourceFromEnvelope,
  sourceKeyFor,
  type FrameTarget,
  type TemplateVars,
  type WebFrameOptions,
  type WebFrameSource,
  type WebSourceEnvelope,
} from "./source";

export { diagnoseHtml, type WebDiagnostic } from "./diagnose";

export {
  composeFontFaces,
  diagnoseFonts,
  familiesUsed,
  fontFaceDataUrl,
  fontParity,
  type FontParity,
  type ResolvedFontFace,
} from "./fonts";

// The §6.2 DETERMINISTIC slice — a pure template-variable pass between
// source and preview/persist. The scripted (Boa) transform lane is the
// W2 follow-on (RFI W-08); see transform.ts's seam comment.
export {
  applyTemplate,
  renderWebFrameSource,
  TEMPLATE_FILTERS,
  type RenderedWebFrame,
  type TemplateFilter,
  type TemplateResult,
} from "./transform";
