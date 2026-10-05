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

//! Font registration for the engine (feature = "blitz").
//!
//! Parley/fontique has NO system-font discovery on `wasm32` (browsers do
//! not expose the system font collection), so without an explicitly
//! registered face text shapes to NOTHING — the W0 spike's documented
//! 22-vs-19 command delta (boxes paint, glyph runs don't). This module
//! closes that gap deterministically: it `include_bytes!`-bakes ONE
//! license-clean face (Inter, SIL OFL 1.1 — `assets/fonts/`) into the
//! crate and builds a Parley [`FontContext`] with system fonts OFF and
//! that face registered as the fallback for every generic family.
//!
//! The same context drives the NATIVE build too, so the capture +
//! recovery tests exercise REAL shaping (not the system-font path, which
//! is non-deterministic across CI hosts). C-1.1 reshapes every text run in
//! the DOCUMENT's default font on the page, so this face is a SHAPING
//! engine for layout/positions/run-text recovery — never the face the
//! reader finally sees. (That is also why one regular weight suffices: the
//! recovered geometry + plain text is what crosses the wire, not glyphs.)

use blitz_dom::FontContext;

/// The bundled fallback face — Inter Regular (SIL OFL 1.1). Baked into the
/// crate so the wasm engine ships a working text path with no host fonts.
/// License: `assets/fonts/OFL-Inter.txt`.
pub const INTER_REGULAR: &[u8] = include_bytes!("../assets/fonts/Inter.ttf");

/// The family name the bundled face registers under (Inter's `name`
/// table family). Surfaced as the recovered runs' `family` HINT.
pub const BUNDLED_FAMILY: &str = "Inter";

/// Build a Parley [`FontContext`] with system-font discovery disabled and
/// the bundled face registered as the fallback for every generic family —
/// the WASM-correct setup (mirrors `blitz_dom::build_single_font_ctx`,
/// which is the upstream "standard setup for WASM"). Used for BOTH the
/// native and wasm builds so shaping is deterministic.
///
/// Builds a FRESH context (decode + register the face) every call. The
/// render paths use [`font_ctx`], which builds once per engine thread.
pub fn build_font_ctx() -> FontContext {
    crate::perf::bump(crate::perf::Counter::FontContextBuilds, 1);
    blitz_dom::build_single_font_ctx(INTER_REGULAR)
}

thread_local! {
    /// The engine's font context, built on first use and kept for the
    /// thread's lifetime (the wasm engine is single-threaded, so this is
    /// once per engine instance).
    static FONT_CTX: FontContext = build_font_ctx();
}

/// The engine's font context: built ONCE per thread ([`build_font_ctx`]) and
/// handed to each document as a clone. A clone copies the collection's
/// family maps (the registered face's blob is shared, not re-decoded) and
/// shares the source cache, so a document registering its own faces never
/// touches the cached original.
pub fn font_ctx() -> FontContext {
    FONT_CTX.with(FontContext::clone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_face_is_a_non_trivial_truetype() {
        // sfnt/ttf: starts with the version tag 0x00010000 ("true"-ish) and
        // is the real Inter face (~860 KiB), not a stub.
        assert!(INTER_REGULAR.len() > 100_000, "font looks truncated");
        assert_eq!(
            &INTER_REGULAR[0..4],
            &[0x00, 0x01, 0x00, 0x00],
            "expected a TrueType sfnt header"
        );
    }

    #[test]
    fn builds_a_font_ctx_without_panicking() {
        // The context construction registers the face into a fresh,
        // system-fonts-off collection — the wasm-correct path.
        let _ctx = build_font_ctx();
    }

    #[test]
    fn the_cached_context_is_built_once_per_thread() {
        // A fresh thread, so the thread-local starts empty whatever ran here.
        std::thread::spawn(|| {
            crate::perf::reset_perf_counters();
            let _a = font_ctx();
            let _b = font_ctx();
            let expect = if crate::perf::ENABLED { 1 } else { 0 };
            assert_eq!(crate::perf::perf_counters().font_context_builds, expect);
        })
        .join()
        .unwrap();
    }
}
