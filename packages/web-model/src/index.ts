// @paged-media/web-model — the webFrame source model + diagnostics,
// pure TS, zero dependencies, host-free. The distillation layer of
// paged.web (the same role draw-geometry/draw-tools play for
// paged.draw): everything here survives unchanged when the engine
// rendering lane (Blitz/WASM, concept §4) and document metadata
// (§5) land.

export {
  DEFAULT_SOURCE,
  SOURCE_METADATA_VERSION,
  asFrameTarget,
  composeSrcdoc,
  envelopeFor,
  sourceFromEnvelope,
  sourceKeyFor,
  type FrameTarget,
  type WebFrameOptions,
  type WebFrameSource,
  type WebSourceEnvelope,
} from "./source";

export { diagnoseHtml, type WebDiagnostic } from "./diagnose";
