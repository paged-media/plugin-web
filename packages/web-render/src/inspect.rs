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

//! The INSPECTED render (feature = `blitz`): one frame's scene layer plus
//! the map back from what is painted to the DOM it came from — what in-frame
//! editing and the outline highlight need.
//!
//! - `text` — every line of every inline formatting context, with each
//!   CLUSTER's position and the DOM text node (and UTF-16 offset in it) the
//!   cluster's characters come from. A text node is named by its ORDINAL:
//!   its index among the text nodes under `<body>` that hold something
//!   other than whitespace, in document order. The bundle's source scanner
//!   (`web-model/src/source-text.ts`) numbers the source's text the same
//!   way, and checks the node's text (`text.nodes`) before it edits.
//! - `boxes` — every element under `<body>` with its border box and its
//!   occurrence among the elements of its tag (`p` #3), the key the source
//!   outline uses.
//!
//! All coordinates are frame-content points, like the scene layer. It is the
//! same parse, resolve and paint as [`crate::capture::render_html`] (one of
//! each), read once more for the maps.
//!
//! Mapping a cluster to its text node: the engine builds an inline context's
//! text by concatenating, in order, its text nodes, generated content and
//! hard breaks, then collapses white space. Collapsing never touches the
//! other characters, so the n-th non-white-space character of the inline
//! text is the n-th non-white-space character of that concatenation (the
//! same invariant the flow's line split rests on). An inside list marker
//! comes first and is not in the DOM; it is the surplus at the start.

use std::collections::HashMap;

use blitz_dom::{BaseDocument, DocumentConfig, Node};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use parley::PositionedLayoutItem;
use serde::Serialize;

use crate::capture::capture_resolved;
use crate::fonts::font_ctx;
use crate::perf::{self, Counter};
use crate::wire::SceneLayer;

const PX_TO_PT: f32 = 72.0 / 96.0;

/// Positions cross the boundary at 1/100 pt — finer than any hit or caret
/// needs, and a third of the bytes of a full float.
fn r2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// One DOM text node (non-white-space) by ordinal, with its text.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextNodeInfo {
    pub n: usize,
    pub text: String,
}

/// One line: its vertical extent and baseline (points) and its clusters as
/// `[x, width, node ordinal (-1 = none), UTF-16 offset in the node, UTF-16
/// length]`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextLine {
    pub top: f32,
    pub bottom: f32,
    pub baseline: f32,
    pub c: Vec<(f32, f32, i32, u32, u32)>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct TextMap {
    pub nodes: Vec<TextNodeInfo>,
    pub lines: Vec<TextLine>,
}

/// One element's border box (points) keyed by tag and occurrence.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ElementBox {
    pub tag: String,
    pub n: usize,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Inspected {
    pub layer: SceneLayer,
    pub text: TextMap,
    pub boxes: Vec<ElementBox>,
}

/// Render one frame and read the maps (see the module docs).
pub fn render_inspected(html: &str, width_px: u32, height_px: u32) -> Inspected {
    #[cfg(test)]
    let _shape_guard = crate::capture::SHAPE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let config = DocumentConfig {
        font_ctx: Some(font_ctx()),
        ..Default::default()
    };
    let mut doc = HtmlDocument::from_html(html, config);
    perf::bump(Counter::HtmlParses, 1);
    crate::break_rules::apply_page_box(&mut doc);
    doc.set_viewport(Viewport::new(width_px, height_px, 1.0, ColorScheme::Light));
    doc.resolve(0.0);
    perf::bump(Counter::Resolves, 1);
    let dl = capture_resolved(&mut doc, width_px, height_px);
    let layer = crate::lower::lower(&dl).layer;
    let (text, boxes) = read_maps(&doc);
    Inspected { layer, text, boxes }
}

/// The body of the `render_web_frame_inspect` export.
pub fn render_web_frame_inspect_json(html: &str, width_px: u32, height_px: u32) -> String {
    perf::bump(Counter::BytesIn, html.len() as u64);
    let out =
        serde_json::to_string(&render_inspected(html, width_px, height_px)).unwrap_or_else(|_| {
            "{\"layer\":{\"items\":[]},\"text\":{\"nodes\":[],\"lines\":[]},\"boxes\":[]}"
                .to_string()
        });
    perf::bump(Counter::BytesOut, out.len() as u64);
    out
}

