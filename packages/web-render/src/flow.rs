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

//! **W-frag spike** (feature = `blitz`) — fragmenting ONE HTML flow across
//! MULTIPLE frames. This is a FEASIBILITY PROTOTYPE, not shipped product: it
//! answers ADR-020's open question ("can Blitz be driven to thread a flow
//! across frames without a deep fork?") empirically. Scope + the 4-rung
//! ladder: `thoughts/docs/paged/plugin-web/w-frag-spike-brief.md`.
//!
//! Gated behind `blitz` so it never touches the default build or the bundle
//! CI gate. Two rungs are built here:
//!
//! - **Rung 1 — [`render_web_flow_equalwidth`]**: layout+paint ONCE at the
//!   (shared) frame width via [`crate::capture::render_html`], then SLICE the
//!   flat display list into per-frame lists by vertical band. No new Blitz
//!   API — proves the equal-width case is pure display-list surgery.
//! - **Rung 2 — [`render_web_flow_variable`]**: resolve at frame A's width,
//!   find the block break from Taffy geometry, delete the consumed prefix via
//!   `DocumentMutator`, re-`set_viewport`+`resolve` at frame B's width so the
//!   remainder RE-WRAPS, and paint each frame. Proves variable-width threading
//!   is reachable through the pinned `BaseDocument`/mutator API — at block
//!   granularity (mid-paragraph split is the honest follow-on).

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use serde::{Deserialize, Serialize};

use crate::capture::{capture_resolved, render_html};
use crate::display_list::{WebDisplayList, WebDrawCmd, WebGlyphRun, WebGradient, WebImage};
use crate::fonts::build_font_ctx;
use crate::wire::{RectPt, SceneLayer, ScenePathSeg};

/// CSS px → content points (the capture's `PX_TO_PT`, 1px = 1/96in, 1pt = 1/72in).
const PX_TO_PT: f32 = 72.0 / 96.0;

/// The result of threading a flow across frames: one display list per frame
/// (frame-local content points), plus whether content remained after the last
/// frame (`overset`, the CSS-Regions/IDML-story status) and where the flow's
/// painted content ended.
#[derive(Debug, Clone)]
pub struct FlowResult {
    pub frames: Vec<WebDisplayList>,
    pub content_bottom_pt: f32,
    pub overset: bool,
}

// ---------------------------------------------------------------------------
// Rung 1 — equal-width flow via layout-once + display-list slicing
// ---------------------------------------------------------------------------

/// Rung 1: thread `html` through frames of the SAME `width_px` and the given
/// `frame_heights_px`, by laying the whole flow out once at that width and
/// slicing the flat display list into vertical bands.
///
/// Because every frame shares the width, no re-line-breaking is needed — the
/// single layout is valid for all frames, so this is pure display-list
/// surgery (the honest boundary of the "slice a tall layout" approach the spec
/// forbids for the GENERAL/variable-width case, §5.5/§14.4). Frame boundaries
/// SHOULD fall at inter-line gaps; this PoC keeps any command whose vertical
/// band intersects a frame, so a box straddling a boundary appears in both
/// frames — the limit of a slice without a true geometric clip. Gap-snapping /
/// a real clip is the productization step, not the feasibility question.
pub fn render_web_flow_equalwidth(
    html: &str,
    frame_heights_px: &[u32],
    width_px: u32,
) -> FlowResult {
    let total_h: u32 = frame_heights_px.iter().copied().sum::<u32>().max(1);
    // ONE layout+paint+text-recovery pass at the shared width, tall enough to
    // hold the whole flow (so nothing is culled before we slice).
    let full = render_html(html, width_px, total_h);
    let content_bottom_pt = full
        .commands
        .iter()
        .filter_map(cmd_y_band)
        .map(|(_, hi)| hi)
        .fold(0.0f32, f32::max);

    let mut frames = Vec::with_capacity(frame_heights_px.len());
    let mut cum_px = 0u32;
    for &h_px in frame_heights_px {
        let top_pt = cum_px as f32 * PX_TO_PT;
        let bot_pt = (cum_px + h_px) as f32 * PX_TO_PT;
        let mut dl = WebDisplayList::new();
        for cmd in &full.commands {
            if let Some((y0, y1)) = cmd_y_band(cmd) {
                if y1 > top_pt && y0 < bot_pt {
                    // Translate into this frame's local content space.
                    dl.push(shift_cmd_y(cmd, -top_pt));
                }
            }
        }
        frames.push(dl);
        cum_px += h_px;
    }
    let sum_pt = cum_px as f32 * PX_TO_PT;
    FlowResult {
        frames,
        content_bottom_pt,
        overset: content_bottom_pt > sum_pt + 0.5,
    }
}

// ---------------------------------------------------------------------------
// Rung 2 — variable-width flow via re-resolve-the-remainder
// ---------------------------------------------------------------------------

/// Rung 2: thread `html` through frames of DIFFERENT widths, `frames` being
/// `(width_px, height_px)` per frame in chain order.
///
/// The mechanism (the whole point of the spike): lay the flow out at frame A's
/// width, capture frame A's band, then DELETE the fully-consumed block prefix
/// from the DOM via `DocumentMutator` and re-`resolve` at frame B's width — so
/// the remainder RE-LINE-BREAKS at the new width (Blitz re-runs
/// `break_all_lines(Some(widthB))` per inline root for free). This reaches
/// variable-width fragmentation through the pinned `BaseDocument`/mutator API
/// with NO engine fork — at **block granularity**: a block taller than a whole
/// frame is not split (mid-block continuation is the honest follow-on, and
/// halts the loop rather than looping forever).
pub fn render_web_flow_variable(html: &str, frames: &[(u32, u32)]) -> FlowResult {
    render_web_flow_variable_rooted(html, frames, None)
}

