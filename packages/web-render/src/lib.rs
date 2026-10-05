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

//! web-render — paged.web's Blitz → C-1 SceneLayer lowering lane.
//!
//! ADR-011 Option B: **"HTML/CSS in, scene layer out"** — lower Blitz's
//! paint/display output to the plugin `sceneLayer` IR (filled paths +
//! single-line text runs) that core composes inside the frame under
//! `ItemTransform` + content-box clip. NOT a bespoke core paint hook; the
//! engine lives entirely in the plugin, behind the platform boundary.
//!
//! # Layers
//!
//! - [`wire`] — the C-1 `SceneLayer` IR (the exact JSON core consumes /
//!   the bundle submits). Pure, always built.
//! - [`display_list`] — [`display_list::WebDisplayList`], the captured paint
//!   in content points. Pure, no Blitz — the boundary type.
//! - [`lower`] — **the core deliverable**: `WebDisplayList -> SceneLayer`,
//!   a pure total function + coverage report, unit-tested on hand-built
//!   display lists. Always built.
//! - [`capture`] *(feature = `blitz`)* — the `PaintScene` sink that records
//!   real Blitz paint into a `WebDisplayList`, + `render_html`. The
//!   engine-coupled half; opt-in.
//!
//! # What lowers today
//!
//! Solid-fill rectangles (backgrounds/borders), solid-fill arbitrary paths
//! (border-radius / non-rect boxes), solid strokes, multi-run text (one C-1
//! `text` item per Parley run, transform-correct), axis-aligned raster
//! images (straight RGBA8 → the C-1 `image` item), linear/radial/conic
//! gradient fills, solid `mix-blend-mode` fills and outset/inset shadows.
//!
//! Not lowered, COUNTED and REPORTED by [`lower::LowerReport`], never faked:
//! image/pattern brushes, gradient text, rotated/sheared image destinations
//! (no per-image transform on the wire), the CSS `spread` of inset shadows,
//! and gradient/image fills inside a blend layer. Text runs carry a family
//! HINT only: core redraws scene text in the document's default face.
//!
//! # Entry points
//!
//! The bundle's engine artifact (`scripts/build-wasm.sh --engine`) exports
//! `render_web_frame` (one frame) and `render_web_flow` (one flow threaded
//! across a frame chain, see [`flow`]); both take strings and answer JSON
//! (ADR 403). `engine_source_hash` answers the hash of the sources the
//! artifact was built from, so the bundle's test suite can refuse a stale one.

pub mod display_list;
pub mod lower;
pub mod wire;

#[cfg(feature = "blitz")]
pub mod capture;

#[cfg(feature = "blitz")]
pub mod fonts;

// Flow fragmentation — one flow across a frame chain (ADR 404). Behind
// `blitz`; see docs/design/flow-fragmentation.md.
#[cfg(feature = "blitz")]
pub mod flow;

pub use display_list::{
    LocalKey, UnsupportedKind, WebBlendMode, WebDisplayList, WebDrawCmd, WebGlyphRun, WebGradient,
    WebGradientStop, WebImage,
};
pub use lower::{lower, LowerReport, Lowered};
pub use wire::{
    RectPt, SceneBlendMode, SceneGradient, SceneGradientStop, SceneItem, SceneLayer, ScenePaint,
    ScenePathSeg, SceneTextItem,
};

/// The wasm entry point for one frame. Behind `blitz` (the only build that
/// exposes a render to JS): takes HTML + content-box size in CSS px, runs
/// Blitz, lowers the paint, and returns the C-1 `SceneLayer` as JSON —
/// exactly the `{ items }` payload the bundle submits via
/// `host.contribute.sceneLayer().submit(...)`.
#[cfg(all(feature = "blitz", target_arch = "wasm32"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn render_web_frame(html: &str, width_px: u32, height_px: u32) -> String {
    let lowered = capture::render_and_lower(html, width_px, height_px);
    serde_json::to_string(&lowered.layer).unwrap_or_else(|_| "{\"items\":[]}".to_string())
}

/// The wasm entry for a THREADED web flow (ADR-020 scoped extension, rung 2).
/// `frames_json` is `[{"widthPx":N,"heightPx":M}, …]` in chain order; returns
/// `flow::FlowWire` as JSON — one lowered C-1 `SceneLayer` per frame plus the
/// flow `overset`. The bundle submits each layer to its frame via
/// `host.contribute.sceneLayer().submit(frameId, layer)`.
#[cfg(all(feature = "blitz", target_arch = "wasm32"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn render_web_flow(html: &str, frames_json: &str, flow_root: &str) -> String {
    // `flow_root` is a CSS `flow-into` selector (Regions syntax) or "" for the
    // whole body.
    flow::render_web_flow_json(html, frames_json, flow_root)
}

/// The hash of the sources this wasm was built from (`scripts/source-hash.mjs`,
/// stamped by `scripts/build-wasm.sh` through `WEB_RENDER_SOURCE_HASH`). Empty
/// for a build that bypassed the script. The bundle's `wasm-fresh.spec.ts`
/// compares it with the checkout so a stale artifact is never tested.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn engine_source_hash() -> String {
    option_env!("WEB_RENDER_SOURCE_HASH")
        .unwrap_or_default()
        .to_string()
}