fn body(doc: &BaseDocument) -> Option<usize> {
    doc.query_selector("body").ok().flatten()
}

/// Read the text map and the element boxes of a resolved document.
pub fn read_maps(doc: &BaseDocument) -> (TextMap, Vec<ElementBox>) {
    let mut map = TextMap::default();
    let mut boxes = Vec::new();
    let Some(body) = body(doc) else {
        return (map, boxes);
    };
    // Ordinals and boxes: document order over `children`.
    let mut ordinal: HashMap<usize, usize> = HashMap::new();
    let mut per_tag: HashMap<String, usize> = HashMap::new();
    let mut stack: Vec<usize> = doc
        .get_node(body)
        .map(|n| n.children.iter().rev().copied().collect())
        .unwrap_or_default();
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        if node.is_text_node() {
            let text = node.text_content();
            if !text.trim().is_empty() {
                let n = map.nodes.len();
                ordinal.insert(id, n);
                map.nodes.push(TextNodeInfo { n, text });
            }
            continue;
        }
        if let Some(el) = node.element_data() {
            let tag = el.name.local.to_string();
            let n = per_tag.entry(tag.clone()).or_insert(0);
            let p = node.absolute_position(0.0, 0.0);
            let size = node.final_layout.size;
            boxes.push(ElementBox {
                tag,
                n: *n,
                x: r2(p.x * PX_TO_PT),
                y: r2(p.y * PX_TO_PT),
                w: r2(size.width * PX_TO_PT),
                h: r2(size.height * PX_TO_PT),
            });
            *n += 1;
            // Raw-text and form elements hold no editable text; the source
            // scanner skips their content too.
            if NO_TEXT.contains(&&*el.name.local) {
                continue;
            }
        }
        stack.extend(node.children.iter().rev().copied());
    }
    // Lines: every inline root (walking layout children too, so anonymous
    // blocks are found).
    let mut seen = std::collections::HashSet::new();
    walk_inline_roots(doc, doc.root_node().id, &mut seen, &mut |root| {
        read_lines(doc, root, &ordinal, &mut map.lines)
    });
    (map, boxes)
}

fn walk_inline_roots(
    doc: &BaseDocument,
    id: usize,
    seen: &mut std::collections::HashSet<usize>,
    f: &mut dyn FnMut(&Node),
) {
    if !seen.insert(id) {
        return;
    }
    let Some(node) = doc.get_node(id) else {
        return;
    };
    if node.flags.is_inline_root()
        && node
            .element_data()
            .is_some_and(|e| e.inline_layout_data.is_some())
    {
        f(node);
    }
    let layout_children = node.layout_children.borrow().clone().unwrap_or_default();
    for c in layout_children
        .into_iter()
        .chain(node.children.iter().copied())
    {
        walk_inline_roots(doc, c, seen, f);
    }
}

/// A piece of an inline context's text: from a DOM text node, or not
/// (generated content, a hard break).
struct Seg {
    node: Option<usize>,
    text: String,
}

/// Elements whose content is not numbered as text (raw text, form text,
/// templates) — the same list as `web-model/src/source-text.ts`.
const NO_TEXT: [&str; 10] = [
    "style", "script", "template", "textarea", "title", "noscript", "iframe", "xmp", "noembed",
    "noframes",
];

const REPLACED: [&str; 5] = ["img", "svg", "input", "textarea", "button"];

/// The pieces of `root`'s inline text, in the order the engine builds it.
fn segments(doc: &BaseDocument, root: &Node) -> Vec<Seg> {
    let mut out = Vec::new();
    if let Some(b) = root.before {
        push_segments(doc, b, true, &mut out);
    }
    for &c in &root.children {
        push_segments(doc, c, false, &mut out);
    }
    if let Some(a) = root.after {
        push_segments(doc, a, true, &mut out);
    }
    out
}