/// As [`render_web_flow_variable`], but flowing only the content of the CSS
/// `flow-into` root `flow_root` (a selector) — the rest of `<body>` is not part
/// of the named flow. When `flow_root` is a DIRECT `<body>` child, siblings are
/// pruned so only the flow content renders; otherwise the whole body flows.
pub fn render_web_flow_variable_rooted(
    html: &str,
    frames: &[(u32, u32)],
    flow_root: Option<&str>,
) -> FlowResult {
    // Serialize shaping in test builds (see `capture::SHAPE_LOCK`). This is the
    // variable-flow shaping entry (it resolves + captures directly, not via
    // `render_html`, so there is no nested lock / deadlock).
    #[cfg(test)]
    let _shape_guard = crate::capture::SHAPE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let config = DocumentConfig {
        font_ctx: Some(build_font_ctx()),
        ..Default::default()
    };
    let mut doc = HtmlDocument::from_html(html, config);

    // CSS Regions `flow-into`: keep ONLY the named flow root's subtree so only
    // its content flows. Handles a NESTED root (e.g. body > main > #story), not
    // just a direct body child — everything outside the root's subtree (and its
    // ancestor path) is pruned.
    if let Some(sel) = flow_root {
        if let Some(root_id) = doc.query_selector(sel).ok().flatten() {
            let mut to_remove = Vec::new();
            if let Some(body_id) = doc.query_selector("body").ok().flatten() {
                collect_non_flow(&doc, body_id, root_id, &mut to_remove);
            }
            if !to_remove.is_empty() {
                let mut m = doc.mutate();
                for id in to_remove {
                    m.remove_node(id);
                }
            }
        }
    }

    // A viewport tall enough that no frame's remainder is culled before we
    // slice it to the frame band.
    let tall = frames.iter().map(|&(_, h)| h).max().unwrap_or(1).max(4096);

    let mut out_frames = Vec::with_capacity(frames.len());
    let mut content_bottom_pt = 0.0f32;
    let mut overset = false;

    for (fi, &(w, h)) in frames.iter().enumerate() {
        doc.set_viewport(Viewport::new(w, tall, 1.0, ColorScheme::Light));
        doc.resolve(0.0);

        // Paint the REMAINING document at this width. After each prefix
        // deletion the remainder re-lays out from y=0, so the capture is
        // already frame-local.
        let full = capture_resolved(&mut doc, w, tall);
        let remainder_bottom_pt = full
            .commands
            .iter()
            .filter_map(cmd_y_band)
            .map(|(_, hi)| hi)
            .fold(0.0f32, f32::max);
        let h_pt = h as f32 * PX_TO_PT;
        let is_last = fi + 1 == frames.len();

        // The last frame keeps everything up to its height (content beyond is
        // overset). A non-last frame is cut by `plan_frame_cut`: the full
        // blocks it consumes PLUS a mid-block line split of the straddling
        // plain-text paragraph (rung 3) — the cut aligns to exactly what we
        // then delete/split, so no block or line straddle-duplicates.
        let (cut_pt, cut) = if is_last {
            (h_pt, None)
        } else {
            let c = plan_frame_cut(&doc, h as f32, flow_root);
            (c.cut_px * PX_TO_PT, Some(c))
        };

        let mut dl = WebDisplayList::new();
        for cmd in &full.commands {
            if let Some((y0, y1)) = cmd_y_band(cmd) {
                if y1 > 0.0 && y0 < cut_pt {
                    dl.push(cmd.clone());
                }
            }
        }
        out_frames.push(dl);

        let Some(cut) = cut else {
            // Last frame.
            overset = remainder_bottom_pt > h_pt + 0.5;
            content_bottom_pt = remainder_bottom_pt;
            break;
        };

        // Delete the fully-consumed blocks and apply any mid-block split, so the
        // next resolve re-wraps ONLY what didn't fit. When the cut is empty (a
        // too-tall, unsplittable first block), nothing is deleted and the block
        // flows whole to the next frame.
        let mut m = doc.mutate();
        for id in &cut.delete_full {
            m.remove_node(*id);
        }
        if let Some(edits) = &cut.split {
            for (text_node_id, content) in edits {
                m.set_node_text(*text_node_id, content);
            }
        }
        // `m` flushes on drop → the next iteration's resolve re-lays the remainder.
    }

    FlowResult {
        frames: out_frames,
        content_bottom_pt,
        overset,
    }
}

/// The flow's block units — the direct ELEMENT children of `<body>`, in
/// document order, regardless of tag (`<p>`, `<h1>`..`<h6>`, `<div>`, `<ul>`,
/// …). Each is atomic for block-granular fragmentation (a block taller than a
/// frame is not split — rung 3). This generalises the earlier `<p>`-only
/// shortcut to real content; the fully-general form walks by computed
/// `display`, but for a web frame's content the body's element children ARE
/// the normal-flow blocks.
/// Collect the element descendants of `container` to REMOVE so that only the
/// flow `root`'s subtree renders: an element that is neither the root, an
/// ancestor of it, nor within it. Recurses INTO ancestors of the root (to prune
/// their non-flow siblings) and keeps the root's whole subtree. Text/comment
/// nodes are left alone.
fn collect_non_flow(doc: &BaseDocument, container: usize, root: usize, out: &mut Vec<usize>) {
    let Some(node) = doc.get_node(container) else {
        return;
    };
    for &child in &node.children {
        let Some(cnode) = doc.get_node(child) else {
            continue;
        };
        if cnode.element_data().is_none() {
            continue; // text / comment — leave it
        }
        if child == root {
            continue; // the flow root itself — keep its whole subtree
        }
        if node_contains(doc, child, root) {
            collect_non_flow(doc, child, root, out); // ancestor of root — prune inside
        } else {
            out.push(child); // unrelated content — remove
        }
    }
}

/// Whether `target` is `node` or a descendant of it.
fn node_contains(doc: &BaseDocument, node: usize, target: usize) -> bool {
    if node == target {
        return true;
    }
    doc.get_node(node)
        .map(|n| n.children.iter().any(|&c| node_contains(doc, c, target)))
        .unwrap_or(false)
}

fn flow_blocks(doc: &BaseDocument, flow_root: Option<&str>) -> Vec<usize> {
    // The flow's content root — a CSS `flow-into` selector (Regions syntax) or
    // the whole `<body>` by default.
    let sel = flow_root.unwrap_or("body");
    let Some(root_id) = doc.query_selector(sel).ok().flatten() else {
        return Vec::new();
    };
    let Some(root) = doc.get_node(root_id) else {
        return Vec::new();
    };
    root.children
        .iter()
        .copied()
        .filter(|&cid| {
            doc.get_node(cid)
                .map(|n| n.element_data().is_some())
                .unwrap_or(false)
        })
        .collect()
}

/// How to cut one (non-last) frame: the full blocks it consumes (to delete),
/// an optional MID-BLOCK split of the straddling paragraph, and the content-px
/// bottom to slice the frame at. When nothing is consumed (a too-tall,
/// unsplittable first block) the cut is empty and the block simply flows to the
/// next frame.
struct FrameCut {
    cut_px: f32,
    delete_full: Vec<usize>,
    /// Per-text-node edits (`(text-node id, new content)`) that drop the
    /// consumed prefix and keep the remainder, so the next resolve re-wraps
    /// only what didn't fit (remainder inline formatting preserved).
    split: Option<Vec<(usize, String)>>,
}

/// Plan a frame's cut over the flow's top-level blocks (see
/// [`plan_blocks_cut`] for the recursive algorithm).
fn plan_frame_cut(doc: &BaseDocument, limit_px: f32, flow_root: Option<&str>) -> FrameCut {
    plan_blocks_cut(doc, &flow_blocks(doc, flow_root), limit_px)
}

