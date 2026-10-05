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

//! Work counters — the numbers the perf budgets stand on.
//!
//! A render's cost is not a duration (that moves with the machine) but the
//! WORK it does: how many times the HTML is parsed, the document is
//! style/layout-resolved, a paint is captured, how many draw commands that
//! paint produced, how many run-match comparisons text recovery spent, how
//! many font contexts were built, and how many bytes crossed the wasm
//! boundary. Those counts are the same on every machine, so a budget can pin
//! them exactly and an optimisation can lower them provably.
//!
//! With the `perf-counters` feature OFF (the shipped build) every
//! [`bump`] is an empty `#[inline(always)]` function — the call sites
//! compile to nothing. With it ON the counts live in a THREAD-LOCAL table, so
//! parallel test threads each see only their own work.

/// One counted kind of work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum Counter {
    /// `HtmlDocument::from_html` calls (one full HTML parse each).
    HtmlParses = 0,
    /// `doc.resolve` calls (one full style + layout pass each).
    Resolves,
    /// Paint captures (`capture_resolved`: one `paint_scene` each).
    PaintCaptures,
    /// Draw commands recorded across every paint capture.
    PaintedCommands,
    /// Recovered-run candidates examined by `attach_run_texts` (the inner
    /// loop of run matching — quadratic in runs today).
    RunMatchComparisons,
    /// Parley font contexts built (`fonts::build_font_ctx`).
    FontContextBuilds,
    /// Bytes handed INTO the wasm exports (HTML + frames JSON + selector).
    BytesIn,
    /// Bytes returned OUT of the wasm exports (the JSON result).
    BytesOut,
    /// Faces newly registered into the engine's font context
    /// (`fonts::register_font`; a repeat registration is not counted).
    FontRegistrations,
    /// Sub-resources (images, stylesheets, `@font-face` sources) the resource
    /// provider served to a document.
    ResourceFetches,
    /// The part of `BytesOut` that carries text faces (the `weight` /
    /// `italic` fields of non-regular runs) — budgeted on its own so the
    /// pre-face output budgets stay pinned.
    FaceBytesOut,
}

impl Counter {
    /// Every counter, in table order.
    pub const ALL: [Counter; 11] = [
        Counter::HtmlParses,
        Counter::Resolves,
        Counter::PaintCaptures,
        Counter::PaintedCommands,
        Counter::RunMatchComparisons,
        Counter::FontContextBuilds,
        Counter::BytesIn,
        Counter::BytesOut,
        Counter::FontRegistrations,
        Counter::ResourceFetches,
        Counter::FaceBytesOut,
    ];

    /// The camelCase name the JSON export (and the TS side) uses.
    pub const fn name(self) -> &'static str {
        match self {
            Counter::HtmlParses => "htmlParses",
            Counter::Resolves => "resolves",
            Counter::PaintCaptures => "paintCaptures",
            Counter::PaintedCommands => "paintedCommands",
            Counter::RunMatchComparisons => "runMatchComparisons",
            Counter::FontContextBuilds => "fontContextBuilds",
            Counter::BytesIn => "bytesIn",
            Counter::BytesOut => "bytesOut",
            Counter::FontRegistrations => "fontRegistrations",
            Counter::ResourceFetches => "resourceFetches",
            Counter::FaceBytesOut => "faceBytesOut",
        }
    }
}

const N: usize = Counter::ALL.len();

/// A snapshot of every counter.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PerfCounters {
    pub html_parses: u64,
    pub resolves: u64,
    pub paint_captures: u64,
    pub painted_commands: u64,
    pub run_match_comparisons: u64,
    pub font_context_builds: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub font_registrations: u64,
    pub resource_fetches: u64,
    pub face_bytes_out: u64,
}