fn push_segments(doc: &BaseDocument, id: usize, generated: bool, out: &mut Vec<Seg>) {
    let Some(node) = doc.get_node(id) else {
        return;
    };
    if node.is_text_node() {
        out.push(Seg {
            node: (!generated).then_some(id),
            text: node.text_content(),
        });
        return;
    }
    let Some(el) = node.element_data() else {
        return; // a comment
    };
    let display = node.primary_styles().map(|s| s.clone_display());
    if let Some(d) = display {
        if d.is_none() {
            return;
        }
        if d.is_contents() {
            for &c in &node.children {
                push_segments(doc, c, generated, out);
            }
            return;
        }
        if !d.is_inline_flow() {
            return; // an inline box: its text is its own inline context
        }
    }
    let tag: &str = &el.name.local;
    if REPLACED.contains(&tag) {
        return;
    }
    if tag == "br" {
        out.push(Seg {
            node: None,
            text: "\n".to_string(),
        });
        return;
    }
    if let Some(b) = node.before {
        push_segments(doc, b, true, out);
    }
    for &c in &node.children {
        push_segments(doc, c, generated, out);
    }
    if let Some(a) = node.after {
        push_segments(doc, a, true, out);
    }
}

/// Per non-white-space character of the segments, in order: the text node
/// and the UTF-16 offsets of the character's start and end in it.
fn nws_positions(segs: &[Seg]) -> Vec<(Option<usize>, u32, u32)> {
    let mut out = Vec::new();
    for s in segs {
        let mut off = 0u32;
        for ch in s.text.chars() {
            let len = ch.len_utf16() as u32;
            if !ch.is_whitespace() {
                out.push((s.node, off, off + len));
            }
            off += len;
        }
    }
    out
}

