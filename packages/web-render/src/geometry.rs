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

//! Layout geometry readout (feature = "blitz") — the box rects and line boxes
//! Blitz computed for a document, in CSS px page space, in the SAME shape the
//! Chrome oracle records (`packages/web-conformance/chrome/record.mjs`).
//!
//! The paint capture ([`crate::capture`]) only sees what is painted, in
//! points, after transforms; a conformance check needs the LAYOUT: every
//! `[data-id]` element's border box and every line of every inline
//! formatting context with the text on it. This module reads both straight
//! from the resolved `BaseDocument` (Taffy's unrounded layout + each inline
//! root's Parley layout). It is read-only and never part of a render; the
//! replay lane is `tests/chrome_parity.rs`.
//!
//! Coordinates are Taffy's UNROUNDED layout (Chrome's `getBoundingClientRect`
//! is fractional too), so a delta measures the layout algorithm, not Blitz's
//! pixel snapping (which `final_layout` applies before paint).

use blitz_dom::{BaseDocument, DocumentConfig, Node};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use parley::PositionedLayoutItem;
use serde::Serialize;

use crate::fonts::build_font_ctx;

/// One `[data-id]` element's border box (CSS px, page space, unrounded).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ElementBox {
    pub id: String,
    pub tag: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// One line of one inline formatting context (CSS px, page space).
///
/// `top`/`bottom` span the glyph runs' content areas (baseline − ascent ..
/// baseline + descent — what Chrome's Range client rects report per glyph);
/// `left`/`right` span the non-whitespace clusters.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LineBox {
    /// `data-id` of the nearest ancestor-or-self of the inline root that has
    /// one (`None` when no ancestor is tagged).
    pub owner: Option<String>,
    pub text: String,
    pub top: f32,
    pub bottom: f32,
    pub baseline: f32,
    /// Largest glyph-run ascent / descent on the line (px, unrounded).
    pub ascent: f32,
    pub descent: f32,
    /// `top`/`bottom` again, with each run's ascent and descent rounded to
    /// whole px first — how Chrome (Skia font metrics) reports a glyph box,
    /// so a comparison against Chrome measures the baseline, not rounding.
    pub top_rounded: f32,
    pub bottom_rounded: f32,
    pub left: Option<f32>,
    pub right: Option<f32>,
}

/// The whole readout for one document at one viewport.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct LayoutGeometry {
    pub elements: Vec<ElementBox>,
    pub lines: Vec<LineBox>,
}

/// Parse, style and lay out `html` at `width_px` x `height_px` with the
/// bundled font context (exactly as [`crate::capture::render_html`] does),
/// then read the geometry. No paint.
pub fn layout_geometry(html: &str, width_px: u32, height_px: u32) -> LayoutGeometry {
    #[cfg(test)]
    let _shape_guard = crate::capture::SHAPE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let config = DocumentConfig {
        font_ctx: Some(build_font_ctx()),
        ..Default::default()
    };
    let mut doc = HtmlDocument::from_html(html, config);
    doc.set_viewport(Viewport::new(width_px, height_px, 1.0, ColorScheme::Light));
    doc.resolve(0.0);
    read_geometry(&doc)
}

/// Read the geometry of an already-resolved document.
pub fn read_geometry(doc: &BaseDocument) -> LayoutGeometry {
    let mut out = LayoutGeometry::default();
    let mut seen = std::collections::HashSet::new();
    walk(doc, doc.root_node().id, &mut seen, &mut out);
    out
}

fn data_id(node: &Node) -> Option<&str> {
    node.element_data()?
        .attrs()
        .iter()
        .find(|a| &*a.name.local == "data-id")
        .map(|a| a.value.as_str())
}

/// Page-space origin of `node`'s border box from Taffy's UNROUNDED layout.
fn abs_origin(doc: &BaseDocument, node: &Node) -> (f32, f32) {
    let mut x = 0.0f32;
    let mut y = 0.0f32;
    let mut cur = Some(node);
    while let Some(n) = cur {
        x += n.unrounded_layout.location.x - n.scroll_offset.x as f32;
        y += n.unrounded_layout.location.y - n.scroll_offset.y as f32;
        cur = n.layout_parent.get().and_then(|p| doc.get_node(p));
    }
    (x, y)
}

fn owner_of(doc: &BaseDocument, node: &Node) -> Option<String> {
    let mut cur = Some(node);
    while let Some(n) = cur {
        if let Some(id) = data_id(n) {
            return Some(id.to_string());
        }
        let up = n.parent.or_else(|| n.layout_parent.get());
        cur = up.and_then(|p| doc.get_node(p));
    }
    None
}

