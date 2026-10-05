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

//! Count budgets for the web render engine (feature `perf-counters`).
//!
//! Every budget is a COUNT of work — HTML parses, style/layout resolves,
//! paint captures, painted draw commands, run-match comparisons, font-context
//! builds, bytes across the wasm boundary — pinned at the value MEASURED on
//! the workload, beside a behaviour assertion (the text is conserved). A
//! count is the same on every machine; an optimisation lowers the pin in the
//! commit that earns it, and a pin is never raised.
//!
//! The baseline (2026-10-05) showed the shapes Wave 2 attacks: a flow
//! resolves and paints once PER FRAME, each paint covering the whole
//! remainder (painted commands ~ frames x remaining content), and text
//! recovery compared every captured run against every recovered run
//! (run-match comparisons ~ R^2 — now ~R through an index).
//!
//! Run: `cargo test --features blitz,perf-counters --test perf_budgets`;
//! `PERF_SHOW=1` (with `-- --nocapture`) prints the measured table.

#![allow(non_snake_case)] // the `__feat__<id>` cockpit suffix

mod common;

use std::sync::Mutex;

use common::workloads::*;
use serde_json::Value;
use web_render::perf::{perf_counters, reset_perf_counters, PerfCounters};
use web_render::{render_web_flow_boundary_json, render_web_frame_json};

/// Shaping shares process state across threads (see `capture::SHAPE_LOCK`);
/// serialize the workloads so geometry — and so the counts — is stable.
static LOCK: Mutex<()> = Mutex::new(());

/// Count `f`'s work on a WARM engine: the font context (built once per engine
/// thread) is built before the counters are reset, so a budget pins the
/// per-render work, not the engine's one-time start-up
/// (`font_context_is_built_once_per_engine` counts that).
fn measure<T>(f: impl FnOnce() -> T) -> (T, PerfCounters) {
    let _ = web_render::fonts::font_ctx();
    reset_perf_counters();
    let out = f();
    (out, perf_counters())
}

fn show(name: &str, c: &PerfCounters) {
    if std::env::var_os("PERF_SHOW").is_some() {
        println!("PERF {name} {}", c.to_json());
    }
}

/// Every C-1 text item's text in a `SceneLayer` JSON value, in order.
fn layer_texts(layer: &Value) -> Vec<String> {
    layer["items"]
        .as_array()
        .expect("items array")
        .iter()
        .filter(|it| it["kind"] == "text" || it.get("text").is_some_and(|t| t.is_string()))
        .filter_map(|it| it["text"].as_str().map(str::to_string))
        .collect()
}

fn words(texts: &[String]) -> Vec<String> {
    texts
        .iter()
        .flat_map(|t| t.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .collect()
}

/// Each marker occurs exactly once in `ws`.
fn assert_each_once(ws: &[String], markers: impl Iterator<Item = String>) {
    for m in markers {
        let n = ws.iter().filter(|w| **w == m).count();
        assert_eq!(n, 1, "marker {m} must occur exactly once, found {n}");
    }
}

const ARTICLE_PARAS: usize = 40;
/// Words per article paragraph: the marker + the filler's words.
fn article_words() -> usize {
    1 + article(1)
        .split("X ")
        .nth(1)
        .unwrap()
        .split("</p>")
        .next()
        .unwrap()
        .split_whitespace()
        .count()
}

// ---------------------------------------------------------------------------
// Budgets (pinned as measured 2026-10-05; lower only in the commit that earns it)
// ---------------------------------------------------------------------------

fn frame_render(html: &str, h: u32) -> (Vec<String>, PerfCounters) {
    let (json, c) = measure(|| render_web_frame_json(html, FRAME_W, h));
    let v: Value = serde_json::from_str(&json).expect("frame JSON");
    (words(&layer_texts(&v)), c)
}

fn flow_render(html: &str, frames: &[(u32, u32)]) -> (Vec<String>, bool, PerfCounters) {
    let (json, c) = measure(|| render_web_flow_boundary_json(html, &frames_json(frames), ""));
    let v: Value = serde_json::from_str(&json).expect("flow JSON");
    let fs = v["frames"].as_array().expect("frames");
    assert_eq!(fs.len(), frames.len(), "one layer per frame");
    let mut all = Vec::new();
    for f in fs {
        all.extend(words(&layer_texts(&f["layer"])));
    }
    (all, v["overset"].as_bool().unwrap(), c)
}

#[test]
fn article_in_one_frame__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = article(ARTICLE_PARAS);
    let (ws, c) = frame_render(&html, ARTICLE_ONE_FRAME_H);
    show("article/1-frame", &c);
    assert_eq!(
        ws.len(),
        ARTICLE_PARAS * article_words(),
        "every word painted once"
    );
    assert_each_once(&ws, (0..ARTICLE_PARAS).map(article_marker));
    check(&c, &ARTICLE_1);
}