fn read_lines(
    doc: &BaseDocument,
    root: &Node,
    ordinal: &HashMap<usize, usize>,
    out: &mut Vec<TextLine>,
) {
    let Some(ild) = root
        .element_data()
        .and_then(|e| e.inline_layout_data.as_ref())
    else {
        return;
    };
    let text = &ild.text;
    let positions = nws_positions(&segments(doc, root));
    let total_nws = text.chars().filter(|c| !c.is_whitespace()).count();
    // An inside list marker leads the inline text and is not in the DOM.
    let surplus = total_nws.saturating_sub(positions.len());
    // Non-white-space characters before each byte offset.
    let mut nws_before = vec![0usize; text.len() + 1];
    let mut k = 0usize;
    for (i, ch) in text.char_indices() {
        nws_before[i] = k;
        if !ch.is_whitespace() {
            k += 1;
        }
    }
    nws_before[text.len()] = k;
    let lay = &root.final_layout;
    let inset_x = lay.border.left + lay.padding.left;
    let inset_y = lay.border.top + lay.padding.top;
    let to_pt = |x: f32, y: f32| {
        let p = root.absolute_position(inset_x + x, inset_y + y);
        (p.x * PX_TO_PT, p.y * PX_TO_PT)
    };
    let node_of = |n: Option<usize>| -> i32 {
        n.and_then(|id| ordinal.get(&id))
            .map(|o| *o as i32)
            .unwrap_or(-1)
    };
    for line in ild.layout.lines() {
        let m = line.metrics();
        let (_, top) = to_pt(0.0, m.block_min_coord);
        let (_, bottom) = to_pt(0.0, m.block_max_coord);
        let (_, baseline) = to_pt(0.0, m.baseline);
        let mut clusters = Vec::new();
        let mut last_run: Option<usize> = None;
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(gr) = item else {
                continue;
            };
            let run = gr.run();
            if last_run == Some(run.index()) {
                continue;
            }
            last_run = Some(run.index());
            let mut x = gr.offset();
            for cluster in run.visual_clusters() {
                let adv = cluster.advance();
                let r = cluster.text_range();
                let slice = text.get(r.clone()).unwrap_or("");
                let (px, _) = to_pt(x, 0.0);
                x += adv;
                let k = nws_before.get(r.start).copied().unwrap_or(0);
                let ws = slice.chars().all(char::is_whitespace);
                let (node, off, len) = if !ws {
                    match k.checked_sub(surplus).and_then(|i| positions.get(i)) {
                        Some(&(n, start, _)) => {
                            let len: u32 = slice
                                .chars()
                                .filter(|c| !c.is_whitespace())
                                .map(|c| c.len_utf16() as u32)
                                .sum();
                            (node_of(n), start, len)
                        }
                        None => (-1, 0, 0),
                    }
                } else {
                    // White space sits right after the previous character.
                    match k.checked_sub(surplus + 1).and_then(|i| positions.get(i)) {
                        Some(&(n, _, end)) => (node_of(n), end, 1),
                        None => (-1, 0, 0),
                    }
                };
                clusters.push((r2(px), r2(adv * PX_TO_PT), node, off, len));
            }
        }
        out.push(TextLine {
            top: r2(top),
            bottom: r2(bottom),
            baseline: r2(baseline),
            c: clusters,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(body: &str) -> String {
        format!(
            "<html><head><style>body{{margin:0;font-family:Inter}}p{{margin:0}}</style></head>\
             <body>{body}</body></html>"
        )
    }

    #[test]
    #[allow(non_snake_case)]
    fn clusters_map_to_their_text_nodes_across_inline_elements__feat__plugin_web_in_frame_edit() {
        let ins = render_inspected(
            &page("<p>Hello <b>bold</b>  world</p>\n<p>Second</p>"),
            400,
            300,
        );
        let texts: Vec<&str> = ins.text.nodes.iter().map(|n| n.text.as_str()).collect();
        assert_eq!(texts, ["Hello ", "bold", "  world", "Second"]);
        let first = &ins.text.lines[0];
        // "H" → node 0 offset 0; "b" of bold → node 1 offset 0; "w" → node 2
        // offset 2 (after the two raw spaces the engine collapsed).
        let mapped: Vec<(i32, i32)> = first
            .c
            .iter()
            .filter(|c| c.4 > 0 && c.2 >= 0)
            .map(|c| (c.2, c.3 as i32))
            .collect();
        assert_eq!(mapped[0], (0, 0));
        assert!(mapped.contains(&(1, 0)), "{mapped:?}");
        assert!(mapped.contains(&(2, 2)), "{mapped:?}");
        // Clusters advance left to right.
        assert!(first.c.windows(2).all(|w| w[1].0 >= w[0].0));
        assert!(ins.text.lines[1].c.iter().any(|c| c.2 == 3));
        assert!(!ins.layer.items.is_empty());
    }

    #[test]
    #[allow(non_snake_case)]
    fn generated_content_and_markers_map_to_no_node__feat__plugin_web_in_frame_edit() {
        let html = "<html><head><style>body{margin:0;font-family:Inter}\
            p::before{content:'Note: '} li{list-style-position:inside}</style></head>\
            <body><p>text</p><ul><li>item</li></ul></body></html>";
        let ins = render_inspected(html, 400, 300);
        let all: Vec<(f32, f32, i32, u32, u32)> =
            ins.text.lines.iter().flat_map(|l| l.c.clone()).collect();
        // "t" of "text" is node 0 offset 0, "i" of "item" node 1 offset 0;
        // the generated "Note:" and the marker map to no node.
        assert!(all.iter().any(|c| c.2 == 0 && c.3 == 0));
        assert!(all.iter().any(|c| c.2 == 1 && c.3 == 0));
        assert!(all.iter().filter(|c| c.4 > 0).any(|c| c.2 < 0));
    }

    #[test]
    #[allow(non_snake_case)]
    fn boxes_are_keyed_by_tag_and_occurrence__feat__plugin_web_outline_canvas() {
        let ins = render_inspected(&page("<p>a</p><div><p>b</p></div>"), 400, 300);
        let p1 = ins
            .boxes
            .iter()
            .find(|b| b.tag == "p" && b.n == 1)
            .expect("p #1");
        let p0 = ins
            .boxes
            .iter()
            .find(|b| b.tag == "p" && b.n == 0)
            .expect("p #0");
        assert!(p1.y > p0.y);
        assert_eq!(p0.w, 300.0);
    }
}
