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

//! The Chrome replay lane: Blitz's layout against recorded Chrome layout.
//!
//! `packages/web-conformance/chrome/record.mjs` lays every fixture out in
//! headless Chromium with the engine's own Inter face and commits
//! `recorded/<fixture>@<width>.json`. This test lays the SAME fixture bytes
//! out in Blitz at the same viewport ([`web_render::geometry`]) and compares
//! three aspects per fixture, each over every recorded width:
//!
//! - `boxes`  — every non-inline `[data-id]` element's border box, ±0.5 px on
//!   x, y, width and height;
//! - `breaks` — per text-bearing block, the same number of lines carrying the
//!   same text (whitespace-collapsed, case-folded);
//! - `lines`  — for blocks whose breaks agree, each line's glyph-box top,
//!   bottom, left and right, ±0.5 px (Blitz's glyph box with ascent/descent
//!   rounded to whole px, as Chrome reports it — so the delta is the
//!   baseline and the advance, not metric rounding);
//! - `paint`  — the words the paint CAPTURE recovers onto its glyph runs
//!   (what reaches the canvas) equal Chrome's words as a multiset — catches
//!   text lost, duplicated or attached to the wrong run.
//!
//! Every aspect has an expectation in [`EXPECT`]: absent = must agree (a
//! regression fails); `Defect` = pinned known disagreement that must STILL
//! disagree (when it starts agreeing the test fails so the row is removed —
//! the `it.fails("DEFECT …")` shape); `Diverges` = an accepted, documented
//! difference (measured, never asserted). Numbers land in
//! `target/chrome-parity-report.json` (`PARITY_REPORT` overrides the path),
//! from which `chrome/parity-table.mjs` regenerates `chrome/PARITY.md`.

#![allow(non_snake_case)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use web_render::capture::render_html;
use web_render::display_list::WebDrawCmd;
use web_render::geometry::{layout_geometry, LayoutGeometry};

/// Content points → CSS px.
const PT_TO_PX: f32 = 96.0 / 72.0;

const ASPECTS: [&str; 4] = ["boxes", "breaks", "lines", "paint"];