#[test]
fn article_flowed_into_4_frames__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = article(ARTICLE_PARAS);
    let (ws, overset, c) = flow_render(&html, &frames(4, ARTICLE_FLOW_CAPACITY / 4));
    show("article/flow-4", &c);
    // `overset` is NOT asserted: it is always true below a 4096 px last frame
    // (see `defect_flow_reports_overset_for_content_that_fits`).
    let _ = overset;
    assert_eq!(
        ws.len(),
        ARTICLE_PARAS * article_words(),
        "text conserved across 4 frames"
    );
    assert_each_once(&ws, (0..ARTICLE_PARAS).map(article_marker));
    check(&c, &ARTICLE_4);
}

#[test]
fn article_flowed_into_12_frames__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = article(ARTICLE_PARAS);
    let (ws, overset, c) = flow_render(&html, &frames(12, ARTICLE_FLOW_CAPACITY / 12));
    show("article/flow-12", &c);
    let _ = overset;
    assert_eq!(
        ws.len(),
        ARTICLE_PARAS * article_words(),
        "text conserved across 12 frames"
    );
    assert_each_once(&ws, (0..ARTICLE_PARAS).map(article_marker));
    check(&c, &ARTICLE_12);
}

#[test]
fn table_300_rows_in_one_frame__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = table(TABLE_ROWS);
    let (ws, c) = frame_render(&html, TABLE_FRAME_H);
    show("table-300/1-frame", &c);
    assert_each_once(&ws, (0..TABLE_ROWS).map(table_marker));
    check(&c, &TABLE_300);
}

#[test]
fn styled_runs_200_in_one_frame__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = styled_runs(STYLED_RUNS);
    let (ws, c) = frame_render(&html, TALL_H);
    show("styled-runs-200/1-frame", &c);
    // Every span's word reaches the canvas. NOT "exactly once": each colour
    // run carries its whole line's text today
    // (see `defect_styled_runs_carry_their_whole_line_text`).
    for m in (0..STYLED_RUNS).map(styled_marker) {
        assert!(ws.contains(&m), "span word {m} missing");
    }
    check(&c, &STYLED_200);
}

/// The work SHAPES, stated as relations between the pinned budgets so they
/// read as the property they are (baseline 2026-10-05: per-frame flow work,
/// R^2 run matching, a font context per call; Wave 2 turns them around).
#[test]
fn work_shapes__feat__plugin_web_perf_budgets() {
    // Resolves per flow = frames (a full style + layout pass per frame).
    assert_eq!(ARTICLE_4.resolves, 4);
    assert_eq!(ARTICLE_12.resolves, 12);
    // Each frame repaints the whole REMAINDER: 12 frames paint far more
    // commands than 4 for the same content (~ frames x remaining / 2).
    // Sum over frames of the remainder ~ C x (F + 1) / 2 for C commands.
    const { assert!(ARTICLE_4.painted_commands >= 2 * ARTICLE_1.painted_commands) };
    const { assert!(ARTICLE_12.painted_commands >= 5 * ARTICLE_1.painted_commands) };
    // Run matching is LINEAR: an index answers each captured run with ~one
    // candidate (the article's 200 line runs cost 200 comparisons; before
    // Wave 2 they cost 200^2 = 40 000, the table 815 409).
    assert_eq!(ARTICLE_1.run_match_comparisons, 200);
    const { assert!(STYLED_200.run_match_comparisons <= 2 * STYLED_RUNS as u64) };
    const { assert!(TABLE_300.run_match_comparisons <= 4 * TABLE_ROWS as u64) };
    // The font context is built once per engine, not per render call.
    assert_eq!(ARTICLE_12.font_context_builds, 0);
}

/// The font context is built ONCE per engine (thread): the first render on a
/// cold engine builds it, every later render reuses it. Before Wave 2 every
/// render call built its own (1 per call).
#[test]
fn font_context_is_built_once_per_engine__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::thread::spawn(|| {
        let html = article(2);
        reset_perf_counters();
        let _ = render_web_frame_json(&html, FRAME_W, TALL_H);
        let cold = perf_counters().font_context_builds;
        reset_perf_counters();
        let _ = render_web_frame_json(&html, FRAME_W, TALL_H);
        let _ = render_web_flow_boundary_json(&html, &frames_json(&frames(2, 60)), "");
        let warm = perf_counters().font_context_builds;
        assert_eq!(
            (cold, warm),
            (1, 0),
            "one build on a cold engine, none after"
        );
    })
    .join()
    .unwrap();
}