/// Plan a frame's cut over a list of sibling `blocks` (top-level flow blocks,
/// or — recursively — a container's children): consume the full-fitting
/// prefix, then handle the first block that crosses `limit_px`:
///   1. a splittable plain-text **paragraph** → split it at the last LINE that
///      fits (rung 3, [`try_split`]);
///   2. a fragmentable **container** (`<div>`/`<ul>`/… — element children, no
///      inline text of its own, not a table-family/replaced element) → DESCEND
///      and cut at its children's boundaries (consume the fitting children,
///      recurse into the straddling one). The container element stays put — it
///      holds the remainder; an emptied container self-cleans next frame.
///
/// A straddler that is neither (an image, a single-line block too tall to fit,
/// a table) is left whole and moves to the next frame (halting the flow only if
/// nothing else was consumed). Because [`Node::absolute_position`] is
/// document-absolute at every depth, a child block's top/bottom compares to
/// `limit_px` directly — the recursion needs no coordinate translation.
fn plan_blocks_cut(doc: &BaseDocument, blocks: &[usize], limit_px: f32) -> FrameCut {
    let mut delete_full = Vec::new();
    let mut cut_px = 0.0f32;
    for &id in blocks {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        let top_px = node.absolute_position(0.0, 0.0).y;
        let bottom_px = top_px + node.final_layout.size.height;
        if bottom_px <= limit_px + 0.5 {
            delete_full.push(id);
            cut_px = cut_px.max(bottom_px);
            continue;
        }
        // The first block crossing the limit.
        if top_px >= limit_px {
            break; // it starts below the limit → a whole-block move next frame
        }
        // (1) a plain-text paragraph splits at a line boundary.
        if let Some((consumed_bottom_px, edits)) = try_split(doc, id, limit_px) {
            cut_px = cut_px.max(consumed_bottom_px);
            return FrameCut {
                cut_px,
                delete_full,
                split: Some(edits),
            };
        }
        // (2) a TABLE fragments between its BODY rows, repeating any <thead>.
        // The body rows are atomic (no mid-cell split in v0); a <thead> is
        // never in `rows`, so it survives the delete → re-renders at the top of
        // the next frame = header repeat, for free from the re-resolve model.
        // Taffy 0.11-exp lays out no `<tr>` box (its `final_layout` is 0), so a
        // row's band comes from its CELLS' geometry (`row_band`), not the row.
        if let Some(rows) = table_body_rows(doc, id) {
            let (row_cut, consumed) = plan_table_rows_cut(doc, &rows, limit_px);
            if !consumed.is_empty() {
                cut_px = cut_px.max(row_cut);
                delete_full.extend(consumed);
                return FrameCut {
                    cut_px,
                    delete_full,
                    split: None,
                };
            }
        }
        // (3) a fragmentable container descends. Only commit the recursion when
        // the child pass consumed or split something — otherwise the
        // container's own first child didn't fit either, so move the whole
        // container whole (fall through to the break below).
        if let Some(children) = splittable_container_children(doc, id) {
            let sub = plan_blocks_cut(doc, &children, limit_px);
            if !sub.delete_full.is_empty() || sub.split.is_some() {
                cut_px = cut_px.max(sub.cut_px);
                delete_full.extend(sub.delete_full);
                return FrameCut {
                    cut_px,
                    delete_full,
                    split: sub.split,
                };
            }
        }
        break; // atomic / non-fragmentable straddler → whole-block move
    }
    FrameCut {
        cut_px,
        delete_full,
        split: None,
    }
}

/// A block's element children WHEN it is a fragmentable container — one whose
/// content can be cut BETWEEN children across frames. That means it: has
/// element children; establishes no inline formatting context of its own (an
/// element with `inline_layout_data` is a text paragraph — [`try_split`]
/// handles those); and is not a table-family or replaced/atomic element (those
/// fragment by their own row/column rules, or cannot be cut at all — v0 leaves
/// them whole). `None` → the block is not descended into.
fn splittable_container_children(doc: &BaseDocument, id: usize) -> Option<Vec<usize>> {
    let node = doc.get_node(id)?;
    let ed = node.element_data()?;
    if ed.inline_layout_data.is_some() {
        return None; // a text paragraph — `try_split` owns the split
    }
    let tag: &str = &ed.name.local;
    if matches!(
        tag,
        "table"
            | "caption"
            | "colgroup"
            | "col"
            | "thead"
            | "tbody"
            | "tfoot"
            | "tr"
            | "td"
            | "th"
            | "img"
            | "picture"
            | "svg"
            | "canvas"
            | "video"
            | "audio"
            | "iframe"
            | "object"
            | "embed"
            | "input"
            | "textarea"
            | "select"
            | "button"
            | "hr"
    ) {
        return None;
    }
    let children: Vec<usize> = node
        .children
        .iter()
        .copied()
        .filter(|&c| {
            doc.get_node(c)
                .map(|n| n.element_data().is_some())
                .unwrap_or(false)
        })
        .collect();
    if children.is_empty() {
        return None;
    }
    Some(children)
}

