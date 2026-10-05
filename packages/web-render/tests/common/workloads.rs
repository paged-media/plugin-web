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

//! The perf workloads, shared by the count budgets (`tests/perf_budgets.rs`)
//! and the wall-clock benches (`benches/render.rs`, via `#[path]`). Built in
//! code (no corpus files) so they are deterministic and public.

#![allow(dead_code)]

/// Frame width every workload renders at, CSS px.
pub const FRAME_W: u32 = 400;

/// Viewport height for a single-frame render — tall enough that nothing is
/// culled (the flow uses the same 4096 floor).
pub const TALL_H: u32 = 4096;

const FILLER: &str = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, \
sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim \
ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.";

/// A 40-paragraph article: each `<p>` opens with a unique `Pnn` marker and
/// wraps to several lines at [`FRAME_W`].
pub fn article(paragraphs: usize) -> String {
    let mut s = String::from(
        "<!DOCTYPE html><html><head><style>\
         body{margin:0;font-size:16px;line-height:24px}\
         p{margin:0 0 8px 0}</style></head><body>",
    );
    for i in 0..paragraphs {
        s.push_str(&format!("<p>P{i:02}X {FILLER}</p>"));
    }
    s.push_str("</body></html>");
    s
}

/// The marker [`article`] puts at the start of paragraph `i`.
pub fn article_marker(i: usize) -> String {
    format!("P{i:02}X")
}

/// A `rows`-row, 3-column table; each row's first cell carries `Rnnn`.
pub fn table(rows: usize) -> String {
    let mut s = String::from(
        "<!DOCTYPE html><html><head><style>\
         body{margin:0;font-size:12px;line-height:16px}\
         table{border-collapse:collapse;width:100%}\
         td,th{border:1px solid #888;padding:2px 4px}\
         th{background:#ddd}</style></head><body><table>\
         <thead><tr><th>Id</th><th>Name</th><th>Value</th></tr></thead><tbody>",
    );
    for i in 0..rows {
        s.push_str(&format!(
            "<tr><td>R{i:03}X</td><td>Item {i}</td><td>{}</td></tr>",
            i * 7
        ));
    }
    s.push_str("</tbody></table></body></html>");
    s
}

/// The marker [`table`] puts in row `i`'s first cell.
pub fn table_marker(i: usize) -> String {
    format!("R{i:03}X")
}

/// One block of `runs` inline-styled spans (alternating colours, so each
/// span is its own glyph run), each carrying a unique `Snnn` word.
pub fn styled_runs(runs: usize) -> String {
    const COLOURS: [&str; 4] = ["#c00", "#060", "#00a", "#555"];
    let mut s = String::from(
        "<!DOCTYPE html><html><head><style>\
         body{margin:0;font-size:14px;line-height:20px}</style></head><body><p>",
    );
    for i in 0..runs {
        s.push_str(&format!(
            "<span style=\"color:{}\">S{i:03}X</span> ",
            COLOURS[i % COLOURS.len()]
        ));
    }
    s.push_str("</p></body></html>");
    s
}

/// The marker [`styled_runs`] puts in span `i`.
pub fn styled_marker(i: usize) -> String {
    format!("S{i:03}X")
}

/// `n` equal frames of [`FRAME_W`] × `h`.
pub fn frames(n: usize, h: u32) -> Vec<(u32, u32)> {
    vec![(FRAME_W, h); n]
}

/// `frames` as the wasm boundary's JSON (`[{"widthPx":…,"heightPx":…}]`).
pub fn frames_json(frames: &[(u32, u32)]) -> String {
    let items: Vec<String> = frames
        .iter()
        .map(|(w, h)| format!("{{\"widthPx\":{w},\"heightPx\":{h}}}"))
        .collect();
    format!("[{}]", items.join(","))
}
