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

// @paged-media/web-model — the webFrame source model + diagnostics,
// pure TS, zero dependencies, host-free. The distillation layer of
// paged.web (the same role draw-geometry/draw-tools play for
// paged.draw): no host, no DOM, no engine.

export {
  DEFAULT_SOURCE,
  LABEL_INLINE_MAX_BYTES,
  LABEL_MAX_BYTES,
  MAX_VIEWPORT_WIDTH,
  OVERFLOW_POLICIES,
  SOURCE_METADATA_VERSION,
  asFrameTarget,
  composeSrcdoc,
  contentHash,
  envelopeFor,
  isWebFrameEnvelope,
  sourceFromPartText,
  sourcePartPath,
  sourceRefOf,
  storeSource,
  utf8Length,
  flowChainOf,
  flowGroups,
  normalizeFlowChain,
  normalizeOverflow,
  normalizeTemplateVars,
  normalizeViewportWidth,
  sourceFromEnvelope,
  sourceKeyFor,
  withRecipient,
  withoutRecipient,
  type FrameTarget,
  type OverflowPolicy,
  type TemplateVars,
  type WebFlowChain,
  type WebFlowGroup,
  type WebFlowRecipient,
  type WebFrameOptions,
  type StoredSource,
  type WebFrameSource,
  type WebSourceEnvelope,
  type WebSourceRef,
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
// `.html` FILE intake → the panel's two lanes + the sanitize pass (the
// File▸Open / drag-drop importer's model half).
export { sourceFromHtmlFile, type HtmlFileImport } from "./import-html";

// Vetted, offline, dependency-free starter templates the insert/source
// panel seeds from — an empty frame is a poor first run. Each one's HTML
// passes `diagnoseHtml` with no errors (asserted in templates.spec.ts).
export {
  WEB_TEMPLATES,
  sourceFromTemplate,
  templateById,
  type WebTemplate,
} from "./templates";

// The source-side subset of click-to-inspect ("Find in source"): a tag-
// position scan exposing each opening tag's source range, so the panel
// can list tags and map a click to the editor selection. Full live
// element inspection awaits the Blitz render lane (W-01).
export { tagOutline, type TagOutlineEntry } from "./outline";

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

// The RENDER CONTRACT — the engine-agnostic seam (ADR-011: "HTML/CSS in,
// scene layer out"). `renderWebFrame` / `renderWebFlow` here are the
// fallback the bundle uses when its Blitz engine wasm cannot load (the
// honest not-loaded result); the loaded engine answers the same types.
// The SceneLayer types are the C-1 IR (filled paths, multi-run text, and
// axis-aligned raster images).
export {
  ENGINE_NOT_LOADED_MESSAGE,
  isFlowRendered,
  isRendered,
  renderWebFlow,
  renderWebFrame,
  scaleSceneLayer,
  type FlowId,
  type SceneImageItem,
  type SceneItem,
  type SceneLayer,
  type ScenePaintRgba,
  type ScenePathItem,
  type ScenePathSeg,
  type SceneTextItem,
  type WebFlowFrame,
  type WebFlowFrameResult,
  type WebRenderFlowRequest,
  type WebRenderFlowResult,
  type WebRenderRequest,
  type WebRenderResult,
} from "./render";

// CSS Regions SYNTAX (spec Phase 4) — `flow-into`/`flow-from`, parsed
// plugin-side (Stylo ignores them). `flowRootSelector` names the flow's
// content root the engine flows across the chain.
export {
  flowRootSelector,
  flowSelectorFor,
  flowThreadOptions,
  namedFlowDiagnostics,
  parseFlowFrom,
  parseFlowInto,
  type FlowThreadOption,
  type NamedFlowRule,
} from "./css-flow";

// Engine version PINNING — the determinism record (ADR-011, ADR 401),
// stamped into the source envelope so a re-render is reproducible.
export {
  ENGINE_PIN,
  engineStamp,
  pinFromStamp,
  pinMatches,
  type EnginePin,
} from "./engine";
