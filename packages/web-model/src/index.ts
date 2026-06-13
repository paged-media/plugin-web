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

// The PASTE-INGEST enforcement twin of the linter — strips executable
// surface (<script>, on*= handlers, javascript: URLs) from HTML brought
// in from outside the editor (§6.1: page JavaScript never executes, so
// sanitize on ingest — don't just diagnose).
export {
  sanitizeHtml,
  type SanitizeRemoval,
  type SanitizeResult,
} from "./sanitize";

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

// The W-01 RENDER CONTRACT — the engine-agnostic seam (ADR-011: "HTML/CSS
// in, scene layer out"). Today `renderWebFrame` returns the HONEST
// not-loaded path; the Blitz/WASM lane drops in behind this contract. The
// SceneLayer types are the C-1 IR (filled paths + single-line text).
export {
  ENGINE_NOT_LOADED_MESSAGE,
  isRendered,
  renderWebFrame,
  type SceneItem,
  type SceneLayer,
  type ScenePaintRgba,
  type ScenePathItem,
  type SceneTextItem,
  type WebRenderRequest,
  type WebRenderResult,
} from "./render";

// Engine version PINNING — the determinism record (ADR-011). The pin is
// forward-declared from the W0 spike's proven stack and stamped into the
// source envelope so a future re-render is reproducible.
export {
  ENGINE_PIN,
  engineStamp,
  pinFromStamp,
  pinMatches,
  type EnginePin,
} from "./engine";
