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
//! registered face text shapes to NOTHING. This module bakes ONE
//! license-clean face (Inter, SIL OFL 1.1 — `assets/fonts/`, a variable
//! face with a weight axis) into the crate and builds a Parley
//! [`FontContext`] with system fonts OFF and that face registered as the
//! fallback for every generic family. The same context drives the native
//! build, so tests exercise real, deterministic shaping.
//!
//! The host adds faces with [`register_font`] (the `register_font` wasm
//! export): document fonts the asset store serves, and the faces a source's
//! `@font-face` rules name. They are registered ONCE into the engine's
//! context, which every render clones, so a bold run shapes in the bold face
//! and no render rebuilds the context. [`face_family`] answers the family a
//! shaped run's face is registered under, which crosses the wire so the
//! renderer can draw the run in that face.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use blitz_dom::FontContext;
use parley::fontique::{Blob, FontInfoOverride};
use peniko::FontData;

use crate::display_list::RunFace;
use crate::perf::{self, Counter};

/// The bundled fallback face — Inter (SIL OFL 1.1). Baked into the crate so
/// the wasm engine ships a working text path with no host fonts.
/// License: `assets/fonts/OFL-Inter.txt`.
pub const INTER_REGULAR: &[u8] = include_bytes!("../assets/fonts/Inter.ttf");

/// The family name the bundled face registers under (Inter's `name` table
/// family).
pub const BUNDLED_FAMILY: &str = "Inter";

/// Build a Parley [`FontContext`] with system-font discovery disabled and
/// the bundled face registered as the fallback for every generic family —
/// the WASM-correct setup (mirrors `blitz_dom::build_single_font_ctx`).
///
/// Builds a FRESH context (decode + register the face) every call. The
/// render paths use [`font_ctx`], which builds once per engine thread.
pub fn build_font_ctx() -> FontContext {
    perf::bump(Counter::FontContextBuilds, 1);
    let mut ctx = blitz_dom::build_single_font_ctx(INTER_REGULAR);
    // A family the source names but nobody registered (`Georgia`, a typo)
    // resolves to nothing, and Parley then shapes the run with NO face — the
    // text vanishes. A browser falls back to its default face; so does the
    // engine: the bundled face is the last-resort fallback for every script
    // it covers (and for text with no script of its own).
    if let Some(id) = ctx.collection.family_id(BUNDLED_FAMILY) {
        for script in FALLBACK_SCRIPTS {
            let key = parley::fontique::FallbackKey::new(
                parley::fontique::Script::from_bytes(**script),
                None,
            );
            ctx.collection.append_fallbacks(key, std::iter::once(id));
        }
    }
    ctx
}

/// The scripts the bundled face is the fallback for: what Inter covers, plus
/// Common / Inherited / Unknown.
const FALLBACK_SCRIPTS: &[&[u8; 4]] = &[b"Latn", b"Grek", b"Cyrl", b"Zyyy", b"Zinh", b"Zzzz"];

thread_local! {
    /// The engine's font context, built on first use and kept for the
    /// thread's lifetime (the wasm engine is single-threaded, so this is
    /// once per engine instance). [`register_font`] adds faces to it.
    static FONT_CTX: RefCell<FontContext> = RefCell::new(build_font_ctx());
    /// Content keys of the faces already registered (re-registering the same
    /// bytes under the same family is a no-op).
    static REGISTERED: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    /// The family each face blob is known by: the host's family for a
    /// registered face, else the face's own `name` table (memoised).
    static FAMILY_BY_BLOB: RefCell<HashMap<u64, Option<String>>> = RefCell::new(HashMap::new());
}

/// The engine's font context: built ONCE per thread ([`build_font_ctx`]) and
/// handed to each document as a clone. A clone copies the collection's
/// family maps (the registered faces' blobs are shared, not re-decoded) and
/// shares the source cache, so a document registering its own faces (its
/// `@font-face` rules) never touches the cached original.
pub fn font_ctx() -> FontContext {
    FONT_CTX.with(|c| c.borrow().clone())
}

