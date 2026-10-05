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

//! The fragmentation oracle: where a flow breaks across frames, Blitz's
//! `render_web_flow` against Chrome's fragmentation engine.
//!
//! `packages/web-conformance/chrome/record-flow.mjs` pours each flow fixture
//! through a multi-column container whose columns are the frames (equal
//! frame sizes — Chrome has no CSS Regions) and records the text that lands
//! in every frame and in the overflow columns. This test renders the same
//! bytes with [`web_render::flow::render_web_flow_variable`] and compares
//!
//! - `breaks`  — every frame carries the same words (whitespace-collapsed,
//!   case-folded), i.e. every break falls on the same word;
//! - `overset` — the same overset status;
//! - `conserve` — Blitz's frames + overset lose and duplicate nothing (the
//!   concatenated frame text is a prefix of the single-frame text) — an
//!   engine invariant, independent of Chrome.
//!
//! Expectations follow `chrome_parity.rs`: absent = must agree, `Defect` =
//! pinned (must still disagree), `Diverges` = documented, measured only.

#![allow(non_snake_case)]

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use web_render::display_list::WebDrawCmd;
use web_render::flow::render_web_flow_variable;

#[derive(Debug, Clone, Copy)]
enum Expect {
    Defect(&'static str),
    #[allow(dead_code)]
    Diverges(&'static str),
}

#[rustfmt::skip]
const EXPECT: &[(&str, &str, Expect)] = &[
    ("flow-forced-break", "overset", Expect::Defect("FW-01 overset is reported although the content fits the chain")),
    ("flow-headings-margins", "overset", Expect::Defect("FW-01 overset is reported although the content fits the chain")),
    ("flow-orphans-widows", "overset", Expect::Defect("FW-01 overset is reported although the content fits the chain")),
    ("flow-split-paragraph", "overset", Expect::Defect("FW-01 overset is reported although the content fits the chain")),
    ("flow-list", "breaks", Expect::Defect("FW-02 list items: frames repeat and drop items (CW-02 marker text theft)")),
    ("flow-list", "conserve", Expect::Defect("FW-02 list items: frames repeat and drop items (CW-02 marker text theft)")),
    ("flow-table-rows", "breaks", Expect::Defect("FW-03 the last frame keeps a table row that does not fit its height")),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlowRecording {
    fixture: String,
    frames: Vec<Frame>,
    frame_text: Vec<String>,
    overset_text: String,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Frame {
    width_px: u32,
    height_px: u32,
}

#[derive(Serialize)]
struct FlowResultRow {
    fixture: String,
    chrome_words: Vec<usize>,
    blitz_words: Vec<usize>,
    chrome_overset: bool,
    blitz_overset: bool,
    /// Words Blitz lost or duplicated relative to its single-frame text.
    conserve_error: Option<String>,
    first_diff: Option<String>,
    verdicts: std::collections::BTreeMap<String, String>,
}

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../web-conformance/chrome")
}

fn words(s: &str) -> Vec<String> {
    s.replace('\u{ad}', "")
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect()
}

fn frame_words(dl: &web_render::WebDisplayList) -> Vec<String> {
    let mut text = String::new();
    for c in &dl.commands {
        if let WebDrawCmd::GlyphRun(r) = c {
            text.push_str(&r.text);
            text.push(' ');
        }
    }
    words(&text)
}

fn run(rec: &FlowRecording, html: &str) -> FlowResultRow {
    let frames: Vec<(u32, u32)> = rec
        .frames
        .iter()
        .map(|f| (f.width_px, f.height_px))
        .collect();
    let flow = render_web_flow_variable(html, &frames);
    let blitz: Vec<Vec<String>> = flow.frames.iter().map(frame_words).collect();
    let chrome: Vec<Vec<String>> = rec.frame_text.iter().map(|t| words(t)).collect();

    let mut first_diff = None;
    for (i, c) in chrome.iter().enumerate() {
        let b = blitz.get(i).cloned().unwrap_or_default();
        if *c != b && first_diff.is_none() {
            first_diff = Some(format!(
                "frame {i}: chrome {} words ending {:?}, blitz {} words ending {:?}",
                c.len(),
                c.last(),
                b.len(),
                b.last()
            ));
        }
    }
    let breaks_ok = first_diff.is_none() && blitz.len() == chrome.len();
    let chrome_overset = !rec.overset_text.trim().is_empty();

    // Conservation: everything Blitz painted across the frames, in order, is
    // a prefix of the whole flow laid out in one frame tall enough to hold it.
    let w = frames[0].0;
    let tall = render_web_flow_variable(html, &[(w, 100_000)]);
    let whole: Vec<String> = tall.frames.iter().flat_map(frame_words).collect();
    let flat: Vec<String> = blitz.iter().flatten().cloned().collect();
    let conserve_error = if whole.starts_with(&flat) {
        None
    } else {
        let i = flat.iter().zip(&whole).take_while(|(a, b)| a == b).count();
        Some(format!(
            "frames diverge from the single-frame text at word {i}: {:?} vs {:?}",
            flat.get(i),
            whole.get(i)
        ))
    };

    let mut verdicts = std::collections::BTreeMap::new();
    for (aspect, ok) in [
        ("breaks", breaks_ok),
        ("overset", chrome_overset == flow.overset),
        ("conserve", conserve_error.is_none()),
    ] {
        let expect = EXPECT
            .iter()
            .find(|(f, a, _)| *f == rec.fixture && *a == aspect)
            .map(|(_, _, e)| *e);
        let v = match (ok, expect) {
            (true, None) => "agree".to_string(),
            (false, None) => "REGRESSION".to_string(),
            (false, Some(Expect::Defect(id))) => format!("defect: {id}"),
            (true, Some(Expect::Defect(id))) => {
                format!("DEFECT FIXED ({id}) — remove the EXPECT row")
            }
            (_, Some(Expect::Diverges(why))) => format!("diverges: {why}"),
        };
        verdicts.insert(aspect.to_string(), v);
    }
    FlowResultRow {
        fixture: rec.fixture.clone(),
        chrome_words: chrome.iter().map(Vec::len).collect(),
        blitz_words: blitz.iter().map(Vec::len).collect(),
        chrome_overset,
        blitz_overset: flow.overset,
        conserve_error,
        first_diff,
        verdicts,
    }
}

#[test]
fn flow_parity_with_chrome_fragmentation__feat__plugin_web_flow_fragmentation() {
    let rec_dir = dir().join("recorded-flow");
    let mut paths: Vec<_> = fs::read_dir(&rec_dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", rec_dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no flow recordings");
    let mut rows = Vec::new();
    let mut problems = Vec::new();
    for p in paths {
        let rec: FlowRecording = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        let html = fs::read_to_string(
            dir()
                .join("flow-fixtures")
                .join(format!("{}.html", rec.fixture)),
        )
        .unwrap_or_else(|e| panic!("flow fixture {}: {e}", rec.fixture));
        let row = run(&rec, &html);
        for (a, v) in &row.verdicts {
            println!(
                "{:24} {a:8} {v}  chrome {:?}{} blitz {:?}{}  {}",
                row.fixture,
                row.chrome_words,
                if row.chrome_overset { "+overset" } else { "" },
                row.blitz_words,
                if row.blitz_overset { "+overset" } else { "" },
                match a.as_str() {
                    "conserve" => row.conserve_error.clone().unwrap_or_default(),
                    _ => row.first_diff.clone().unwrap_or_default(),
                }
            );
            if v == "REGRESSION" || v.starts_with("DEFECT FIXED") {
                problems.push(format!("{} {a}: {v}", row.fixture));
            }
        }
        rows.push(row);
    }
    let path = std::env::var("FLOW_PARITY_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/flow-parity-report.json")
        });
    let _ = fs::create_dir_all(path.parent().unwrap());
    fs::write(&path, serde_json::to_string_pretty(&rows).unwrap()).unwrap();
    for (f, _, _) in EXPECT {
        assert!(
            rows.iter().any(|r| r.fixture == *f),
            "EXPECT row for unknown flow fixture {f}"
        );
    }
    assert!(problems.is_empty(), "flow parity:\n{}", problems.join("\n"));
}
