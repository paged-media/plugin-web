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

//! The bodies of the wasm exports, native-callable so the perf budgets count
//! exactly what the boundary carries (bytes in / bytes out), plus the
//! `perf-counters`-only exports that read and reset the counters from JS.

use std::cell::RefCell;

use crate::perf::{self, Counter};

thread_local! {
    /// The shaped advance of every text item of the last render, one list per
    /// layer (one for a frame, one per frame for a flow) — read once by
    /// [`take_text_advances_json`].
    static TEXT_ADVANCES: RefCell<Vec<Vec<f32>>> = const { RefCell::new(Vec::new()) };
}

/// Record the last render's text advances (see [`take_text_advances_json`]).
pub fn set_text_advances(advances: Vec<Vec<f32>>) {
    TEXT_ADVANCES.with(|t| *t.borrow_mut() = advances);
}

/// The body of the `take_text_advances` export: the last render's text-item
/// advances in content points as JSON (`[[a, …], …]`, one list per layer, in
/// item order), then forgotten. The bake sizes a native text frame from it:
/// the run's width in the face it was shaped with, not a host re-measure in
/// another face. Not part of the render's own output, so a render that is
/// not baked carries no extra bytes.
pub fn take_text_advances_json() -> String {
    let all = TEXT_ADVANCES.with(|t| std::mem::take(&mut *t.borrow_mut()));
    serde_json::to_string(&all).unwrap_or_else(|_| "[]".to_string())
}

/// The body of the `register_font` export (see [`crate::fonts::register_font`]):
/// answers the registered family names as JSON.
pub fn register_font_json(bytes: &[u8], family: &str) -> String {
    perf::bump(Counter::BytesIn, (bytes.len() + family.len()) as u64);
    let names = crate::fonts::register_font(bytes, Some(family));
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string())
}

/// The body of the `register_resource` export (see
/// [`crate::resources::register_resource`]).
pub fn register_resource_bytes(url: &str, bytes: &[u8]) {
    perf::bump(Counter::BytesIn, (url.len() + bytes.len()) as u64);
    crate::resources::register_resource(url, bytes);
}

/// The body of the `take_resource_misses` export: the URLs the last render
/// could not load, as JSON.
pub fn take_resource_misses_json() -> String {
    serde_json::to_string(&crate::resources::take_resource_misses())
        .unwrap_or_else(|_| "[]".to_string())
}

/// The body of the `render_web_frame` export: HTML + content-box size in CSS
/// px in, the lowered C-1 `SceneLayer` JSON out.
pub fn render_web_frame_json(html: &str, width_px: u32, height_px: u32) -> String {
    perf::bump(Counter::BytesIn, html.len() as u64);
    let lowered = crate::capture::render_and_lower(html, width_px, height_px);
    set_text_advances(vec![lowered.text_advances.clone()]);
    let out =
        serde_json::to_string(&lowered.layer).unwrap_or_else(|_| "{\"items\":[]}".to_string());
    perf::bump(Counter::BytesOut, out.len() as u64);
    out
}

/// The body of the `render_web_flow` export (see
/// [`crate::flow::render_web_flow_json`]).
pub fn render_web_flow_boundary_json(html: &str, frames_json: &str, flow_root: &str) -> String {
    perf::bump(
        Counter::BytesIn,
        (html.len() + frames_json.len() + flow_root.len()) as u64,
    );
    let out = crate::flow::render_web_flow_json(html, frames_json, flow_root);
    perf::bump(Counter::BytesOut, out.len() as u64);
    out
}

/// The engine's work counters as JSON (`{"htmlParses":N,…}`) — only in the
/// counting wasm (`scripts/build-wasm-perf.sh`), never the shipped one.
#[cfg(all(feature = "perf-counters", target_arch = "wasm32"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn perf_counters() -> String {
    perf::perf_counters().to_json()
}

/// Zero the work counters — only in the counting wasm.
#[cfg(all(feature = "perf-counters", target_arch = "wasm32"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn perf_counters_reset() {
    perf::reset_perf_counters();
}