/// FNV-1a over the face bytes and the family override — the idempotence key.
fn content_key(bytes: &[u8], family: Option<&str>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes.iter().chain(family.unwrap_or("").as_bytes()) {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Register a face (TrueType / OpenType / WOFF / WOFF2 bytes; a collection
/// registers every face in it) into the engine's font context, under
/// `family` when given (the name the source's CSS asks for — a document
/// font's family, an `@font-face` family) or the face's own family name.
/// Every later render shapes with it. Answers the family names registered,
/// empty when the bytes hold no face. Registering the same bytes under the
/// same family again does nothing and answers the same names.
pub fn register_font(bytes: &[u8], family: Option<&str>) -> Vec<String> {
    let family = family.map(str::trim).filter(|f| !f.is_empty());
    let key = content_key(bytes, family);
    let decoded = blitz_dom::decode_font_bytes(bytes).into_owned();
    let blob = Blob::new(Arc::new(decoded));
    let blob_id = blob.id();
    let fresh = REGISTERED.with(|r| r.borrow_mut().insert(key));
    let names: Vec<String> = FONT_CTX.with(|c| {
        let mut ctx = c.borrow_mut();
        if !fresh {
            return family.map(|f| vec![f.to_string()]).unwrap_or_default();
        }
        let over = FontInfoOverride {
            family_name: family,
            ..Default::default()
        };
        let registered = ctx.collection.register_fonts(blob, Some(over));
        let mut names: Vec<String> = Vec::new();
        for (id, _) in registered {
            if let Some(n) = ctx.collection.family_name(id) {
                if !names.iter().any(|x| x == n) {
                    names.push(n.to_string());
                }
            }
        }
        names
    });
    if fresh {
        perf::bump(Counter::FontRegistrations, 1);
        if names.is_empty() {
            // Nothing in the bytes was a face: forget the key so a corrected
            // retry is not swallowed.
            REGISTERED.with(|r| r.borrow_mut().remove(&key));
        } else {
            FAMILY_BY_BLOB.with(|m| {
                m.borrow_mut().insert(blob_id, names.first().cloned());
            });
        }
    }
    names
}

/// The family of the face a run was shaped with: the family the host
/// registered it under, else the face's own typographic family name (the
/// bundled face and a source's `@font-face` faces), memoised per blob.
pub fn face_family(font: &FontData) -> Option<String> {
    let id = font.data.id();
    if let Some(hit) = FAMILY_BY_BLOB.with(|m| m.borrow().get(&id).cloned()) {
        return hit;
    }
    let name = name_table_family(font.data.data(), font.index);
    FAMILY_BY_BLOB.with(|m| {
        m.borrow_mut().insert(id, name.clone());
    });
    name
}

/// The face a shaped run asked for: its CSS weight and slope (Parley's
/// matching attributes for the run), and its shaped advance in points.
pub fn run_face(run: &parley::Run<'_, blitz_dom::node::TextBrush>, advance_pt: f32) -> RunFace {
    let attrs = run.font_attrs();
    RunFace {
        weight: Some(attrs.weight.value()),
        italic: Some(!matches!(attrs.style, parley::fontique::FontStyle::Normal)),
        advance: Some(advance_pt),
    }
}

/// The typographic family (name id 16), else the family (name id 1), of the
/// face at `index` in `data`.
fn name_table_family(data: &[u8], index: u32) -> Option<String> {
    use skrifa::{string::StringId, FontRef, MetadataProvider};
    let font = FontRef::from_index(data, index).ok()?;
    [StringId::TYPOGRAPHIC_FAMILY_NAME, StringId::FAMILY_NAME]
        .into_iter()
        .find_map(|id| font.localized_strings(id).english_or_first())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
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