impl PerfCounters {
    fn from_table(t: [u64; N]) -> Self {
        PerfCounters {
            html_parses: t[Counter::HtmlParses as usize],
            resolves: t[Counter::Resolves as usize],
            paint_captures: t[Counter::PaintCaptures as usize],
            painted_commands: t[Counter::PaintedCommands as usize],
            run_match_comparisons: t[Counter::RunMatchComparisons as usize],
            font_context_builds: t[Counter::FontContextBuilds as usize],
            bytes_in: t[Counter::BytesIn as usize],
            bytes_out: t[Counter::BytesOut as usize],
            font_registrations: t[Counter::FontRegistrations as usize],
            resource_fetches: t[Counter::ResourceFetches as usize],
            face_bytes_out: t[Counter::FaceBytesOut as usize],
        }
    }

    /// The value of one counter.
    pub fn get(&self, c: Counter) -> u64 {
        match c {
            Counter::HtmlParses => self.html_parses,
            Counter::Resolves => self.resolves,
            Counter::PaintCaptures => self.paint_captures,
            Counter::PaintedCommands => self.painted_commands,
            Counter::RunMatchComparisons => self.run_match_comparisons,
            Counter::FontContextBuilds => self.font_context_builds,
            Counter::BytesIn => self.bytes_in,
            Counter::BytesOut => self.bytes_out,
            Counter::FontRegistrations => self.font_registrations,
            Counter::ResourceFetches => self.resource_fetches,
            Counter::FaceBytesOut => self.face_bytes_out,
        }
    }

    /// `{"htmlParses":N,…}` — the wasm export's shape.
    pub fn to_json(&self) -> String {
        let fields: Vec<String> = Counter::ALL
            .iter()
            .map(|&c| format!("\"{}\":{}", c.name(), self.get(c)))
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

#[cfg(feature = "perf-counters")]
mod imp {
    use super::{Counter, N};
    use std::cell::Cell;

    thread_local! {
        static TABLE: Cell<[u64; N]> = const { Cell::new([0; N]) };
    }

    #[inline]
    pub fn bump(c: Counter, n: u64) {
        TABLE.with(|t| {
            let mut v = t.get();
            v[c as usize] = v[c as usize].saturating_add(n);
            t.set(v);
        });
    }

    pub fn table() -> [u64; N] {
        TABLE.with(|t| t.get())
    }

    pub fn reset() {
        TABLE.with(|t| t.set([0; N]));
    }
}

/// Add `n` to counter `c`. A no-op (compiled away) without `perf-counters`.
#[cfg(feature = "perf-counters")]
#[inline]
pub fn bump(c: Counter, n: u64) {
    imp::bump(c, n);
}

/// Add `n` to counter `c`. A no-op (compiled away) without `perf-counters`.
#[cfg(not(feature = "perf-counters"))]
#[inline(always)]
pub fn bump(_c: Counter, _n: u64) {}

/// This thread's counts so far (all zero without `perf-counters`).
pub fn perf_counters() -> PerfCounters {
    #[cfg(feature = "perf-counters")]
    {
        PerfCounters::from_table(imp::table())
    }
    #[cfg(not(feature = "perf-counters"))]
    {
        PerfCounters::from_table([0; N])
    }
}

/// Zero this thread's counts.
pub fn reset_perf_counters() {
    #[cfg(feature = "perf-counters")]
    imp::reset();
}

/// `true` when this build counts (the `perf-counters` feature is on).
pub const ENABLED: bool = cfg!(feature = "perf-counters");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_names_every_counter_once() {
        let j = PerfCounters::default().to_json();
        for c in Counter::ALL {
            assert_eq!(j.matches(&format!("\"{}\":", c.name())).count(), 1);
        }
    }

    #[test]
    fn bump_counts_only_with_the_feature() {
        reset_perf_counters();
        bump(Counter::Resolves, 3);
        let expect = if ENABLED { 3 } else { 0 };
        assert_eq!(perf_counters().resolves, expect);
        reset_perf_counters();
        assert_eq!(perf_counters(), PerfCounters::default());
    }
}