/// The fragmentable BODY rows of a `<table>` — every `<tr>` NOT inside a
/// `<thead>`, in document order. A `<thead>` is EXCLUDED because it repeats: the
/// re-resolve model re-renders the un-deleted header at the top of each
/// continuation frame, so keeping thead rows out of the consumed/deleted set
/// gives header-repeat for free. `None` when `id` is not a `<table>` or has no
/// body rows. Rows are ATOMIC — a row is not split mid-cell in v0 (a too-tall
/// straddling row moves whole). Column widths re-resolve per frame, so a
/// non-`table-layout:fixed` table may shift columns between fragments (content
/// is loss-free) — a documented v0 caveat.
fn table_body_rows(doc: &BaseDocument, id: usize) -> Option<Vec<usize>> {
    let node = doc.get_node(id)?;
    if &*node.element_data()?.name.local != "table" {
        return None;
    }
    let mut rows = Vec::new();
    collect_body_rows(doc, id, false, &mut rows);
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

/// DFS collecting `<tr>` ids under a table, skipping any subtree inside a
/// `<thead>` (the repeating header). A `<tr>` is atomic — not descended into.
fn collect_body_rows(doc: &BaseDocument, id: usize, in_thead: bool, out: &mut Vec<usize>) {
    let Some(node) = doc.get_node(id) else {
        return;
    };
    let Some(ed) = node.element_data() else {
        return;
    };
    let tag: &str = &ed.name.local;
    let in_thead = in_thead || tag == "thead";
    if tag == "tr" {
        if !in_thead {
            out.push(id);
        }
        return; // a row is atomic — its cells are not row-fragment boundaries
    }
    for &child in &node.children {
        collect_body_rows(doc, child, in_thead, out);
    }
}

/// A table row's vertical band `(top, bottom)` in document-absolute px, derived
/// from its CELLS. Taffy 0.11-exp does not lay out the `<tr>` box itself (its
/// `final_layout` is zero), but the `<td>`/`<th>` cells are positioned — so the
/// row spans from its topmost cell's top to its tallest cell's bottom. `None`
/// when the row has no laid-out cell.
fn row_band(doc: &BaseDocument, tr_id: usize) -> Option<(f32, f32)> {
    let node = doc.get_node(tr_id)?;
    let mut top = f32::INFINITY;
    let mut bottom = 0.0f32;
    let mut found = false;
    for &cell in &node.children {
        let Some(cn) = doc.get_node(cell) else {
            continue;
        };
        if cn.element_data().is_none() {
            continue;
        }
        let cy = cn.absolute_position(0.0, 0.0).y;
        let ch = cn.final_layout.size.height;
        top = top.min(cy);
        bottom = bottom.max(cy + ch);
        found = true;
    }
    found.then_some((top, bottom))
}

/// Plan a table's row cut: consume the prefix of body `rows` whose band bottom
/// fits `limit_px` (via [`row_band`], since the `<tr>` box has no geometry), and
/// report `(the consumed content bottom in px, the row ids to delete)`. Rows are
/// atomic — the first row that doesn't fit ends the prefix (it moves whole to
/// the next frame). A row taller than the whole frame stalls only if nothing
/// else was consumed (like any atomic block).
fn plan_table_rows_cut(doc: &BaseDocument, rows: &[usize], limit_px: f32) -> (f32, Vec<usize>) {
    let mut delete_full = Vec::new();
    let mut cut_px = 0.0f32;
    for &r in rows {
        let Some((_top, bottom)) = row_band(doc, r) else {
            continue;
        };
        if bottom <= limit_px + 0.5 {
            delete_full.push(r);
            cut_px = cut_px.max(bottom);
        } else {
            break; // first row past the limit → the rest flow to the next frame
        }
    }
    (cut_px, delete_full)
}

/// Try to split a straddling paragraph at a line boundary: find the last line
/// whose bottom fits `limit_px`, then map that split offset (in the inline
/// text) to per-text-node edits that DROP the consumed prefix and keep the
/// remainder — preserving the remainder's inline formatting (`<b>`/`<span>`).
/// Returns `(the split line's bottom in page px, the text-node edits)`.
///
/// Robust across inline elements via `TextBrush`-free reasoning: it walks the
/// paragraph's descendant text nodes in document order and maps offsets by
/// cumulative raw length. It only proceeds when the concatenation of those
/// text nodes EQUALS the inline text `ild.text` — i.e. `ild.text` is the raw
/// descendant concatenation, so offsets map 1:1 to DOM positions. If blitz
/// normalised the inline text (so the concat differs), the mapping is
/// unreliable and it returns `None` (the caller then moves the block whole).
fn try_split(doc: &BaseDocument, block_id: usize, limit_px: f32) -> Option<(f32, Vec<(usize, String)>)> {
    let node = doc.get_node(block_id)?;
    let ild = node.element_data()?.inline_layout_data.as_ref()?;
    let text: &str = &ild.text;

    let mut split_offset: Option<usize> = None;
    let mut consumed_bottom_px = 0.0f32;
    for line in ild.layout.lines() {
        // The line's bottom in page px (Parley layout coords → page via the
        // block's absolute_position, the same mapping the capture uses).
        let bottom = node.absolute_position(0.0, line.metrics().block_max_coord).y;
        if bottom <= limit_px + 0.5 {
            split_offset = Some(line.text_range().end);
            consumed_bottom_px = bottom;
        } else {
            break; // lines are ordered; the first overflow ends the prefix
        }
    }

    let offset = split_offset?; // no line fits → unsplittable-to-fit
    if offset == 0 || offset >= text.len() || !text.is_char_boundary(offset) {
        return None; // nothing consumed / everything fits / bad boundary
    }

    // Map the split to a DOM position by NON-WHITESPACE character count. blitz
    // collapses whitespace at inline boundaries (so `ild.text` ≠ the raw
    // descendant concatenation), but whitespace collapsing NEVER touches
    // non-whitespace characters — their sequence is identical in both. So the
    // consumed prefix's non-whitespace count is an invariant handle across the
    // collapse, and it maps 1:1 to a position in the raw DOM text (incl. inline
    // elements like <b>/<span>).
    let target_nws = text[..offset].chars().filter(|c| !c.is_whitespace()).count();
    if target_nws == 0 {
        return None;
    }

    // Descendant text nodes in document order.
    let mut nodes: Vec<(usize, String)> = Vec::new();
    collect_text_nodes(doc, block_id, &mut nodes);
    if nodes.is_empty() {
        return None;
    }

    // Find the straddling node + local byte offset just AFTER the
    // `target_nws`-th non-whitespace char (document order).
    let mut running = 0usize;
    let mut split: Option<(usize, usize)> = None; // (node index, local byte)
    'outer: for (ni, (_, content)) in nodes.iter().enumerate() {
        for (bi, ch) in content.char_indices() {
            if !ch.is_whitespace() {
                running += 1;
                if running == target_nws {
                    split = Some((ni, bi + ch.len_utf8()));
                    break 'outer;
                }
            }
        }
    }
    let (straddle_idx, local) = split?; // fewer non-ws chars than expected → bail

    // Build the remainder edits: empty every text node fully consumed, truncate
    // the straddling one; nodes after it (and their inline-element wrappers —
    // bold/span) carry through unchanged so the remainder keeps its formatting.
    let mut edits: Vec<(usize, String)> = Vec::new();
    for (i, (id, content)) in nodes.iter().enumerate() {
        if i < straddle_idx || (i == straddle_idx && local >= content.len()) {
            edits.push((*id, String::new()));
        } else if i == straddle_idx {
            edits.push((*id, content[local..].to_string()));
        }
        // i > straddle_idx: keep as-is.
    }

    // Require the remainder to carry SOME content (else the whole paragraph fit).
    let straddle = &nodes[straddle_idx].1;
    let straddle_remainder = &straddle[local.min(straddle.len())..];
    let remainder_has_text = !straddle_remainder.trim().is_empty()
        || nodes
            .iter()
            .enumerate()
            .any(|(i, (_, c))| i > straddle_idx && !c.trim().is_empty());
    if !remainder_has_text {
        return None;
    }

    Some((consumed_bottom_px, edits))
}

/// DFS a block's subtree in document order, collecting text nodes as
/// `(id, content)`.
fn collect_text_nodes(doc: &BaseDocument, id: usize, out: &mut Vec<(usize, String)>) {
    let Some(node) = doc.get_node(id) else {
        return;
    };
    if node.is_text_node() {
        out.push((id, node.text_content()));
        return;
    }
    for child in &node.children {
        collect_text_nodes(doc, *child, out);
    }
}

// ---------------------------------------------------------------------------
// Product entry — render_web_flow (lowers each frame to a C-1 SceneLayer)
// ---------------------------------------------------------------------------

/// One recipient frame's content-box size, in CSS px — the geometry the host
/// hands per region in the flow chain. `#[serde]` twin of the bundle's
/// `WebFlowFrame` request shape.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSize {
    pub width_px: u32,
    pub height_px: u32,
}

/// One frame's lowered result: the C-1 [`SceneLayer`] the bundle submits for
/// that frame, plus how many scene items it carried (for the honest
/// per-frame diagnostic — never a silent partial render).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowFrameWire {
    pub layer: SceneLayer,
    pub emitted: usize,
}

/// The flow render result the wasm entry returns: one lowered layer per frame
/// in chain order, plus whether content remained past the last frame
/// (`overset` — the CSS-Regions/IDML-story status the host surfaces).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowWire {
    pub frames: Vec<FlowFrameWire>,
    pub overset: bool,
}

/// The product flow entry: thread `html` through `frames` (variable width, in
/// chain order) and LOWER each frame to a C-1 [`SceneLayer`] — the ADR-020
/// scoped extension, `render_web_frame` generalised to a chain. This is the
/// rung-2 (block-granular) implementation; equal-width is the degenerate case.
pub fn render_web_flow(html: &str, frames: &[(u32, u32)]) -> FlowWire {
    flow_result_to_wire(render_web_flow_variable(html, frames))
}

/// As [`render_web_flow`], but flowing only the CSS `flow-into` root
/// `flow_root` (a selector; `None` = the whole `<body>`).
pub fn render_web_flow_rooted(
    html: &str,
    frames: &[(u32, u32)],
    flow_root: Option<&str>,
) -> FlowWire {
    flow_result_to_wire(render_web_flow_variable_rooted(html, frames, flow_root))
}

fn flow_result_to_wire(result: FlowResult) -> FlowWire {
    let frames = result
        .frames
        .iter()
        .map(|dl| {
            let low = crate::lower::lower(dl);
            FlowFrameWire {
                layer: low.layer,
                emitted: low.report.emitted,
            }
        })
        .collect();
    FlowWire {
        frames,
        overset: result.overset,
    }
}

