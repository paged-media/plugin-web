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
//! The baseline (2026-10-05) showed the shapes the optimisations attack: a flow
//! resolves and paints once PER FRAME, each paint covering the whole
//! remainder (painted commands ~ frames x remaining content), and text
//! recovery compared every captured run against every recovered run
//! (run-match comparisons ~ R^2). Now a flow frame paints only its
//! band and run matching is ~R through an index.
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
    assert!(!overset, "the article fits 4 x 1500 px");
    assert_eq!(
        ws.len(),
        ARTICLE_PARAS * article_words(),
        "text conserved across 4 frames"
    );
    assert_each_once(&ws, (0..ARTICLE_PARAS).map(article_marker));
    check(&c, &ARTICLE_4_ORPHANS_WIDOWS);
}

#[test]
fn article_flowed_into_12_frames__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = article(ARTICLE_PARAS);
    let (ws, overset, c) = flow_render(&html, &frames(12, ARTICLE_FLOW_CAPACITY / 12));
    show("article/flow-12", &c);
    assert!(!overset, "the article fits 12 x 500 px");
    assert_eq!(
        ws.len(),
        ARTICLE_PARAS * article_words(),
        "text conserved across 12 frames"
    );
    assert_each_once(&ws, (0..ARTICLE_PARAS).map(article_marker));
    check(&c, &ARTICLE_12_ORPHANS_WIDOWS);
}

/// The inspected render (in-frame editing, the outline highlight): one
/// parse, resolve and paint like a plain frame render; what it adds is the
/// maps it returns (bytes out).
#[test]
fn article_inspected_in_one_frame__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let html = article(ARTICLE_PARAS);
    let (json, c) = measure(|| {
        web_render::inspect::render_web_frame_inspect_json(&html, FRAME_W, ARTICLE_ONE_FRAME_H)
    });
    show("article/1-frame-inspected", &c);
    let v: Value = serde_json::from_str(&json).expect("inspect JSON");
    let ws = words(&layer_texts(&v["layer"]));
    assert_eq!(
        ws.len(),
        ARTICLE_PARAS * article_words(),
        "every word painted once"
    );
    assert_eq!(
        v["text"]["nodes"].as_array().map(Vec::len),
        Some(ARTICLE_PARAS),
        "one text node per paragraph"
    );
    check(&c, &ARTICLE_1_INSPECTED);
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
    // Every span's word reaches the canvas exactly once, and nothing else
    // does (see `styled_runs_carry_only_their_own_text`).
    assert_eq!(ws.len(), STYLED_RUNS, "one word per span");
    assert_each_once(&ws, (0..STYLED_RUNS).map(styled_marker));
    check(&c, &STYLED_200);
}

/// The work SHAPES, stated as relations between the pinned budgets so they
/// read as the property they are (baseline 2026-10-05: per-frame flow work,
/// R^2 run matching, a font context per call; the optimisations turn them around).
#[test]
fn work_shapes__feat__plugin_web_perf_budgets() {
    // Resolves per flow = frames: each frame re-lays out the remainder at its
    // own width after the consumed prefix is deleted (the fragmentation model,
    // ADR 404 — a continuation re-applies box tops, margins and indents).
    assert_eq!(ARTICLE_4_ORPHANS_WIDOWS.resolves, 4);
    assert_eq!(ARTICLE_12_ORPHANS_WIDOWS.resolves, 12);
    // Each frame paints only its BAND (the last frame its remainder), so a
    // flow paints about its content once, however many frames: 12 frames
    // paint < 1.5 x one frame's commands (in the baseline each frame repainted
    // the whole remainder: ~ C x (F + 1) / 2, 1 360 for 12 frames).
    const { assert!(2 * ARTICLE_4_ORPHANS_WIDOWS.painted_commands < 3 * ARTICLE_1.painted_commands) };
    const { assert!(2 * ARTICLE_12_ORPHANS_WIDOWS.painted_commands < 3 * ARTICLE_1.painted_commands) };
    // Run matching is LINEAR: an index answers each captured run with ~one
    // candidate (the article's 200 line runs cost 200 comparisons; in
    // the baseline they cost 200^2 = 40 000, the table 815 409).
    assert_eq!(ARTICLE_1.run_match_comparisons, 200);
    assert_eq!(STYLED_200.run_match_comparisons, STYLED_RUNS as u64);
    const { assert!(TABLE_300.run_match_comparisons <= 4 * TABLE_ROWS as u64) };
    // The font context is built once per engine, not per render call.
    assert_eq!(ARTICLE_12_ORPHANS_WIDOWS.font_context_builds, 0);
}

/// The font context is built ONCE per engine (thread): the first render on a
/// cold engine builds it, every later render reuses it. In the baseline every
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

