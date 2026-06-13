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
//! # What this slice covers vs. defers
//!
//! Covered (B2 vector + text): solid-fill rectangles (backgrounds/borders),
//! solid-fill arbitrary paths (border-radius / non-rect boxes), solid
//! strokes, and single-line text runs → the matching C-1 items.
//!
//! Deferred (the honest ceiling — C-1's open stages / Tier-B), all COUNTED
//! and REPORTED by [`lower::LowerReport`], never faked:
//! gradients, raster/pattern image fills, blend modes, box shadows,
//! multi-run/bidi text shaping, and CSS fragmentation across linked frames.
//!
//! # The named next slice
//!
//! The pure lowering + capture sink compile + run today (native). The
//! remaining integration is the **bundle WASM artifact**: build THIS crate
//! to `wasm32-unknown-unknown` + `wasm-bindgen` into the manifest's
//! `bin/blitz_web.wasm`, register pinned faces (so text shapes on wasm),
//! and attach DOM run text to captured glyph runs. Integration point:
//! [`capture::render_html`] → [`lower::lower`]. See `scripts/build-wasm.sh`.

pub mod display_list;
pub mod lower;
pub mod wire;

#[cfg(feature = "blitz")]
pub mod capture;

pub use display_list::{UnsupportedKind, WebDisplayList, WebDrawCmd, WebGlyphRun};
pub use lower::{lower, LowerReport, Lowered};
pub use wire::{RectPt, SceneItem, SceneLayer, ScenePaint, ScenePathSeg, SceneTextItem};

/// The wasm entry point for the (future) bundle artifact. Behind `blitz`
/// (the only build that needs to expose a render to JS): takes HTML +
/// content-box size in CSS px, runs Blitz, lowers the paint, and returns
/// the C-1 `SceneLayer` as JSON — exactly the `{ items }` payload the
/// bundle submits via `host.contribute.sceneLayer().submit(...)`.
///
/// This is the seam the bundle's `renderWebFrame` drop-in calls once the
/// artifact is built (see `web-model/src/render.ts`). Until then the
/// bundle's TS render contract returns the honest not-loaded path.
#[cfg(all(feature = "blitz", target_arch = "wasm32"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn render_web_frame(html: &str, width_px: u32, height_px: u32) -> String {
    let lowered = capture::render_and_lower(html, width_px, height_px);
    serde_json::to_string(&lowered.layer).unwrap_or_else(|_| "{\"items\":[]}".to_string())
}