/// JSON-in / JSON-out flow entry — native-testable, and the exact surface the
/// wasm export wraps. `frames_json` is `[{"widthPx":N,"heightPx":M}, …]` in
/// chain order; the return is `FlowWire` as JSON
/// (`{"frames":[{"layer":<SceneLayer>,"emitted":N}, …],"overset":bool}`).
/// Malformed `frames_json` yields an empty, non-overset flow rather than a
/// panic (the host then reports "no frames", never a fake render).
pub fn render_web_flow_json(html: &str, frames_json: &str, flow_root: &str) -> String {
    let frames: Vec<(u32, u32)> = serde_json::from_str::<Vec<FrameSize>>(frames_json)
        .map(|v| v.into_iter().map(|f| (f.width_px, f.height_px)).collect())
        .unwrap_or_default();
    let root = if flow_root.is_empty() {
        None
    } else {
        Some(flow_root)
    };
    let wire = render_web_flow_rooted(html, &frames, root);
    serde_json::to_string(&wire).unwrap_or_else(|_| "{\"frames\":[],\"overset\":false}".to_string())
}

// ---------------------------------------------------------------------------
// Geometry helpers (pure — operate on the captured display list)
// ---------------------------------------------------------------------------

/// The vertical extent `(min_y, max_y)` of a command's geometry in content
/// points, or `None` for a geometry-less diagnostic marker.
fn cmd_y_band(cmd: &WebDrawCmd) -> Option<(f32, f32)> {
    match cmd {
        WebDrawCmd::FillRect { rect, .. } => Some((rect.y, rect.y + rect.h)),
        WebDrawCmd::DrawImage(img) => Some((img.dest.y, img.dest.y + img.dest.h)),
        // A run's ink sits between the baseline and ~one em above it.
        WebDrawCmd::GlyphRun(run) => Some((run.baseline_y - run.size, run.baseline_y)),
        WebDrawCmd::FillPath { path, .. }
        | WebDrawCmd::StrokePath { path, .. }
        | WebDrawCmd::FillGradient { path, .. }
        | WebDrawCmd::FillBlend { path, .. }
        | WebDrawCmd::StrokeGradient { path, .. }
        | WebDrawCmd::FillGradientBlend { path, .. }
        | WebDrawCmd::DrawShadow { path, .. }
        | WebDrawCmd::DrawInsetShadow { path, .. } => path_y_band(path),
        WebDrawCmd::NonSolidPaint { .. } | WebDrawCmd::BoxShadow => None,
    }
}

fn path_y_band(path: &[ScenePathSeg]) -> Option<(f32, f32)> {
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for seg in path {
        match seg {
            ScenePathSeg::MoveTo { y, .. } | ScenePathSeg::LineTo { y, .. } => {
                lo = lo.min(*y);
                hi = hi.max(*y);
            }
            ScenePathSeg::CubicTo { cy1, cy2, y, .. } => {
                for v in [*cy1, *cy2, *y] {
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
            ScenePathSeg::Close => {}
        }
    }
    if lo.is_finite() {
        Some((lo, hi))
    } else {
        None
    }
}

fn shift_path_y(path: &[ScenePathSeg], dy: f32) -> Vec<ScenePathSeg> {
    path.iter()
        .map(|s| match *s {
            ScenePathSeg::MoveTo { x, y } => ScenePathSeg::MoveTo { x, y: y + dy },
            ScenePathSeg::LineTo { x, y } => ScenePathSeg::LineTo { x, y: y + dy },
            ScenePathSeg::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => ScenePathSeg::CubicTo {
                cx1,
                cy1: cy1 + dy,
                cx2,
                cy2: cy2 + dy,
                x,
                y: y + dy,
            },
            ScenePathSeg::Close => ScenePathSeg::Close,
        })
        .collect()
}

fn shift_gradient_y(g: &WebGradient, dy: f32) -> WebGradient {
    match g {
        WebGradient::Linear {
            x0,
            y0,
            x1,
            y1,
            stops,
        } => WebGradient::Linear {
            x0: *x0,
            y0: y0 + dy,
            x1: *x1,
            y1: y1 + dy,
            stops: stops.clone(),
        },
        WebGradient::Radial {
            cx,
            cy,
            radius,
            stops,
        } => WebGradient::Radial {
            cx: *cx,
            cy: cy + dy,
            radius: *radius,
            stops: stops.clone(),
        },
        WebGradient::Sweep {
            cx,
            cy,
            start_angle,
            stops,
        } => WebGradient::Sweep {
            cx: *cx,
            cy: cy + dy,
            start_angle: *start_angle,
            stops: stops.clone(),
        },
    }
}

/// Translate a command vertically by `dy` content points (all y coordinates).
fn shift_cmd_y(cmd: &WebDrawCmd, dy: f32) -> WebDrawCmd {
    match cmd {
        WebDrawCmd::FillRect { rect, paint } => WebDrawCmd::FillRect {
            rect: RectPt::new(rect.x, rect.y + dy, rect.w, rect.h),
            paint: *paint,
        },
        WebDrawCmd::FillPath { path, paint } => WebDrawCmd::FillPath {
            path: shift_path_y(path, dy),
            paint: *paint,
        },
        WebDrawCmd::StrokePath { path, paint, width } => WebDrawCmd::StrokePath {
            path: shift_path_y(path, dy),
            paint: *paint,
            width: *width,
        },
        WebDrawCmd::GlyphRun(r) => WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_y: r.baseline_y + dy,
            ..r.clone()
        }),
        WebDrawCmd::DrawImage(img) => WebDrawCmd::DrawImage(WebImage {
            dest: RectPt::new(img.dest.x, img.dest.y + dy, img.dest.w, img.dest.h),
            ..img.clone()
        }),
        WebDrawCmd::FillGradient { path, gradient } => WebDrawCmd::FillGradient {
            path: shift_path_y(path, dy),
            gradient: shift_gradient_y(gradient, dy),
        },
        WebDrawCmd::FillBlend { path, paint, blend } => WebDrawCmd::FillBlend {
            path: shift_path_y(path, dy),
            paint: *paint,
            blend: *blend,
        },
        WebDrawCmd::StrokeGradient {
            path,
            gradient,
            width,
        } => WebDrawCmd::StrokeGradient {
            path: shift_path_y(path, dy),
            gradient: shift_gradient_y(gradient, dy),
            width: *width,
        },
        WebDrawCmd::FillGradientBlend {
            path,
            gradient,
            blend,
        } => WebDrawCmd::FillGradientBlend {
            path: shift_path_y(path, dy),
            gradient: shift_gradient_y(gradient, dy),
            blend: *blend,
        },
        WebDrawCmd::DrawShadow { path, colour, blur } => WebDrawCmd::DrawShadow {
            path: shift_path_y(path, dy),
            colour: *colour,
            blur: *blur,
        },
        WebDrawCmd::DrawInsetShadow { path, colour, blur } => WebDrawCmd::DrawInsetShadow {
            path: shift_path_y(path, dy),
            colour: *colour,
            blur: *blur,
        },
        WebDrawCmd::NonSolidPaint { what } => WebDrawCmd::NonSolidPaint { what: *what },
        WebDrawCmd::BoxShadow => WebDrawCmd::BoxShadow,
    }
}