/// Sub-resources and registered faces add work only where a source uses them:
/// an `<img>` (fetched while the HTML is parsed) loads in the ONE resolve every
/// render does; a CSS background (fetched while styles resolve) costs exactly
/// one more; a face registered twice is registered once and never rebuilds the
/// font context. Each fetch crosses no bytes at render time (the bytes were
/// registered once, before).
#[test]
fn resources_and_faces__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::thread::spawn(|| {
        let png = web_render::resources::decode_data_url(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC",
        )
        .unwrap();
        web_render::resources::register_resource("img/a.png", &png);
        let count_images = |json: &str| json.matches("\"kind\":\"image\"").count();

        let (out, img) = measure(|| {
            render_web_frame_json("<img src=\"img/a.png\" style=\"width:20px;height:20px\">", 200, 200)
        });
        show("resources/img", &img);
        assert_eq!(count_images(&out), 1, "the image painted");
        assert_eq!((img.resolves, img.resource_fetches), (1, 1));

        let (out, bg) = measure(|| {
            render_web_frame_json(
                "<div style=\"width:20px;height:20px;background-image:url(img/a.png)\"></div>",
                200,
                200,
            )
        });
        show("resources/background", &bg);
        assert_eq!(count_images(&out), 1, "the background painted");
        assert_eq!((bg.resolves, bg.resource_fetches), (2, 1));

        let (_, faces) = measure(|| {
            web_render::fonts::register_font(web_render::fonts::INTER_REGULAR, Some("Brand"));
            web_render::fonts::register_font(web_render::fonts::INTER_REGULAR, Some("Brand"));
            render_web_frame_json("<p style=\"font-family:Brand\">x</p>", 200, 200)
        });
        show("resources/faces", &faces);
        assert_eq!((faces.font_registrations, faces.font_context_builds), (1, 0));
        assert_eq!(faces.resolves, 1);
    })
    .join()
    .unwrap();
}

// ---------------------------------------------------------------------------
// Defects the workloads exposed. Pinned as `should_panic` while open; when one
// is fixed its test becomes a plain assertion in the fixing commit.
// ---------------------------------------------------------------------------

/// FIXED 2026-10-05 (was `defect_styled_runs_carry_their_whole_line_text`):
/// colour-only `<span>`s share one shaping run, and every per-style glyph run
/// recovered the shaping run's WHOLE line text (`run.text_range()`) — the
/// canvas painted each line once per colour run, overlapping (3 257 words for
/// 200 spans). Each glyph run now recovers only its own clusters' text.
#[test]
fn styled_runs_carry_only_their_own_text__feat__plugin_web_perf_budgets() {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (ws, _) = frame_render(&styled_runs(STYLED_RUNS), TALL_H);
    assert_eq!(ws.len(), STYLED_RUNS, "one word per span, no repeats");
    assert_each_once(&ws, (0..STYLED_RUNS).map(styled_marker));
}

/// FIXED 2026-10-05 (was `defect_flow_reports_overset_for_content_that_fits`):
/// the flow's last-frame bottom included the viewport-sized transparent canvas
/// background fill, so `overset` was true whenever the last frame was shorter
/// than the 4096 px paint viewport, even when the text fit. The transparent
/// fill is dropped at capture and the canvas background never counts as
/// content.
#[test]
fn flow_that_fits_is_not_overset__feat__plugin_web_perf_budgets() {
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
    /// Output bytes WITHOUT the text-face fields (pinned before faces).
    bytes_out: u64,
    /// The text-face fields' bytes (`weight` / `italic` of non-regular runs).
    face_bytes_out: u64,
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
        c.bytes_out - c.face_bytes_out <= b.bytes_out,
        "bytes out (without faces) {} > budget {}",
        c.bytes_out - c.face_bytes_out,
        b.bytes_out
    );
    assert!(
        c.face_bytes_out <= b.face_bytes_out,
        "face bytes out {} > budget {}",
        c.face_bytes_out,
        b.face_bytes_out
    );
}

const ARTICLE_1: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 200,
    run_match_comparisons: 200,
    bytes_in: 8894,
    bytes_out: 31634,
    face_bytes_out: 0,
};
// The flow budgets of the earlier cut policy (break after the last line that
// fits) were 217 / 250 painted commands and run-match comparisons, bytes out
// 31646 / 31873. Fragmentation now honours `orphans` and `widows` at their
// CSS initial value 2 (as Chrome does), which moves the article's cuts: a
// different geometry, so these are that feature's own budgets, pinned as
// measured 2026-10-05.
const ARTICLE_4_ORPHANS_WIDOWS: Budget = Budget {
    html_parses: 1,
    resolves: 4,
    paint_captures: 4,
    font_context_builds: 0,
    painted_commands: 219,
    run_match_comparisons: 219,
    bytes_in: 9023,
    bytes_out: 31645,
    face_bytes_out: 0,
};
const ARTICLE_12_ORPHANS_WIDOWS: Budget = Budget {
    html_parses: 1,
    resolves: 12,
    paint_captures: 12,
    font_context_builds: 0,
    painted_commands: 252,
    run_match_comparisons: 252,
    bytes_in: 9267,
    bytes_out: 31873,
    face_bytes_out: 0,
};
/// The inspected render's own budget (in-frame editing), pinned as measured
/// 2026-10-05: the same work as `ARTICLE_1`, plus the maps in bytes out.
const ARTICLE_1_INSPECTED: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 200,
    run_match_comparisons: 200,
    bytes_in: 8894,
    bytes_out: 236678,
    face_bytes_out: 0,
};
const TABLE_300: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 1214,
    run_match_comparisons: 903,
    bytes_in: 15942,
    bytes_out: 190761,
    face_bytes_out: 45,
};
const STYLED_200: Budget = Budget {
    html_parses: 1,
    resolves: 1,
    paint_captures: 1,
    font_context_builds: 0,
    painted_commands: 399,
    run_match_comparisons: 200,
    bytes_in: 7722,
    bytes_out: 26515,
    face_bytes_out: 0,
};