/// Rect and line-position tolerance, CSS px.
const TOL_PX: f32 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Expect {
    /// A pinned engine defect: must still disagree.
    Defect(&'static str),
    /// A documented, accepted divergence (oracle limit or product stance).
    Diverges(&'static str),
}

/// (fixture, aspect, expectation). Absent = must agree.
#[rustfmt::skip]
const EXPECT: &[(&str, &str, Expect)] = &[
    ("inline-line-height-normal", "boxes", Expect::Defect("CW-04 line-height: normal is 1.2em, Chrome uses rounded ascent+descent")),
    ("inline-line-height-normal", "lines", Expect::Defect("CW-04 line-height: normal is 1.2em, Chrome uses rounded ascent+descent")),
    ("text-optical-sizing", "boxes", Expect::Defect("CW-05 font-optical-sizing: auto ignored (variable opsz axis stays at its default)")),
    ("text-optical-sizing", "breaks", Expect::Defect("CW-05 font-optical-sizing: auto ignored (variable opsz axis stays at its default)")),
    ("text-optical-sizing", "lines", Expect::Defect("CW-05 font-optical-sizing: auto ignored (variable opsz axis stays at its default)")),
    ("flex-row", "boxes", Expect::Defect("CW-06 max-content (shrink-to-fit) widths are rounded up to whole px")),
    ("flex-row", "lines", Expect::Defect("CW-06 max-content (shrink-to-fit) widths are rounded up to whole px")),
    ("positioned", "boxes", Expect::Defect("CW-06 max-content (shrink-to-fit) widths are rounded up to whole px")),
    ("positioned", "lines", Expect::Defect("CW-06 max-content (shrink-to-fit) widths are rounded up to whole px")),
    ("flex-column", "boxes", Expect::Defect("CW-07 column flex: an auto margin does not absorb free space before justify-content")),
    ("flex-column", "lines", Expect::Defect("CW-07 column flex: an auto margin does not absorb free space before justify-content")),
    ("inline-bold-italic", "boxes", Expect::Defect("CW-10 vertical-align sub/super does not grow the line box")),
    ("inline-bold-italic", "lines", Expect::Defect("CW-10 vertical-align sub/super does not grow the line box")),
    ("inline-hard-breaks", "boxes", Expect::Defect("CW-11 a no-break space (U+00A0) is a break opportunity")),
    ("inline-hard-breaks", "breaks", Expect::Defect("CW-11 a no-break space (U+00A0) is a break opportunity")),
    ("multicol", "boxes", Expect::Defect("CW-12 multi-column layout (column-count) is not implemented")),
    ("multicol", "breaks", Expect::Defect("CW-12 multi-column layout (column-count) is not implemented")),
    ("sizing-percent", "boxes", Expect::Defect("CW-13 percentage padding/margin resolve against the box's own width, not the containing block")),
    ("sizing-percent", "lines", Expect::Defect("CW-13 percentage padding/margin resolve against the box's own width, not the containing block")),
    ("table-basic", "boxes", Expect::Defect("CW-14 border-spacing is not applied at the table's outer edges")),
    ("table-basic", "lines", Expect::Defect("CW-14 border-spacing is not applied at the table's outer edges")),
    ("table-collapse", "boxes", Expect::Defect("CW-15 border-collapse: collapse is not implemented (borders double)")),
    ("table-collapse", "lines", Expect::Defect("CW-15 border-collapse: collapse is not implemented (borders double)")),
    ("positioned-zindex", "boxes", Expect::Diverges("getBoundingClientRect includes the CSS transform; Blitz's layout box is pre-transform (the pre-transform boxes agree)")),
    ("positioned-zindex", "lines", Expect::Diverges("Range rects include the CSS transform; Blitz's layout lines are pre-transform")),
    ("lists-nested", "lines", Expect::Diverges("an inside ::marker is inline text in Blitz (line left = marker) but invisible to Range (line left = first character)")),
];

#[derive(Deserialize)]
struct Recording {
    fixture: String,
    width: u32,
    height: u32,
    elements: Vec<ChromeElement>,
    lines: Vec<ChromeLine>,
    pseudo: Vec<ChromePseudo>,
}

#[derive(Deserialize)]
struct ChromeElement {
    id: String,
    tag: String,
    display: String,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Deserialize, Clone)]
struct ChromeLine {
    owner: String,
    text: String,
    top: f32,
    bottom: f32,
    left: Option<f32>,
    right: Option<f32>,
}

#[derive(Deserialize)]
struct ChromePseudo {
    id: String,
    which: String,
    display: String,
    text: String,
}

/// One aspect's measurement at one width.
#[derive(Debug, Clone, Default, Serialize)]
struct Aspect {
    checked: usize,
    agree: usize,
    /// Largest |delta| seen (px) — boxes / lines only.
    max_delta: f32,
    /// First disagreement, human-readable.
    first: Option<String>,
}

impl Aspect {
    fn ok(&self) -> bool {
        self.checked == self.agree
    }
    fn miss(&mut self, what: String) {
        if self.first.is_none() {
            self.first = Some(what);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct WidthResult {
    width: u32,
    boxes: Aspect,
    breaks: Aspect,
    lines: Aspect,
    paint: Aspect,
    chrome_lines: usize,
    blitz_lines: usize,
}

#[derive(Debug, Clone, Serialize)]
struct FixtureResult {
    fixture: String,
    family: String,
    widths: Vec<WidthResult>,
    /// aspect -> "agree" | "defect: …" | "diverges: …" | "REGRESSION" | "DEFECT FIXED"
    verdicts: BTreeMap<String, String>,
}

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../web-conformance/chrome")
}

fn norm(s: &str) -> String {
    s.replace('\u{ad}', "")
        .replace('\u{a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_marker(w: &str) -> bool {
    matches!(w, "•" | "◦" | "▪" | "■" | "□" | "–")
        || (w.ends_with('.') && w.len() > 1 && w[..w.len() - 1].chars().all(|c| c.is_ascii_digit()))
}

/// Drop an inside `::marker` ("• ", "▪ ", "1. ") from the start of a line.
fn strip_marker(t: &str) -> String {
    match t.split_once(' ') {
        Some((first, rest)) if is_marker(first) => rest.to_string(),
        _ => t.to_string(),
    }
}

fn multiset_minus(a: &[String], b: &[String]) -> Vec<String> {
    let mut b = b.to_vec();
    let mut out = Vec::new();
    for w in a {
        if let Some(i) = b.iter().position(|x| x == w) {
            b.swap_remove(i);
        } else {
            out.push(w.clone());
        }
    }
    out
}

fn family(fixture: &str) -> String {
    fixture.split('-').next().unwrap_or(fixture).to_string()
}

/// Chrome's lines per owner, with generated content folded in (Range client
/// rects cannot see `::before`/`::after`; Blitz lays them out as text).
fn chrome_lines_by_owner(rec: &Recording) -> BTreeMap<String, Vec<(String, Option<ChromeLine>)>> {
    let mut by: BTreeMap<String, Vec<(String, Option<ChromeLine>)>> = BTreeMap::new();
    for l in &rec.lines {
        by.entry(l.owner.clone())
            .or_default()
            .push((l.text.clone(), Some(l.clone())));
    }
    for p in &rec.pseudo {
        let lines = by.entry(p.id.clone()).or_default();
        let inline = p.display.starts_with("inline");
        match (p.which.as_str(), inline) {
            ("before", true) if !lines.is_empty() => {
                lines[0].0 = format!("{}{}", p.text, lines[0].0)
            }
            ("after", true) if !lines.is_empty() => {
                let n = lines.len() - 1;
                lines[n].0 = format!("{}{}", lines[n].0, p.text);
            }
            ("before", _) => lines.insert(0, (p.text.clone(), None)),
            _ => lines.push((p.text.clone(), None)),
        }
    }
    by
}

fn blitz_lines_by_owner(
    g: &LayoutGeometry,
) -> BTreeMap<String, Vec<&web_render::geometry::LineBox>> {
    let mut by: BTreeMap<String, Vec<_>> = BTreeMap::new();
    for l in &g.lines {
        // Lines that carry no visible text (an empty anonymous IFC between
        // blocks) have no Chrome counterpart.
        if norm(&l.text).is_empty() {
            continue;
        }
        let Some(owner) = l.owner.clone() else {
            continue;
        };
        by.entry(owner).or_default().push(l);
    }
    by
}

fn compare(rec: &Recording, html: &str) -> WidthResult {
    let g = layout_geometry(html, rec.width, rec.height);

    // --- boxes ---
    let mut boxes = Aspect::default();
    for ce in &rec.elements {
        if matches!(
            ce.display.as_str(),
            "inline" | "none" | "contents" | "table-row" | "table-row-group" | "table-header-group"
        ) {
            continue;
        }
        boxes.checked += 1;
        let Some(be) = g.elements.iter().find(|e| e.id == ce.id) else {
            boxes.miss(format!("#{} missing in Blitz", ce.id));
            continue;
        };
        let d = [
            (be.x - ce.x).abs(),
            (be.y - ce.y).abs(),
            (be.w - ce.w).abs(),
            (be.h - ce.h).abs(),
        ]
        .into_iter()
        .fold(0.0f32, f32::max);
        boxes.max_delta = boxes.max_delta.max(d);
        if d <= TOL_PX {
            boxes.agree += 1;
        } else {
            boxes.miss(format!(
                "#{} chrome [{:.2} {:.2} {:.2}x{:.2}] blitz [{:.2} {:.2} {:.2}x{:.2}]",
                ce.id, ce.x, ce.y, ce.w, ce.h, be.x, be.y, be.w, be.h
            ));
        }
    }

    // --- breaks + lines ---
    let chrome = chrome_lines_by_owner(rec);
    let blitz = blitz_lines_by_owner(&g);
    let mut breaks = Aspect::default();
    let mut lines = Aspect::default();
    let chrome_lines = chrome.values().map(Vec::len).sum();
    let blitz_lines = blitz.values().map(Vec::len).sum();
    let owners: std::collections::BTreeSet<&String> = chrome.keys().chain(blitz.keys()).collect();
    for owner in owners {
        breaks.checked += 1;
        let c: Vec<String> = chrome
            .get(owner)
            .map(|v| v.iter().map(|(t, _)| norm(t)).collect())
            .unwrap_or_default();
        let is_li = rec.elements.iter().any(|e| &e.id == owner && e.tag == "li");
        let b: Vec<String> = blitz
            .get(owner)
            .map(|v| {
                v.iter()
                    .enumerate()
                    .map(|(i, l)| {
                        let t = norm(&l.text);
                        if i == 0 && is_li {
                            strip_marker(&t)
                        } else {
                            t
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        if c == b {
            breaks.agree += 1;
        } else {
            let i = c.iter().zip(&b).take_while(|(x, y)| x == y).count();
            breaks.miss(format!(
                "#{owner}: {} vs {} lines; first diff at line {i}: chrome {:?} blitz {:?}",
                c.len(),
                b.len(),
                c.get(i).map(String::as_str).unwrap_or("<none>"),
                b.get(i).map(String::as_str).unwrap_or("<none>"),
            ));
            continue;
        }
        let (Some(cv), Some(bv)) = (chrome.get(owner), blitz.get(owner)) else {
            continue;
        };
        for ((_, cl), bl) in cv.iter().zip(bv) {
            let Some(cl) = cl else { continue };
            lines.checked += 1;
            let mut d = (bl.top_rounded - cl.top)
                .abs()
                .max((bl.bottom_rounded - cl.bottom).abs());
            if let (Some(a), Some(b)) = (cl.left, bl.left) {
                d = d.max((a - b).abs());
            }
            if let (Some(a), Some(b)) = (cl.right, bl.right) {
                d = d.max((a - b).abs());
            }
            lines.max_delta = lines.max_delta.max(d);
            if d <= TOL_PX {
                lines.agree += 1;
            } else {
                lines.miss(format!(
                    "#{owner} {:?}: chrome t{:.2} b{:.2} l{:?} r{:?} blitz t{:.2} b{:.2} l{:?} r{:?}",
                    norm(&cl.text),
                    cl.top,
                    cl.bottom,
                    cl.left,
                    cl.right,
                    bl.top_rounded,
                    bl.bottom_rounded,
                    bl.left,
                    bl.right
                ));
            }
        }
    }

    // --- paint: the words the CAPTURE recovers onto glyph runs (what the
    // canvas shows) against the words Chrome laid out, as multisets ---
    let mut paint = Aspect {
        checked: 1,
        ..Aspect::default()
    };
    let mut painted: Vec<String> = Vec::new();
    let mut misplaced: Vec<String> = Vec::new();
    for cmd in &render_html(html, rec.width, rec.height).commands {
        if let WebDrawCmd::GlyphRun(r) = cmd {
            let t = norm(&r.text);
            painted.extend(t.split(' ').filter(|w| !w.is_empty()).map(String::from));
            // The run must sit on a line of Blitz's OWN layout that carries
            // its text (capture vs layout — independent of Chrome).
            let (x, y) = (r.baseline_x * PT_TO_PX, r.baseline_y * PT_TO_PX);
            let on_line = t.is_empty()
                || g.lines.iter().any(|l| {
                    (l.baseline - y).abs() <= 1.0
                        && l.right.is_none_or(|b| x <= b + 1.0)
                        && norm(&l.text).contains(&t)
                });
            // Transformed content paints away from its layout box; an
            // outside list marker paints left of its item's lines by design.
            let marker = !t.is_empty() && t.split(' ').all(is_marker);
            if !on_line && !marker && !html.contains("transform:") {
                misplaced.push(t);
            }
        }
    }
    let mut expected: Vec<String> = chrome
        .values()
        .flatten()
        .flat_map(|(t, _)| {
            norm(t)
                .split(' ')
                .filter(|w| !w.is_empty())
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .collect();
    // List markers are painted text in Blitz but invisible to Range.
    painted.retain(|w| !is_marker(w) || expected.contains(w));
    painted.sort();
    expected.sort();
    if painted == expected && misplaced.is_empty() {
        paint.agree = 1;
    } else if painted == expected {
        paint.max_delta = misplaced.len() as f32;
        paint.miss(format!(
            "{} runs painted off their layout line, e.g. {:?}",
            misplaced.len(),
            &misplaced[..misplaced.len().min(3)]
        ));
    } else {
        let missing = multiset_minus(&expected, &painted);
        let extra = multiset_minus(&painted, &expected);
        paint.max_delta = (missing.len() + extra.len()) as f32;
        paint.miss(format!(
            "{} words missing {:?}, {} extra {:?}",
            missing.len(),
            &missing[..missing.len().min(6)],
            extra.len(),
            &extra[..extra.len().min(6)]
        ));
    }

    WidthResult {
        width: rec.width,
        boxes,
        breaks,
        lines,
        paint,
        chrome_lines,
        blitz_lines,
    }
}

fn recordings() -> BTreeMap<String, Vec<Recording>> {
    let dir = conformance_dir().join("recorded");
    let mut by: BTreeMap<String, Vec<Recording>> = BTreeMap::new();
    let mut paths: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    for p in paths {
        let rec: Recording = serde_json::from_str(&fs::read_to_string(&p).unwrap())
            .unwrap_or_else(|e| panic!("parse {}: {e}", p.display()));
        by.entry(rec.fixture.clone()).or_default().push(rec);
    }
    by
}

fn run_fixture(fixture: &str, recs: &[Recording]) -> FixtureResult {
    let html = fs::read_to_string(
        conformance_dir()
            .join("fixtures")
            .join(format!("{fixture}.html")),
    )
    .unwrap_or_else(|e| panic!("fixture {fixture}: {e}"));
    let widths: Vec<WidthResult> = recs.iter().map(|r| compare(r, &html)).collect();
    let mut verdicts = BTreeMap::new();
    for aspect in ASPECTS {
        let ok = widths.iter().all(|w| match aspect {
            "boxes" => w.boxes.ok(),
            "paint" => w.paint.ok(),
            "breaks" => w.breaks.ok(),
            _ => w.lines.ok(),
        });
        let expect = EXPECT
            .iter()
            .find(|(f, a, _)| *f == fixture && *a == aspect)
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
    FixtureResult {
        fixture: fixture.to_string(),
        family: family(fixture),
        widths,
        verdicts,
    }
}

static SHAPING: Mutex<()> = Mutex::new(());
static REPORT: Mutex<Vec<FixtureResult>> = Mutex::new(Vec::new());

fn write_report() {
    let all = REPORT.lock().unwrap();
    let path = std::env::var("PARITY_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/chrome-parity-report.json")
        });
    let mut sorted = all.clone();
    sorted.sort_by(|a, b| a.fixture.cmp(&b.fixture));
    let _ = fs::create_dir_all(path.parent().unwrap());
    fs::write(&path, serde_json::to_string_pretty(&sorted).unwrap()).unwrap();
}

/// Run every fixture of `family`, record the numbers, and fail on any
/// regression or fixed-but-still-pinned defect.
fn check_family(fam: &str) {
    // Shaping shares process state in parley/fontique: concurrent layouts
    // move lines by sub-pixels (see `capture::SHAPE_LOCK`, test-only in the
    // lib). Serialise the families so the tolerances measure layout.
    let _guard = SHAPING.lock().unwrap_or_else(|e| e.into_inner());
    let recs = recordings();
    let mut problems = Vec::new();
    let mut n = 0;
    for (fixture, rs) in recs.iter().filter(|(f, _)| family(f) == fam) {
        n += 1;
        let r = run_fixture(fixture, rs);
        for (aspect, v) in &r.verdicts {
            let detail = r
                .widths
                .iter()
                .filter_map(|w| {
                    let a = match aspect.as_str() {
                        "boxes" => &w.boxes,
                        "paint" => &w.paint,
                        "breaks" => &w.breaks,
                        _ => &w.lines,
                    };
                    a.first.as_ref().map(|f| format!("@{}: {f}", w.width))
                })
                .collect::<Vec<_>>()
                .join(" | ");
            println!("{fixture:28} {aspect:6} {v}  {detail}");
            if v == "REGRESSION" || v.starts_with("DEFECT FIXED") {
                problems.push(format!("{fixture} {aspect}: {v} — {detail}"));
            }
        }
        REPORT.lock().unwrap().push(r);
    }
    write_report();
    assert!(n > 0, "no recordings for family {fam}");
    assert!(
        problems.is_empty(),
        "chrome parity, family {fam}:\n{}",
        problems.join("\n")
    );
}

macro_rules! family_tests {
    ($($name:ident => $fam:literal),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                check_family($fam);
            }
        )*
    };
}

family_tests! {
    chrome_parity_blocks__feat__plugin_web_chrome_parity => "blocks",
    chrome_parity_inline__feat__plugin_web_chrome_parity => "inline",
    chrome_parity_text__feat__plugin_web_chrome_parity => "text",
    chrome_parity_lists__feat__plugin_web_chrome_parity => "lists",
    chrome_parity_table__feat__plugin_web_chrome_parity => "table",
    chrome_parity_flex__feat__plugin_web_chrome_parity => "flex",
    chrome_parity_grid__feat__plugin_web_chrome_parity => "grid",
    chrome_parity_floats__feat__plugin_web_chrome_parity => "floats",
    chrome_parity_positioned__feat__plugin_web_chrome_parity => "positioned",
    chrome_parity_multicol__feat__plugin_web_chrome_parity => "multicol",
    chrome_parity_pseudo__feat__plugin_web_chrome_parity => "pseudo",
    chrome_parity_paint__feat__plugin_web_chrome_parity => "paint",
    chrome_parity_sizing__feat__plugin_web_chrome_parity => "sizing",
    chrome_parity_headings__feat__plugin_web_chrome_parity => "headings",
}

/// Every recording's fixture exists, and every fixture has a recording.
#[test]
fn chrome_recordings_cover_every_fixture__feat__plugin_web_chrome_parity() {
    let recs = recordings();
    let fixtures: Vec<String> = fs::read_dir(conformance_dir().join("fixtures"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".html"))
                .map(String::from)
        })
        .collect();
    for f in &fixtures {
        assert!(
            recs.contains_key(f),
            "fixture {f} has no recording — run chrome/record.mjs"
        );
    }
    for f in recs.keys() {
        assert!(fixtures.contains(f), "recording for missing fixture {f}");
    }
    // Every EXPECT row names a real fixture + aspect.
    for (f, a, _) in EXPECT {
        assert!(
            fixtures.iter().any(|x| x == f),
            "EXPECT row for unknown fixture {f}"
        );
        assert!(ASPECTS.contains(a), "EXPECT row with unknown aspect {a}");
    }
}