/// The recovered plain text of every glyph run in a display list, in paint
/// (top-to-bottom, painter's) order — the spike's semantic-contiguity probe.
#[cfg(test)]
fn frame_text(dl: &WebDisplayList) -> Vec<String> {
    dl.commands
        .iter()
        .filter_map(|c| match c {
            WebDrawCmd::GlyphRun(r) if !r.text.trim().is_empty() => Some(r.text.clone()),
            _ => None,
        })
        .collect()
}

/// Which `MARKnn` markers (0..count) appear in a frame's recovered text.
#[cfg(test)]
fn markers_in(dl: &WebDisplayList, count: usize) -> Vec<usize> {
    let joined = frame_text(dl).join(" ");
    (0..count)
        .filter(|i| joined.contains(&format!("MARK{i:02}")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lower::lower;
    use crate::wire::SceneItem;

    /// Build an article of `n` single-line paragraphs, each carrying a unique
    /// `MARKnn` token so the spike can check document order across frames.
    fn article(n: usize) -> String {
        let mut s = String::from(
            "<!DOCTYPE html><html><head><style>\
             body{margin:0;font-size:16px;line-height:24px}\
             p{margin:0}</style></head><body>",
        );
        for i in 0..n {
            // One short token per paragraph → a single line at any sane width,
            // so blocks don't straddle a frame boundary in the flow tests.
            s.push_str(&format!("<p>MARK{i:02}</p>"));
        }
        s.push_str("</body></html>");
        s
    }

    #[test]
    fn equalwidth_flow_threads_in_document_order_and_reports_overset() {
        // 24 paragraphs at 24px line-height ≈ 576px of content. Three 120px
        // frames (360px) can't hold it → overset, and the visible prefix must
        // appear top-to-bottom, first frame first.
        let html = article(24);
        let out = render_web_flow_equalwidth(&html, &[120, 120, 120], 360);
        assert_eq!(out.frames.len(), 3);
        assert!(
            out.overset,
            "360px of frames over ~576px of content must be overset (content_bottom={})",
            out.content_bottom_pt
        );
        // Frame 0 starts at the top → contains MARK00.
        assert!(
            markers_in(&out.frames[0], 24).contains(&0),
            "frame 0 must contain the first paragraph; got {:?}",
            markers_in(&out.frames[0], 24)
        );
        // Markers are non-decreasing across frames (contiguous forward flow):
        // every marker in frame k+1 is >= the max marker in frame k.
        let mut prev_max: i64 = -1;
        for (k, f) in out.frames.iter().enumerate() {
            let ms = markers_in(f, 24);
            if ms.is_empty() {
                continue;
            }
            let (lo, hi) = (ms[0] as i64, *ms.last().unwrap() as i64);
            assert!(
                lo >= prev_max - 1, // -1 tolerance for a paragraph straddling a boundary
                "frame {k} markers {ms:?} regress below previous max {prev_max}"
            );
            prev_max = hi;
        }
    }

    #[test]
    fn equalwidth_flow_loses_no_content_when_frames_hold_everything() {
        // Frames tall enough (3 × 400 = 1200px) to hold all 24 paragraphs:
        // NOT overset, and every marker MARK00..MARK23 appears across frames.
        let html = article(24);
        let out = render_web_flow_equalwidth(&html, &[400, 400, 400], 360);
        assert!(!out.overset, "1200px of frames over ~576px content is not overset");
        let mut seen = std::collections::BTreeSet::new();
        for f in &out.frames {
            for m in markers_in(f, 24) {
                seen.insert(m);
            }
        }
        let missing: Vec<usize> = (0..24).filter(|i| !seen.contains(i)).collect();
        assert!(missing.is_empty(), "markers dropped by the flow: {missing:?}");
    }

    // --- Rung 2 — variable-width re-resolve-remainder ---

    #[test]
    fn variable_width_flow_threads_all_blocks_without_loss() {
        // Frame A wide (600×120 → 5 single-line blocks), frame B narrow
        // (200×tall → the rest). The mutator deletes the consumed prefix and
        // the remainder re-resolves at 200px. Union of markers = 0..20, in
        // order, no loss/dup.
        let html = article(20);
        let out = render_web_flow_variable(&html, &[(600, 120), (200, 4096)]);
        assert_eq!(out.frames.len(), 2);
        let a = markers_in(&out.frames[0], 20);
        let b = markers_in(&out.frames[1], 20);
        assert!(a.contains(&0), "frame A must hold the top block; got {a:?}");
        assert_eq!(
            *a.last().unwrap() + 1,
            b[0],
            "frame B must continue right after frame A: A={a:?} B={b:?}"
        );
        let mut all: Vec<usize> = a.iter().chain(b.iter()).copied().collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (0..20).collect::<Vec<_>>(),
            "some blocks lost or duplicated across the flow: {all:?}"
        );
    }

    #[test]
    fn variable_flow_splits_a_tall_paragraph_across_frames_mid_block() {
        // Rung 3: ONE paragraph taller than frame A is split at a LINE
        // boundary — the fitting lines stay in A, the rest re-wrap in B. The
        // head is in A and NOT B; the tail is in B and NOT A (a genuine
        // mid-paragraph split, no whole-paragraph duplication).
        let words: String = (0..40).map(|i| format!("w{i} ")).collect();
        let html = format!(
            "<html><head><style>body{{margin:0}}\
             p{{margin:0;font-size:16px;line-height:24px}}</style></head><body>\
             <p>{}</p></body></html>",
            words.trim()
        );
        let out = render_web_flow_variable(&html, &[(200, 60), (200, 4096)]);
        let a_text = frame_text(&out.frames[0]).join(" ");
        let b_text = frame_text(&out.frames[1]).join(" ");
        assert!(a_text.contains("w0"), "frame A must hold the paragraph head: {a_text:?}");
        assert!(b_text.contains("w39"), "frame B must hold the paragraph tail: {b_text:?}");
        assert!(
            !a_text.contains("w39"),
            "frame A must NOT hold the tail — the split is mid-paragraph: {a_text:?}"
        );
        assert!(
            !b_text.contains("w0"),
            "frame B must NOT re-include the head — no whole-para duplication: {b_text:?}"
        );
    }

    #[test]
    fn variable_flow_splits_a_tall_list_between_items() {
        // Phase B: a <ul> taller than frame A is a CONTAINER (no inline text of
        // its own), so it fragments BETWEEN its <li> children — the fitting
        // items stay in A, the rest re-flow in B. Before this, the whole list
        // moved to B (a paragraph-only split couldn't touch it).
        let mut items = String::new();
        for i in 0..10 {
            items.push_str(&format!("<li>MARK{i:02}</li>"));
        }
        let html = format!(
            "<html><head><style>body{{margin:0}}\
             ul{{margin:0;padding:0;list-style:none}}\
             li{{margin:0;font-size:16px;line-height:24px}}</style></head><body>\
             <ul>{items}</ul></body></html>"
        );
        // Frame A ~72px holds ~3 items; frame B (tall) holds the rest.
        let out = render_web_flow_variable(&html, &[(200, 72), (200, 4096)]);
        assert_eq!(out.frames.len(), 2);
        let a = markers_in(&out.frames[0], 10);
        let b = markers_in(&out.frames[1], 10);
        assert!(a.contains(&0), "frame A must hold the first list item; got {a:?}");
        assert!(
            !a.is_empty() && a.len() < 10,
            "the list must be SPLIT across frames, not moved whole; A={a:?}"
        );
        assert!(b.contains(&9), "frame B must hold the last list item; got {b:?}");
        assert_eq!(
            *a.last().unwrap() + 1,
            b[0],
            "frame B continues right after frame A: A={a:?} B={b:?}"
        );
        let mut all: Vec<usize> = a.iter().chain(b.iter()).copied().collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (0..10).collect::<Vec<_>>(),
            "list items lost or duplicated across the flow: {all:?}"
        );
    }

    #[test]
    fn variable_flow_fragments_nested_containers_recursively() {
        // Phase B recursion depth: <section><ul><li…> — the section straddles,
        // its <ul> child straddles, and the cut lands BETWEEN <li>s two levels
        // down. Proves `plan_blocks_cut` descends through nested containers, not
        // just one level.
        let mut items = String::new();
        for i in 0..10 {
            items.push_str(&format!("<li>MARK{i:02}</li>"));
        }
        let html = format!(
            "<html><head><style>body{{margin:0}}\
             section,ul{{margin:0;padding:0}}ul{{list-style:none}}\
             li{{margin:0;font-size:16px;line-height:24px}}</style></head><body>\
             <section><ul>{items}</ul></section></body></html>"
        );
        let out = render_web_flow_variable(&html, &[(200, 72), (200, 4096)]);
        assert_eq!(out.frames.len(), 2);
        let a = markers_in(&out.frames[0], 10);
        let b = markers_in(&out.frames[1], 10);
        assert!(
            !a.is_empty() && a.len() < 10,
            "the nested list must fragment, not move whole; A={a:?}"
        );
        assert!(a.contains(&0) && b.contains(&9), "order preserved: A={a:?} B={b:?}");
        let mut all: Vec<usize> = a.iter().chain(b.iter()).copied().collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (0..10).collect::<Vec<_>>(),
            "items lost or duplicated in the nested flow: {all:?}"
        );
    }

    #[test]
    fn variable_flow_splits_a_tall_table_between_rows_repeating_the_header() {
        // Phase B: a <table> taller than frame A fragments between its <tbody>
        // rows; the <thead> is never consumed, so the re-resolve re-renders it
        // at the top of frame B = HEADER REPEAT. Rows are atomic (no mid-cell
        // split); no row lost or duplicated.
        let mut rows = String::new();
        for i in 0..10 {
            rows.push_str(&format!("<tr><td>MARK{i:02}</td></tr>"));
        }
        let html = format!(
            "<html><head><style>body{{margin:0}}table{{margin:0}}\
             th,td{{padding:0;font-size:16px;line-height:24px}}</style></head><body>\
             <table><thead><tr><th>HEADER</th></tr></thead><tbody>{rows}</tbody></table>\
             </body></html>"
        );
        // Frame A ~96px = the ~24px header + a few body rows; frame B (tall).
        let out = render_web_flow_variable(&html, &[(200, 96), (200, 4096)]);
        assert_eq!(out.frames.len(), 2);
        let a = markers_in(&out.frames[0], 10);
        let b = markers_in(&out.frames[1], 10);
        assert!(
            !a.is_empty() && a.len() < 10,
            "the table must SPLIT between rows, not move whole; A={a:?}"
        );
        assert!(a.contains(&0) && b.contains(&9), "rows stay in order: A={a:?} B={b:?}");
        // The header repeats: HEADER appears in BOTH frames.
        let a_text = frame_text(&out.frames[0]).join(" ");
        let b_text = frame_text(&out.frames[1]).join(" ");
        assert!(a_text.contains("HEADER"), "frame A shows the header: {a_text:?}");
        assert!(
            b_text.contains("HEADER"),
            "frame B REPEATS the header (thead never consumed): {b_text:?}"
        );
        // No body row lost or duplicated across the split.
        let mut all: Vec<usize> = a.iter().chain(b.iter()).copied().collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (0..10).collect::<Vec<_>>(),
            "table rows lost or duplicated across the flow: {all:?}"
        );
    }

    #[test]
    fn flow_into_root_flows_only_the_named_subtree() {
        // CSS Regions `flow-into`: the named flow root (#story) flows across the
        // frames; the sibling <nav> is NOT part of the flow and does not appear.
        let mut html = String::from(
            "<html><head><style>body{margin:0}*{margin:0}\
             p{font-size:16px;line-height:24px}</style></head><body>\
             <nav><p>NAVLINK</p></nav><section id=\"story\">",
        );
        for i in 0..12 {
            html.push_str(&format!("<p>MARK{i:02}</p>"));
        }
        html.push_str("</section></body></html>");

        let out =
            render_web_flow_variable_rooted(&html, &[(400, 120), (400, 4096)], Some("#story"));
        let all: String = out
            .frames
            .iter()
            .flat_map(frame_text)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!all.contains("NAVLINK"), "the <nav> is not in the flow: {all:?}");
        assert!(all.contains("MARK00"), "the story flows: {all:?}");
        assert!(all.contains("MARK11"), "the whole story flows: {all:?}");
        // Contrast: without a flow root, the nav WOULD flow.
        let whole = render_web_flow_variable(&html, &[(400, 120), (400, 4096)]);
        let whole_all: String = whole.frames.iter().flat_map(frame_text).collect::<Vec<_>>().join(" ");
        assert!(whole_all.contains("NAVLINK"), "without flow-into the nav flows too");
    }

    #[test]
    fn flow_into_root_flows_a_nested_subtree() {
        // A NESTED flow root (body > main > #story) with sibling content at TWO
        // levels: a top-level <nav> and an <aside> inside <main>. Only the story
        // flows; both siblings are pruned.
        let mut html = String::from(
            "<html><head><style>body{margin:0}*{margin:0}\
             p{font-size:16px;line-height:24px}</style></head><body>\
             <nav><p>NAVLINK</p></nav>\
             <main><aside><p>SIDEBAR</p></aside><section id=\"story\">",
        );
        for i in 0..10 {
            html.push_str(&format!("<p>MARK{i:02}</p>"));
        }
        html.push_str("</section></main></body></html>");

        let out =
            render_web_flow_variable_rooted(&html, &[(400, 120), (400, 4096)], Some("#story"));
        let all: String = out
            .frames
            .iter()
            .flat_map(frame_text)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(all.contains("MARK00"), "the nested story flows: {all:?}");
        assert!(all.contains("MARK09"), "the whole nested story flows: {all:?}");
        assert!(!all.contains("NAVLINK"), "top-level sibling pruned: {all:?}");
        assert!(!all.contains("SIDEBAR"), "sibling inside <main> pruned: {all:?}");
    }

    #[test]
    fn variable_flow_splits_a_paragraph_with_inline_elements() {
        // A paragraph with a <b> that STRADDLES the frame boundary now splits
        // cleanly (the non-whitespace-count mapping survives blitz's boundary
        // whitespace collapse): head in A, tail re-wrapped in B, no word lost
        // or duplicated.
        let mut html = String::from(
            "<html><head><style>body{margin:0}\
             p{margin:0;font-size:16px;line-height:24px}</style></head><body><p>",
        );
        for i in 0..10 {
            html.push_str(&format!("w{i} "));
        }
        html.push_str("<b>");
        for i in 10..20 {
            html.push_str(&format!("w{i} "));
        }
        html.push_str("</b>");
        for i in 20..40 {
            html.push_str(&format!("w{i} "));
        }
        html.push_str("</p></body></html>");

        let out = render_web_flow_variable(&html, &[(200, 60), (200, 4096)]);
        let a = frame_text(&out.frames[0]).join(" ");
        let b = frame_text(&out.frames[1]).join(" ");
        // A genuine MID-paragraph split across the <b>: head in A, tail in B.
        assert!(a.contains("w0"), "frame A holds the head: {a:?}");
        assert!(b.contains("w39"), "frame B holds the tail: {b:?}");
        assert!(!a.contains("w39"), "frame A must not hold the tail: {a:?}");
        assert!(!b.contains("w0"), "frame B must not re-include the head: {b:?}");
        // And no word is lost or duplicated.
        let mut got: Vec<String> = [&a, &b]
            .iter()
            .flat_map(|s| s.split_whitespace().map(str::to_string).collect::<Vec<_>>())
            .collect();
        got.sort();
        let mut want: Vec<String> = (0..40).map(|i| format!("w{i}")).collect();
        want.sort();
        assert_eq!(got, want, "inline-element split must preserve every word exactly once");
    }

    #[test]
    fn variable_flow_threads_mixed_block_content_not_just_paragraphs() {
        // Real content: an <h1>, <h2>, <div>s and <p>s — ALL are flow blocks
        // now (not just <p>). Uniform 24px line-height (block font-sizes
        // overridden) so 6 blocks = 144px; a 60px frame A holds 2, frame B the
        // rest. They thread across frames in order, no loss/dup, mixed tags.
        let html = "<html><head><style>\
            body{margin:0}h1,h2,p,div{margin:0;font-size:16px;line-height:24px}\
            </style></head><body>\
            <h1>MARK00</h1><p>MARK01</p><div>MARK02</div>\
            <h2>MARK03</h2><p>MARK04</p><div>MARK05</div></body></html>";
        let out = render_web_flow_variable(html, &[(400, 60), (400, 4096)]);
        let a = markers_in(&out.frames[0], 6);
        let b = markers_in(&out.frames[1], 6);
        assert!(a.contains(&0), "frame A must hold the <h1> top: {a:?}");
        assert_eq!(
            *a.last().unwrap() + 1,
            b[0],
            "frame B must continue right after frame A: A={a:?} B={b:?}"
        );
        let mut all: Vec<usize> = a.iter().chain(b.iter()).copied().collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(
            all,
            (0..6).collect::<Vec<_>>(),
            "mixed-tag blocks lost or duplicated across the flow: {all:?}"
        );
    }

    #[test]
    fn re_resolving_at_a_narrower_width_adds_line_breaks() {
        // The mechanism rung 2 relies on: the SAME long paragraph laid out at a
        // narrower width breaks into MORE lines (more glyph runs). This is what
        // makes variable-width threading real rather than clip-slicing.
        let long = "<html><body><p style=\"margin:0\">\
            one two three four five six seven eight nine ten eleven twelve \
            thirteen fourteen fifteen sixteen seventeen eighteen</p></body></html>";
        let runs = |w| {
            render_html(long, w, 2000)
                .commands
                .iter()
                .filter(|c| matches!(c, WebDrawCmd::GlyphRun(_)))
                .count()
        };
        let (wide, narrow) = (runs(600), runs(140));
        assert!(
            narrow > wide,
            "a narrower width must add line/run breaks: wide={wide} narrow={narrow}"
        );
    }

    #[test]
    fn variable_flow_rewraps_the_remainder_at_the_new_width() {
        // End-to-end rung 2: two short paras + one LONG para. Frame A wide
        // (600×64) consumes the two short paras (48px < 64px); the long para
        // flows to frame B narrow (140px) and must wrap to several lines there.
        let html = "<html><head><style>body{margin:0}p{margin:0}\
            body{font-size:16px;line-height:24px}</style></head><body>\
            <p>MARK00</p><p>MARK01</p>\
            <p>MARK02 alpha beta gamma delta epsilon zeta eta theta iota kappa \
            lambda mu nu xi omicron pi rho sigma tau</p></body></html>";
        let out = render_web_flow_variable(html, &[(600, 64), (140, 4096)]);
        assert_eq!(out.frames.len(), 2);
        assert_eq!(
            markers_in(&out.frames[0], 3),
            vec![0, 1],
            "frame A must consume exactly the two short paragraphs"
        );
        assert!(
            markers_in(&out.frames[1], 3).contains(&2),
            "frame B must hold the long remainder paragraph"
        );
        let b_runs = out.frames[1]
            .commands
            .iter()
            .filter(|c| matches!(c, WebDrawCmd::GlyphRun(_)))
            .count();
        assert!(
            b_runs >= 3,
            "the long remainder must wrap to several lines at 140px, got {b_runs} runs"
        );
    }

    // --- Product entry — render_web_flow (lowered per-frame SceneLayers) ---

    #[test]
    fn render_web_flow_lowers_one_scenelayer_per_frame() {
        let html = article(20);
        let wire = render_web_flow(&html, &[(600, 120), (200, 4096)]);
        assert_eq!(wire.frames.len(), 2, "one lowered layer per frame");
        for (i, f) in wire.frames.iter().enumerate() {
            assert!(
                !f.layer.items.is_empty(),
                "frame {i} lowered to an empty SceneLayer"
            );
            assert_eq!(
                f.emitted,
                f.layer.items.len(),
                "emitted count must match the layer's item count"
            );
        }
        assert!(!wire.overset, "200×4096 holds the remainder → not overset");
        // Frame 0 carries the top of the flow.
        let f0_text: String = wire.frames[0]
            .layer
            .items
            .iter()
            .filter_map(|it| match it {
                SceneItem::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        assert!(f0_text.contains("MARK00"), "frame 0 must hold the top: {f0_text:?}");
    }

    #[test]
    fn render_web_flow_json_round_trips_to_the_wire_shape() {
        let html = article(12);
        let json = render_web_flow_json(&html, r#"[{"widthPx":600,"heightPx":120},{"widthPx":200,"heightPx":4096}]"#, "");
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        let frames = v["frames"].as_array().expect("frames array");
        assert_eq!(frames.len(), 2, "two frames in the wire result");
        assert!(v["overset"].is_boolean(), "overset is a bool");
        // Each frame carries a C-1 layer with items; the first holds MARK00.
        assert!(
            frames[0]["layer"]["items"].as_array().map(|a| !a.is_empty()).unwrap_or(false),
            "frame 0 layer has items: {json}"
        );
        assert!(json.contains("MARK00"), "the flow's top text crosses the wire: {json}");
        // Malformed frames JSON → empty, non-overset flow, never a panic.
        let empty = render_web_flow_json(&html, "not json", "");
        assert_eq!(empty, r#"{"frames":[],"overset":false}"#);
    }

    #[test]
    fn each_covered_frame_lowers_to_c1_text_items() {
        // Every frame that holds content lowers to >=1 C-1 `text` item — i.e.
        // the sliced per-frame list is a valid SceneLayer the bundle submits.
        let html = article(12);
        let out = render_web_flow_equalwidth(&html, &[200, 200], 360);
        let mut any_text = false;
        for f in &out.frames {
            let low = lower(f);
            let texts = low
                .layer
                .items
                .iter()
                .filter(|it| matches!(it, SceneItem::Text(_)))
                .count();
            if !f.is_empty() {
                assert!(texts >= 1, "a non-empty frame must lower to >=1 text item");
                any_text = true;
            }
        }
        assert!(any_text, "the flow produced no text at all");
    }
}