fn walk(
    doc: &BaseDocument,
    node_id: usize,
    seen: &mut std::collections::HashSet<usize>,
    out: &mut LayoutGeometry,
) {
    if !seen.insert(node_id) {
        return;
    }
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    if let (Some(id), Some(el)) = (data_id(node), node.element_data()) {
        let (x, y) = abs_origin(doc, node);
        out.elements.push(ElementBox {
            id: id.to_string(),
            tag: el.name.local.to_string(),
            x,
            y,
            w: node.unrounded_layout.size.width,
            h: node.unrounded_layout.size.height,
        });
    }
    if node.flags.is_inline_root() {
        if let Some(ild) = node
            .element_data()
            .and_then(|e| e.inline_layout_data.as_ref())
        {
            let (bx, by) = abs_origin(doc, node);
            let l = &node.unrounded_layout;
            let cx = bx + l.border.left + l.padding.left;
            let cy = by + l.border.top + l.padding.top;
            let owner = owner_of(doc, node);
            for line in ild.layout.lines() {
                let text = ild
                    .text
                    .get(line.text_range())
                    .unwrap_or_default()
                    .to_string();
                let m = line.metrics();
                let mut top = f32::INFINITY;
                let mut bottom = f32::NEG_INFINITY;
                let mut left = f32::INFINITY;
                let mut right = f32::NEG_INFINITY;
                let mut top_r = f32::INFINITY;
                let mut bottom_r = f32::NEG_INFINITY;
                let mut ascent = 0.0f32;
                let mut descent = 0.0f32;
                // A parley Run is split into several GlyphRuns where the
                // style changes; walk each Run's clusters once, from the
                // offset of its first GlyphRun.
                let mut last_run: Option<usize> = None;
                for item in line.items() {
                    let PositionedLayoutItem::GlyphRun(gr) = item else {
                        continue;
                    };
                    let run = gr.run();
                    let rm = run.metrics();
                    ascent = ascent.max(rm.ascent);
                    descent = descent.max(rm.descent);
                    top = top.min(gr.baseline() - rm.ascent);
                    bottom = bottom.max(gr.baseline() + rm.descent);
                    top_r = top_r.min(gr.baseline() - rm.ascent.round());
                    bottom_r = bottom_r.max(gr.baseline() + rm.descent.round());
                    if last_run == Some(run.index()) {
                        continue;
                    }
                    last_run = Some(run.index());
                    let mut x = gr.offset();
                    for cluster in run.visual_clusters() {
                        let adv = cluster.advance();
                        let ws = cluster.is_space_or_nbsp()
                            || cluster.is_hard_line_break()
                            || ild.text.get(cluster.text_range()).is_some_and(|s| {
                                s.chars().all(|c| c.is_whitespace() || c == '\u{ad}')
                            });
                        if !ws && adv > 0.0 {
                            left = left.min(x);
                            right = right.max(x + adv);
                        }
                        x += adv;
                    }
                }
                if !top.is_finite() {
                    // A line with no glyph run (an inline box only, or an
                    // empty line) — keep the line box itself.
                    top = m.block_min_coord;
                    bottom = m.block_max_coord;
                    top_r = top;
                    bottom_r = bottom;
                }
                out.lines.push(LineBox {
                    owner: owner.clone(),
                    text,
                    top: cy + top,
                    bottom: cy + bottom,
                    baseline: cy + m.baseline,
                    ascent,
                    descent,
                    top_rounded: cy + top_r,
                    bottom_rounded: cy + bottom_r,
                    left: left.is_finite().then_some(cx + left),
                    right: right.is_finite().then_some(cx + right),
                });
            }
        }
    }
    // Anonymous block wrappers exist only in `layout_children`, and the
    // pseudo-element nodes only in `before`/`after`; walk the union (each
    // node once).
    if let Some(b) = node.before {
        walk(doc, b, seen, out);
    }
    let layout_children = node.layout_children.borrow().clone().unwrap_or_default();
    for child in layout_children
        .into_iter()
        .chain(node.children.iter().copied())
    {
        walk(doc, child, seen, out);
    }
    if let Some(a) = node.after {
        walk(doc, a, seen, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn reads_block_rects_and_lines__feat__plugin_web_engine_rendering() {
        let g = layout_geometry(
            r#"<html><head><style>body{margin:0;font-family:Inter}
            p{margin:10px 0;padding:4px}</style></head><body>
            <p data-id="a">Hello world</p><p data-id="b">Second</p></body></html>"#,
            300,
            400,
        );
        let a = g.elements.iter().find(|e| e.id == "a").expect("a");
        let b = g.elements.iter().find(|e| e.id == "b").expect("b");
        assert_eq!(a.x, 0.0);
        assert_eq!(a.w, 300.0);
        // Adjacent vertical margins collapse: b starts 10px below a.
        assert!((b.y - (a.y + a.h + 10.0)).abs() < 0.01, "{a:?} {b:?}");
        let la: Vec<_> = g
            .lines
            .iter()
            .filter(|l| l.owner.as_deref() == Some("a"))
            .collect();
        assert_eq!(la.len(), 1);
        assert_eq!(la[0].text.trim(), "Hello world");
        // Text starts inside the 4px padding.
        assert!((la[0].left.unwrap() - 4.0).abs() < 0.5, "{la:?}");
    }
}
