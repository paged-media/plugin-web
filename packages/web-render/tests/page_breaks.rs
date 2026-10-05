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

//! Fragmentation rules the Chrome oracle cannot express (its multi-column
//! model has columns, not pages): `break-before: page`, the CSS 2
//! `page-break-*` aliases, a forced break in the last frame, an avoid rule
//! that cannot be honoured, and `@page` margins (a frame is a page box,
//! ADR 412). The Chrome-checked cases are the `flow-break-*` and
//! `flow-orphans-widows-rules` fixtures in `flow_parity.rs`.

#![allow(non_snake_case)]

use web_render::display_list::WebDrawCmd;
use web_render::flow::render_web_flow_variable;
use web_render::WebDisplayList;

/// The shaping stack shares process state; the tests take turns (the
/// library's own tests do the same through `SHAPE_LOCK`).
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn texts(dl: &WebDisplayList) -> Vec<String> {
    dl.commands
        .iter()
        .filter_map(|c| match c {
            WebDrawCmd::GlyphRun(r) if !r.text.trim().is_empty() => Some(r.text.trim().to_string()),
            _ => None,
        })
        .collect()
}

fn doc(css: &str, body: &str) -> String {
    format!(
        "<html><head><style>html{{font-family:Inter;line-height:1.25}}body{{margin:0}}\
         p{{margin:0}}{css}</style></head><body>{body}</body></html>"
    )
}

const FRAMES: &[(u32, u32)] = &[(300, 200), (300, 200), (300, 200)];

#[test]
fn break_before_page_and_the_legacy_alias_force_a_new_frame__feat__plugin_web_page_breaks() {
    let _g = serial();
    for css in [
        ".b{break-before:page}",
        ".b{page-break-before:always}",
        ".b{break-before:column}",
    ] {
        let html = doc(css, "<p>one</p><p class=b>two</p><p>three</p>");
        let f = render_web_flow_variable(&html, FRAMES);
        assert_eq!(texts(&f.frames[0]), ["one"], "{css}");
        assert_eq!(texts(&f.frames[1]), ["two", "three"], "{css}");
        assert!(!f.overset, "{css}");
    }
}

#[test]
fn break_after_on_an_inline_style_forces_a_new_frame__feat__plugin_web_page_breaks() {
    let _g = serial();
    let html = doc("", "<p style=\"break-after: page\">one</p><p>two</p>");
    let f = render_web_flow_variable(&html, FRAMES);
    assert_eq!(texts(&f.frames[0]), ["one"]);
    assert_eq!(texts(&f.frames[1]), ["two"]);
}

#[test]
fn a_forced_break_in_the_last_frame_leaves_the_rest_overset__feat__plugin_web_page_breaks() {
    let _g = serial();
    let html = doc(".b{break-before:page}", "<p>one</p><p class=b>two</p>");
    let f = render_web_flow_variable(&html, &[(300, 200)]);
    assert_eq!(texts(&f.frames[0]), ["one"]);
    assert!(
        f.overset,
        "the content after the break did not fit the chain"
    );
}

#[test]
fn a_forced_break_at_the_top_of_a_frame_is_no_extra_break__feat__plugin_web_page_breaks() {
    let _g = serial();
    let html = doc(".b{break-before:page}", "<p class=b>one</p><p>two</p>");
    let f = render_web_flow_variable(&html, FRAMES);
    assert_eq!(texts(&f.frames[0]), ["one", "two"]);
}

#[test]
fn break_inside_avoid_on_the_first_block_of_a_frame_still_splits__feat__plugin_web_page_breaks() {
    let _g = serial();
    // 30 lines in a 10-line frame: nothing else can fill the frame, so the
    // avoid rule cannot be honoured and the paragraph splits.
    let words = "word ".repeat(150);
    let html = doc(".k{break-inside:avoid}", &format!("<p class=k>{words}</p>"));
    let f = render_web_flow_variable(&html, FRAMES);
    assert!(!texts(&f.frames[0]).is_empty());
    assert!(!texts(&f.frames[1]).is_empty());
}

#[test]
fn page_margins_inset_every_frame__feat__plugin_web_page_breaks() {
    let _g = serial();
    // 20 px lines; a 200 px frame with 40 px top and 60 px bottom margins
    // holds 5 lines, each frame's first baseline sits below the top margin
    // and the left margin moves the text right.
    let lines: Vec<String> = (1..=8).map(|i| format!("<p>line{i}</p>")).collect();
    let html = doc(
        "@page{margin:40px 0 60px 24px} p{orphans:1;widows:1}",
        &lines.join(""),
    );
    let f = render_web_flow_variable(&html, FRAMES);
    assert_eq!(texts(&f.frames[0]).len(), 5, "{:?}", texts(&f.frames[0]));
    assert_eq!(texts(&f.frames[1]).len(), 3);
    for frame in &f.frames[..2] {
        let first = frame
            .commands
            .iter()
            .find_map(|c| match c {
                WebDrawCmd::GlyphRun(r) => Some(r.clone()),
                _ => None,
            })
            .expect("a run");
        // 40 px = 30 pt; the baseline is below the margin, the run starts
        // at the 24 px = 18 pt left margin.
        assert!(first.baseline_y > 30.0, "{}", first.baseline_y);
        assert!(
            (first.baseline_x - 18.0).abs() < 1.0,
            "{}",
            first.baseline_x
        );
    }
}

#[test]
fn page_margins_inset_a_single_frame_render__feat__plugin_web_page_breaks() {
    let _g = serial();
    let html = doc("@page{margin:30px}", "<p>hello</p>");
    let dl = web_render::capture::render_html(&html, 300, 200);
    let run = dl
        .commands
        .iter()
        .find_map(|c| match c {
            WebDrawCmd::GlyphRun(r) => Some(r.clone()),
            _ => None,
        })
        .expect("a run");
    assert!((run.baseline_x - 22.5).abs() < 1.0, "{}", run.baseline_x);
    assert!(run.baseline_y > 22.5);
}

#[test]
fn orphans_and_widows_are_inherited_from_an_ancestor__feat__plugin_web_page_breaks() {
    let _g = serial();
    // 11–14 lines into 10-line frames with widows 5 set on <body>: the
    // first frame keeps fewer than the 10 that fit, so that 5 go on.
    let words = "word ".repeat(90);
    let html = doc(
        "body{widows:5;orphans:1} p{width:300px}",
        &format!("<p>{words}</p>"),
    );
    let tall = web_render::capture::render_html(&html, 300, 2000);
    let total_lines = texts(&tall).len();
    let f = render_web_flow_variable(&html, FRAMES);
    let first = texts(&f.frames[0]).len();
    assert!((11..=14).contains(&total_lines), "{total_lines}");
    assert!(first < 10, "{first} of {total_lines}");
    assert_eq!(total_lines - first, 5, "{first} of {total_lines}");
}