// ---------------------------------------------------------------------------
// Defects the workloads exposed (pinned: these panic today; when one is fixed
// the test fails — drop its `should_panic` and tighten the budget's behaviour
// assertion in the same commit)
// ---------------------------------------------------------------------------

/// Colour-only `<span>`s share one shaping run, so every per-style glyph run
/// recovers the shaping run's WHOLE line text (`run.text_range()`) — the
/// canvas paints each line's text once per colour run, overlapping.
#[test]
#[should_panic(expected = "occur exactly once")]
fn defect_styled_runs_carry_their_whole_line_text__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (ws, _) = frame_render(&styled_runs(STYLED_RUNS), TALL_H);
    assert_each_once(&ws, (0..STYLED_RUNS).map(styled_marker));
}

/// The flow's last-frame bottom includes the viewport-sized (transparent)
/// root background fill, so `overset` is true whenever the last frame is
/// shorter than the 4096 px paint viewport — even when the text fits.
#[test]
#[should_panic(expected = "fits, so not overset")]
fn defect_flow_reports_overset_for_content_that_fits__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (ws, overset, _) = flow_render(&article(2), &frames(1, 2000));
    assert_eq!(ws.len(), 2 * article_words(), "both paragraphs painted");
    assert!(
        !overset,
        "two paragraphs in a 2000 px frame fits, so not overset"
    );
}

// --- the pins -------------------------------------------------------------

const ARTICLE_ONE_FRAME_H: u32 = 8192;
const ARTICLE_FLOW_CAPACITY: u32 = 6000;
const TABLE_ROWS: usize = 300;
const TABLE_FRAME_H: u32 = 8192;
const STYLED_RUNS: usize = 200;

/// A budget: exact for structural counts, a ceiling (`<=`) for counts that
/// track geometry (painted commands, comparisons, bytes).
struct Budget {
    html_parses: u64,
    resolves: u64,
    paint_captures: u64,
    font_context_builds: u64,
    painted_commands: u64,
    run_match_comparisons: u64,
    bytes_in: u64,
    bytes_out: u64,
}

fn check(c: &PerfCounters, b: &Budget) {
    assert_eq!(c.html_parses, b.html_parses, "html parses");
    assert_eq!(c.resolves, b.resolves, "resolves");
    assert_eq!(c.paint_captures, b.paint_captures, "paint captures");
    assert_eq!(
        c.font_context_builds, b.font_context_builds,
        "font-context builds"
    );
    assert!(
        c.painted_commands <= b.painted_commands,
        "painted commands {} > budget {}",
        c.painted_commands,
        b.painted_commands
    );
    assert!(
        c.run_match_comparisons <= b.run_match_comparisons,
        "run-match comparisons {} > budget {}",
        c.run_match_comparisons,
        b.run_match_comparisons
    );
    assert!(
        c.bytes_in <= b.bytes_in,
        "bytes in {} > budget {}",
        c.bytes_in,
        b.bytes_in
    );
    assert!(
        c.bytes_out <= b.bytes_out,
        "bytes out {} > budget {}",
        c.bytes_out,
        b.bytes_out
    );
}

const ARTICLE_1: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 243,
    run_match_comparisons: 200,
    bytes_in: 8894,
    bytes_out: 58784,
};
const ARTICLE_4: Budget = Budget {
    html_parses: 1,
    resolves: 4,
    paint_captures: 4,
    font_context_builds: 0,
    painted_commands: 514,
    run_match_comparisons: 417,
    bytes_in: 9023,
    bytes_out: 64594,
};
const ARTICLE_12: Budget = Budget {
    html_parses: 1,
    resolves: 12,
    paint_captures: 12,
    font_context_builds: 0,
    painted_commands: 1360,
    run_match_comparisons: 1100,
    bytes_in: 9267,
    bytes_out: 78153,
};
const TABLE_300: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 2121,
    run_match_comparisons: 903,
    bytes_in: 15942,
    bytes_out: 814706,
};
const STYLED_200: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 403,
    run_match_comparisons: 399,
    bytes_in: 7722,
    bytes_out: 71303,
};
