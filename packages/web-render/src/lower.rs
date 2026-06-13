//! The lowering — `WebDisplayList` → C-1 [`SceneLayer`] (ADR-011 Option B).
//!
//! This is the crate's CORE DELIVERABLE: a pure, total function that walks
//! a captured web display list and emits the C-1 wire items core composes
//! inside a frame. It is unit-tested exhaustively on hand-built display
//! lists (no live Blitz), so the mapping is proven independently of the
//! engine that produces the input.
//!
//! Coverage today ("B2 vector + text + raster"):
//!   · `FillRect`   → `SceneItem::FillPath` (closed 4-corner box)
//!   · `FillPath`   → `SceneItem::FillPath` (1:1)
//!   · `StrokePath` → `SceneItem::StrokePath` (1:1)
//!   · `GlyphRun`   → `SceneItem::Text` (one item PER parley run — a
//!     multi-run paragraph emits several text items in painter order)
//!   · `DrawImage`  → `SceneItem::Image` (Stage A; straight RGBA8 +
//!     axis-aligned dest box, the paint transform folded into the dest)
//!   · `FillGradient` → `SceneItem::FillPathGradient` (C-1.3; linear/radial
//!     gradient fills — endpoints in content points, sRGB stops 1:1)
//!
//! Deliberately DROPPED (counted + reported, never faked — the honest
//! ceiling of C-1's current stages / Tier-B):
//!   · sweep/conic gradients — no C-1 gradient equivalent (only linear +
//!     radial cross the wire); counted, never approximated as linear.
//!   · gradient STROKES — C-1.3 carries a gradient FILL only (no gradient
//!     stroke), so a gradient-stroked path stays an unsupported drop.
//!   · image/pattern brushes + rotated/sheared image dests — the Stage-A
//!     image item carries an axis-aligned box only (no per-image transform
//!     yet), so a transformed image dest is counted unsupported, not faked.
//!   · box shadows / blur — no C-1 representation.
//! Blend modes and CSS fragmentation across linked frames are out of this
//! slice (Tier-B); see the base-idea lowering-lane status.

use crate::display_list::{WebDisplayList, WebDrawCmd, WebGlyphRun, WebGradient, WebImage};
use crate::wire::{SceneGradient, SceneGradientStop, SceneItem, SceneLayer, SceneTextItem};

/// What the lowering covered vs. dropped — surfaced to the bundle so the
/// "Render to frame" affordance reports HONESTLY (a count of what didn't
/// make it onto the page, by kind), never a silent partial render.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LowerReport {
    /// Scene items emitted (fills + strokes + text).
    pub emitted: usize,
    /// Fills emitted (rect + path).
    pub fills: usize,
    /// Strokes emitted.
    pub strokes: usize,
    /// Text runs emitted (one per parley run — multi-run paragraphs emit
    /// one `text` item per run, preserving painter order).
    pub text_runs: usize,
    /// Raster images emitted as C-1 `image` items (Stage A).
    pub images: usize,
    /// Linear/radial gradient fills emitted as C-1 `fillPathGradient` items
    /// (C-1.3). Sweep/conic gradients are NOT here — they have no C-1
    /// equivalent and stay counted as `dropped_non_solid`.
    pub gradients: usize,
    /// Primitives dropped because their paint is a non-solid the C-1 wire
    /// can't carry today — sweep/conic gradients, image/pattern brushes, and
    /// rotated/sheared image dests (no image transform on the wire yet).
    /// Axis-aligned raster images are NOT dropped (→ `image` items), and
    /// linear/radial gradients are NOT dropped (→ `fillPathGradient` items).
    pub dropped_non_solid: usize,
    /// Box shadows / blurs dropped (no C-1 representation).
    pub dropped_shadows: usize,
    /// Empty/degenerate primitives skipped (zero-area rect, empty path,
    /// empty text) — not a fidelity loss, just nothing to draw.
    pub skipped_empty: usize,
}

impl LowerReport {
    /// Total primitives that COULD NOT be expressed on the C-1 wire (the
    /// honest "not everything rendered" signal). Excludes empty skips.
    pub fn dropped(&self) -> usize {
        self.dropped_non_solid + self.dropped_shadows
    }

    /// A short human note for the bundle's render diagnostic, or `None`
    /// when everything expressible was expressed.
    pub fn unsupported_note(&self) -> Option<String> {
        if self.dropped() == 0 {
            return None;
        }
        let mut parts = Vec::new();
        if self.dropped_non_solid > 0 {
            parts.push(format!(
                "{} sweep-gradient/image-pattern/transformed-image paint(s)",
                self.dropped_non_solid
            ));
        }
        if self.dropped_shadows > 0 {
            parts.push(format!("{} shadow(s)/blur(s)", self.dropped_shadows));
        }
        Some(format!(
            "{} primitive(s) not yet renderable on the scene-layer wire: {} (vector + solid fill + multi-run text + axis-aligned raster images + linear/radial gradient fills are supported today)",
            self.dropped(),
            parts.join(", "),
        ))
    }
}

/// The lowering result: the C-1 layer to submit + the coverage report.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lowered {
    pub layer: SceneLayer,
    pub report: LowerReport,
}

/// Lower a captured web display list to a C-1 [`SceneLayer`] + report.
/// Pure + total: same input → same output, never panics. Items are emitted
/// in painter's order (the order Blitz painted = the order core composes),
/// so z-order is preserved by construction.
pub fn lower(dl: &WebDisplayList) -> Lowered {
    let mut layer = SceneLayer::default();
    let mut report = LowerReport::default();

    for cmd in &dl.commands {
        match cmd {
            WebDrawCmd::FillRect { rect, paint } => {
                if !rect.is_positive() {
                    report.skipped_empty += 1;
                    continue;
                }
                layer.items.push(SceneItem::FillPath {
                    path: rect.to_closed_path(),
                    paint: *paint,
                });
                report.fills += 1;
            }
            WebDrawCmd::FillPath { path, paint } => {
                if path.is_empty() {
                    report.skipped_empty += 1;
                    continue;
                }
                layer.items.push(SceneItem::FillPath {
                    path: path.clone(),
                    paint: *paint,
                });
                report.fills += 1;
            }
            WebDrawCmd::StrokePath { path, paint, width } => {
                if path.is_empty() || *width <= 0.0 {
                    report.skipped_empty += 1;
                    continue;
                }
                layer.items.push(SceneItem::StrokePath {
                    path: path.clone(),
                    paint: *paint,
                    width: *width,
                });
                report.strokes += 1;
            }
            WebDrawCmd::GlyphRun(run) => match lower_text(run) {
                Some(item) => {
                    layer.items.push(item);
                    report.text_runs += 1;
                }
                None => report.skipped_empty += 1,
            },
            WebDrawCmd::DrawImage(img) => match lower_image(img) {
                Some(item) => {
                    layer.items.push(item);
                    report.images += 1;
                }
                None => report.skipped_empty += 1,
            },
            WebDrawCmd::FillGradient { path, gradient } => match lower_gradient(path, gradient) {
                Some(item) => {
                    layer.items.push(item);
                    report.gradients += 1;
                }
                None => report.skipped_empty += 1,
            },
            WebDrawCmd::NonSolidPaint { what } => {
                // Counted, never faked — the C-1 wire has no gradient/image
                // brush. The label is carried for the diagnostic.
                let _ = what.label();
                report.dropped_non_solid += 1;
            }
            WebDrawCmd::BoxShadow => {
                report.dropped_shadows += 1;
            }
        }
    }

    report.emitted = layer.items.len();
    Lowered { layer, report }
}

/// Lower a captured text run to a C-1 `text` item, or `None` for an empty
/// run (whitespace-only collapses to nothing — the honest skip; core also
/// skips an empty `text`).
fn lower_text(run: &WebGlyphRun) -> Option<SceneItem> {
    if run.text.trim().is_empty() {
        return None;
    }
    Some(SceneItem::Text(SceneTextItem {
        x: run.baseline_x,
        y: run.baseline_y,
        text: run.text.clone(),
        size: run.size,
        paint: run.paint,
        family: run.family.clone(),
        style: None,
    }))
}

/// Lower a captured raster image to the EXISTING C-1 `SceneItem::Image`
/// (Stage A, canvas-wasm v0.41+) — no core change. Returns `None` for a
/// degenerate image (zero pixels, zero-area dest, or a byte buffer whose
/// length doesn't match `width*height*4` — the honest skip, never a faked
/// or truncated upload). The `rgba` bytes pass through 1:1 (straight RGBA8,
/// the wire contract).
fn lower_image(img: &WebImage) -> Option<SceneItem> {
    if img.width == 0 || img.height == 0 || !img.dest.is_positive() {
        return None;
    }
    let expected = (img.width as usize)
        .checked_mul(img.height as usize)
        .and_then(|px| px.checked_mul(4))?;
    if img.rgba.len() != expected {
        // A buffer that doesn't describe `w*h` RGBA8 pixels is not a fidelity
        // loss we hide — skip it (counted as an empty/degenerate skip by the
        // caller) rather than ship a malformed image upload.
        return None;
    }
    Some(SceneItem::Image {
        rgba: img.rgba.clone(),
        width: img.width,
        height: img.height,
        x: img.dest.x,
        y: img.dest.y,
        w: img.dest.w,
        h: img.dest.h,
    })
}

/// Lower a captured linear/radial gradient fill to the C-1.3
/// [`SceneItem::FillPathGradient`]. Returns `None` (the honest skip, counted
/// by the caller as empty) for a degenerate gradient — an empty path, fewer
/// than 2 stops, or a non-positive radial radius — matching core's own skips
/// (`scene_layer.rs`: empty path / `<2` stops / `radius <= 0.0`), so the
/// lowering never emits an item core would silently drop. Stops pass through
/// 1:1 as sRGB; the endpoints are already in content points (the capture
/// folded the paint transform in).
fn lower_gradient(path: &[crate::wire::ScenePathSeg], gradient: &WebGradient) -> Option<SceneItem> {
    if path.is_empty() {
        return None;
    }
    let scene = match gradient {
        WebGradient::Linear {
            x0,
            y0,
            x1,
            y1,
            stops,
        } => {
            if stops.len() < 2 {
                return None;
            }
            SceneGradient::Linear {
                x0: *x0,
                y0: *y0,
                x1: *x1,
                y1: *y1,
                stops: stops.iter().map(map_stop).collect(),
            }
        }
        WebGradient::Radial {
            cx,
            cy,
            radius,
            stops,
        } => {
            if stops.len() < 2 || *radius <= 0.0 {
                return None;
            }
            SceneGradient::Radial {
                cx: *cx,
                cy: *cy,
                radius: *radius,
                stops: stops.iter().map(map_stop).collect(),
            }
        }
    };
    Some(SceneItem::FillPathGradient {
        path: path.to_vec(),
        gradient: scene,
    })
}

/// Map a captured gradient stop to the C-1 wire stop (1:1 — both carry a
/// normalized offset + sRGB RGBA; core offset-sorts + linearises).
fn map_stop(s: &crate::display_list::WebGradientStop) -> SceneGradientStop {
    SceneGradientStop {
        offset: s.offset,
        r: s.r,
        g: s.g,
        b: s.b,
        a: s.a,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display_list::{LocalKey, UnsupportedKind};
    use crate::wire::{RectPt, ScenePaint, ScenePathSeg};

    fn blue() -> ScenePaint {
        ScenePaint::rgba(0.0, 0.3, 0.8, 1.0)
    }

    #[test]
    fn empty_display_list_lowers_to_an_empty_layer() {
        let out = lower(&WebDisplayList::new());
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report, LowerReport::default());
        assert!(out.report.unsupported_note().is_none());
    }

    #[test]
    fn fill_rect_lowers_to_a_closed_fill_path_box() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(10.0, 20.0, 64.0, 48.0),
            paint: blue(),
        });
        let out = lower(&dl);
        assert_eq!(out.report.fills, 1);
        assert_eq!(out.report.emitted, 1);
        let SceneItem::FillPath { path, paint } = &out.layer.items[0] else {
            panic!("expected a fillPath, got {:?}", out.layer.items[0]);
        };
        assert_eq!(*paint, blue());
        // Box corners, CW from top-left, closed: (10,20)(74,20)(74,68)(10,68).
        assert_eq!(
            path,
            &vec![
                ScenePathSeg::MoveTo { x: 10.0, y: 20.0 },
                ScenePathSeg::LineTo { x: 74.0, y: 20.0 },
                ScenePathSeg::LineTo { x: 74.0, y: 68.0 },
                ScenePathSeg::LineTo { x: 10.0, y: 68.0 },
                ScenePathSeg::Close,
            ]
        );
    }

    #[test]
    fn zero_area_rect_is_skipped_not_emitted() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(0.0, 0.0, 0.0, 10.0),
            paint: blue(),
        });
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.skipped_empty, 1);
        assert_eq!(out.report.fills, 0);
    }

    #[test]
    fn arbitrary_fill_path_lowers_one_to_one() {
        let path = vec![
            ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
            ScenePathSeg::CubicTo {
                cx1: 1.0,
                cy1: 2.0,
                cx2: 3.0,
                cy2: 4.0,
                x: 5.0,
                y: 6.0,
            },
            ScenePathSeg::Close,
        ];
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillPath {
            path: path.clone(),
            paint: ScenePaint::BLACK,
        });
        let out = lower(&dl);
        assert_eq!(out.report.fills, 1);
        let SceneItem::FillPath { path: got, .. } = &out.layer.items[0] else {
            panic!("expected fillPath");
        };
        assert_eq!(got, &path);
    }

    #[test]
    fn empty_fill_path_is_skipped() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillPath {
            path: vec![],
            paint: ScenePaint::BLACK,
        });
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.skipped_empty, 1);
    }

    #[test]
    fn stroke_path_lowers_with_width() {
        let path = vec![
            ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
            ScenePathSeg::LineTo { x: 100.0, y: 0.0 },
        ];
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::StrokePath {
            path: path.clone(),
            paint: ScenePaint::BLACK,
            width: 2.0,
        });
        let out = lower(&dl);
        assert_eq!(out.report.strokes, 1);
        let SceneItem::StrokePath { width, .. } = &out.layer.items[0] else {
            panic!("expected strokePath");
        };
        assert_eq!(*width, 2.0);
    }

    #[test]
    fn zero_width_stroke_is_skipped() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::StrokePath {
            path: vec![ScenePathSeg::MoveTo { x: 0.0, y: 0.0 }],
            paint: ScenePaint::BLACK,
            width: 0.0,
        });
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.skipped_empty, 1);
    }

    #[test]
    fn glyph_run_lowers_to_a_single_line_text_item() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 12.0,
            baseline_y: 34.0,
            size: 13.0,
            text: "paged.web".to_string(),
            paint: ScenePaint::BLACK,
            family: Some("Inter".to_string()),
            local_key: LocalKey::default(),
        }));
        let out = lower(&dl);
        assert_eq!(out.report.text_runs, 1);
        let SceneItem::Text(t) = &out.layer.items[0] else {
            panic!("expected text item");
        };
        assert_eq!(t.x, 12.0);
        assert_eq!(t.y, 34.0);
        assert_eq!(t.size, 13.0);
        assert_eq!(t.text, "paged.web");
        assert_eq!(t.family.as_deref(), Some("Inter"));
        assert_eq!(t.style, None);
    }

    #[test]
    fn multi_run_paragraph_lowers_to_one_text_item_per_run() {
        // A paragraph that parley splits into several runs (font/style/bidi
        // boundaries) is captured as one `GlyphRun` per run; each lowers to
        // its OWN C-1 `text` item — distinct string + baseline — in painter
        // order. Here a 2-run fragment (a regular word then a styled word on
        // the same line, each its own run).
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 10.0,
            baseline_y: 20.0,
            size: 12.0,
            text: "alpha ".to_string(),
            paint: ScenePaint::BLACK,
            family: Some("Inter".to_string()),
            local_key: LocalKey::new(10.0, 20.0),
        }));
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 48.0,
            baseline_y: 20.0,
            size: 12.0,
            text: "BETA".to_string(),
            paint: ScenePaint::rgba(0.8, 0.0, 0.0, 1.0),
            family: Some("Inter".to_string()),
            local_key: LocalKey::new(48.0, 20.0),
        }));
        let out = lower(&dl);
        assert_eq!(out.report.text_runs, 2);
        assert_eq!(out.report.emitted, 2);
        let texts: Vec<(&str, f32)> = out
            .layer
            .items
            .iter()
            .filter_map(|it| match it {
                SceneItem::Text(t) => Some((t.text.as_str(), t.x)),
                _ => None,
            })
            .collect();
        // Two items, distinct strings, distinct baselines, in painter order.
        assert_eq!(texts, vec![("alpha ", 10.0), ("BETA", 48.0)]);
        assert!(out.report.unsupported_note().is_none());
    }

    #[test]
    fn whitespace_only_text_run_is_skipped() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 0.0,
            baseline_y: 0.0,
            size: 12.0,
            text: "   \n\t ".to_string(),
            paint: ScenePaint::BLACK,
            family: None,
            local_key: LocalKey::default(),
        }));
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.skipped_empty, 1);
        assert_eq!(out.report.text_runs, 0);
    }

    #[test]
    fn raster_image_lowers_to_a_c1_image_item_with_the_right_dest() {
        use crate::display_list::WebImage;
        // A 2×2 RGBA8 image (16 bytes) painted into a 50×30 pt box at (10,20).
        let rgba: Vec<u8> = (0..16).collect();
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::DrawImage(WebImage {
            rgba: rgba.clone(),
            width: 2,
            height: 2,
            dest: RectPt::new(10.0, 20.0, 50.0, 30.0),
        }));
        let out = lower(&dl);
        assert_eq!(out.report.images, 1);
        assert_eq!(out.report.emitted, 1);
        // Images are NOT counted as unsupported anymore.
        assert_eq!(out.report.dropped_non_solid, 0);
        assert!(out.report.unsupported_note().is_none());
        let SceneItem::Image {
            rgba: got,
            width,
            height,
            x,
            y,
            w,
            h,
        } = &out.layer.items[0]
        else {
            panic!("expected an image item, got {:?}", out.layer.items[0]);
        };
        assert_eq!(got, &rgba);
        assert_eq!(*width, 2);
        assert_eq!(*height, 2);
        assert_eq!((*x, *y, *w, *h), (10.0, 20.0, 50.0, 30.0));
    }

    #[test]
    fn image_with_mismatched_byte_length_is_skipped_not_shipped() {
        use crate::display_list::WebImage;
        // 2×2 claims 16 bytes but carries 4 — a malformed buffer is skipped,
        // never uploaded truncated.
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::DrawImage(WebImage {
            rgba: vec![1, 2, 3, 4],
            width: 2,
            height: 2,
            dest: RectPt::new(0.0, 0.0, 10.0, 10.0),
        }));
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.images, 0);
        assert_eq!(out.report.skipped_empty, 1);
    }

    #[test]
    fn zero_area_image_dest_is_skipped() {
        use crate::display_list::WebImage;
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::DrawImage(WebImage {
            rgba: vec![0; 4],
            width: 1,
            height: 1,
            dest: RectPt::new(0.0, 0.0, 0.0, 20.0),
        }));
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.skipped_empty, 1);
        assert_eq!(out.report.images, 0);
    }

    #[test]
    fn image_preserves_painters_order_among_fills_and_text() {
        use crate::display_list::WebImage;
        // background fill, then an image, then a caption text run.
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(0.0, 0.0, 100.0, 100.0),
            paint: ScenePaint::rgba(1.0, 1.0, 1.0, 1.0),
        });
        dl.push(WebDrawCmd::DrawImage(WebImage {
            rgba: vec![0; 4],
            width: 1,
            height: 1,
            dest: RectPt::new(8.0, 8.0, 40.0, 40.0),
        }));
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 8.0,
            baseline_y: 60.0,
            size: 11.0,
            text: "caption".to_string(),
            paint: ScenePaint::BLACK,
            family: None,
            local_key: LocalKey::default(),
        }));
        let out = lower(&dl);
        assert_eq!(out.report.emitted, 3);
        assert_eq!(out.report.fills, 1);
        assert_eq!(out.report.images, 1);
        assert_eq!(out.report.text_runs, 1);
        assert!(matches!(out.layer.items[0], SceneItem::FillPath { .. }));
        assert!(matches!(out.layer.items[1], SceneItem::Image { .. }));
        assert!(matches!(out.layer.items[2], SceneItem::Text(_)));
        assert!(out.report.unsupported_note().is_none());
    }

    #[test]
    fn non_solid_paint_is_dropped_and_reported_not_faked() {
        let mut dl = WebDisplayList::new();
        // A sweep/conic gradient (no C-1 equivalent — captured as a
        // `GradientFill` drop) and a transformed/sheared image dest (recorded
        // as an `ImageFill` drop by the capture) — both stay counted, never
        // faked. Linear/radial gradients do NOT come through this path; they
        // lower to `fillPathGradient` (see the gradient tests below).
        dl.push(WebDrawCmd::NonSolidPaint {
            what: UnsupportedKind::GradientFill,
        });
        dl.push(WebDrawCmd::NonSolidPaint {
            what: UnsupportedKind::ImageFill,
        });
        let out = lower(&dl);
        assert!(
            out.layer.items.is_empty(),
            "a non-solid paint is NEVER faked into a solid"
        );
        assert_eq!(out.report.dropped_non_solid, 2);
        assert_eq!(out.report.dropped(), 2);
        let note = out
            .report
            .unsupported_note()
            .expect("a note for dropped paint");
        assert!(note.contains("sweep-gradient"), "note: {note}");
    }

    #[test]
    fn box_shadow_is_dropped_and_reported() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::BoxShadow);
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.dropped_shadows, 1);
        let note = out.report.unsupported_note().expect("a note");
        assert!(note.contains("shadow"), "note: {note}");
    }

    #[test]
    fn painters_order_is_preserved() {
        // A card: background rect, then a badge rect, then the heading text
        // — must lower in exactly that z-order (core composes in order).
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(0.0, 0.0, 200.0, 100.0),
            paint: ScenePaint::rgba(1.0, 1.0, 1.0, 1.0),
        });
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(8.0, 8.0, 64.0, 64.0),
            paint: blue(),
        });
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 84.0,
            baseline_y: 28.0,
            size: 20.0,
            text: "Heading".to_string(),
            paint: ScenePaint::BLACK,
            family: None,
            local_key: LocalKey::default(),
        }));
        let out = lower(&dl);
        assert_eq!(out.report.emitted, 3);
        assert_eq!(out.report.fills, 2);
        assert_eq!(out.report.text_runs, 1);
        assert!(matches!(out.layer.items[0], SceneItem::FillPath { .. }));
        assert!(matches!(out.layer.items[1], SceneItem::FillPath { .. }));
        assert!(matches!(out.layer.items[2], SceneItem::Text(_)));
        // Everything expressible was expressed → no unsupported note.
        assert!(out.report.unsupported_note().is_none());
    }

    #[test]
    fn mixed_supported_and_dropped_reports_both() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(0.0, 0.0, 10.0, 10.0),
            paint: blue(),
        });
        dl.push(WebDrawCmd::NonSolidPaint {
            what: UnsupportedKind::GradientFill,
        });
        dl.push(WebDrawCmd::BoxShadow);
        let out = lower(&dl);
        assert_eq!(out.report.emitted, 1);
        assert_eq!(out.report.fills, 1);
        assert_eq!(out.report.dropped_non_solid, 1);
        assert_eq!(out.report.dropped_shadows, 1);
        assert_eq!(out.report.dropped(), 2);
    }

    use crate::display_list::{WebGradient, WebGradientStop};
    use crate::wire::SceneGradient;

    fn two_stops() -> Vec<WebGradientStop> {
        vec![
            WebGradientStop {
                offset: 0.0,
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
            WebGradientStop {
                offset: 1.0,
                r: 0.0,
                g: 0.0,
                b: 1.0,
                a: 1.0,
            },
        ]
    }

    fn diag_path() -> Vec<ScenePathSeg> {
        RectPt::new(0.0, 0.0, 100.0, 50.0).to_closed_path()
    }

    #[test]
    fn linear_gradient_fill_lowers_to_a_fill_path_gradient() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: diag_path(),
            gradient: WebGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 100.0,
                y1: 0.0,
                stops: two_stops(),
            },
        });
        let out = lower(&dl);
        assert_eq!(out.report.gradients, 1);
        assert_eq!(out.report.emitted, 1);
        // A real gradient is NOT counted as an unsupported drop anymore.
        assert_eq!(out.report.dropped_non_solid, 0);
        assert!(out.report.unsupported_note().is_none());
        let SceneItem::FillPathGradient { path, gradient } = &out.layer.items[0] else {
            panic!("expected a fillPathGradient, got {:?}", out.layer.items[0]);
        };
        assert_eq!(path, &diag_path());
        let SceneGradient::Linear {
            x0,
            y0,
            x1,
            y1,
            stops,
        } = gradient
        else {
            panic!("expected a linear gradient, got {gradient:?}");
        };
        assert_eq!((*x0, *y0, *x1, *y1), (0.0, 0.0, 100.0, 0.0));
        assert_eq!(stops.len(), 2);
        assert_eq!(stops[0].offset, 0.0);
        assert_eq!(
            (stops[0].r, stops[0].g, stops[0].b, stops[0].a),
            (1.0, 0.0, 0.0, 1.0)
        );
        assert_eq!(stops[1].offset, 1.0);
        assert_eq!(
            (stops[1].r, stops[1].g, stops[1].b, stops[1].a),
            (0.0, 0.0, 1.0, 1.0)
        );
    }

    #[test]
    fn radial_gradient_fill_lowers_to_a_fill_path_gradient() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: diag_path(),
            gradient: WebGradient::Radial {
                cx: 50.0,
                cy: 25.0,
                radius: 40.0,
                stops: two_stops(),
            },
        });
        let out = lower(&dl);
        assert_eq!(out.report.gradients, 1);
        assert!(out.report.unsupported_note().is_none());
        let SceneItem::FillPathGradient { gradient, .. } = &out.layer.items[0] else {
            panic!("expected a fillPathGradient");
        };
        let SceneGradient::Radial {
            cx,
            cy,
            radius,
            stops,
        } = gradient
        else {
            panic!("expected a radial gradient, got {gradient:?}");
        };
        assert_eq!((*cx, *cy, *radius), (50.0, 25.0, 40.0));
        assert_eq!(stops.len(), 2);
    }

    #[test]
    fn single_stop_gradient_is_skipped_not_emitted() {
        // <2 stops can't ramp — core skips it, so the lowering skips it too
        // (counted as an empty skip, never an item core would silently drop).
        let one = vec![WebGradientStop {
            offset: 0.0,
            r: 0.5,
            g: 0.5,
            b: 0.5,
            a: 1.0,
        }];
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: diag_path(),
            gradient: WebGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 10.0,
                y1: 0.0,
                stops: one,
            },
        });
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.gradients, 0);
        assert_eq!(out.report.skipped_empty, 1);
    }

    #[test]
    fn empty_path_gradient_is_skipped() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: vec![],
            gradient: WebGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 10.0,
                y1: 0.0,
                stops: two_stops(),
            },
        });
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.skipped_empty, 1);
        assert_eq!(out.report.gradients, 0);
    }

    #[test]
    fn zero_radius_radial_gradient_is_skipped() {
        // A non-positive radius can't ramp — core skips it (`radius <= 0.0`).
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: diag_path(),
            gradient: WebGradient::Radial {
                cx: 0.0,
                cy: 0.0,
                radius: 0.0,
                stops: two_stops(),
            },
        });
        let out = lower(&dl);
        assert!(out.layer.items.is_empty());
        assert_eq!(out.report.gradients, 0);
        assert_eq!(out.report.skipped_empty, 1);
    }

    #[test]
    fn sweep_gradient_stays_unsupported_while_linear_radial_are_covered() {
        // A sweep/conic gradient has no C-1 equivalent → it remains a
        // `NonSolidPaint` drop (the capture records it as `GradientFill`),
        // while a linear gradient on the SAME list lowers. Honest mix.
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: diag_path(),
            gradient: WebGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 100.0,
                y1: 0.0,
                stops: two_stops(),
            },
        });
        dl.push(WebDrawCmd::NonSolidPaint {
            what: UnsupportedKind::GradientFill,
        });
        let out = lower(&dl);
        assert_eq!(out.report.gradients, 1);
        assert_eq!(out.report.dropped_non_solid, 1);
        assert_eq!(out.report.emitted, 1);
        let note = out.report.unsupported_note().expect("a note for the sweep");
        assert!(note.contains("sweep-gradient"), "note: {note}");
    }

    #[test]
    fn gradient_preserves_painters_order_among_fills_and_text() {
        // background gradient, then a solid badge, then a caption.
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: RectPt::new(0.0, 0.0, 200.0, 100.0).to_closed_path(),
            gradient: WebGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 200.0,
                y1: 0.0,
                stops: two_stops(),
            },
        });
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(8.0, 8.0, 40.0, 40.0),
            paint: blue(),
        });
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 8.0,
            baseline_y: 60.0,
            size: 11.0,
            text: "caption".to_string(),
            paint: ScenePaint::BLACK,
            family: None,
            local_key: LocalKey::default(),
        }));
        let out = lower(&dl);
        assert_eq!(out.report.emitted, 3);
        assert_eq!(out.report.gradients, 1);
        assert_eq!(out.report.fills, 1);
        assert_eq!(out.report.text_runs, 1);
        assert!(matches!(
            out.layer.items[0],
            SceneItem::FillPathGradient { .. }
        ));
        assert!(matches!(out.layer.items[1], SceneItem::FillPath { .. }));
        assert!(matches!(out.layer.items[2], SceneItem::Text(_)));
        assert!(out.report.unsupported_note().is_none());
    }
}

#[cfg(test)]
mod wire_json_tests {
    //! The lowered layer must serialize to the EXACT JSON core's
    //! `paged_compose::SceneLayer` deserializes (the C-1 wire). These tests
    //! pin the tag/field names so a drift from the contract fails here, not
    //! silently at submit time.
    use super::*;
    use crate::display_list::LocalKey;
    use crate::wire::{RectPt, ScenePaint};

    #[test]
    fn fill_path_serializes_to_the_c1_wire_shape() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillRect {
            rect: RectPt::new(0.0, 0.0, 2.0, 2.0),
            paint: ScenePaint::rgba(1.0, 0.0, 0.0, 1.0),
        });
        let out = lower(&dl);
        let json = serde_json::to_value(&out.layer).unwrap();
        let item = &json["items"][0];
        assert_eq!(item["kind"], "fillPath");
        assert_eq!(item["path"][0]["op"], "moveTo");
        assert_eq!(item["path"][1]["op"], "lineTo");
        assert_eq!(item["path"][4]["op"], "close");
        assert_eq!(item["paint"]["r"], 1.0);
        assert_eq!(item["paint"]["a"], 1.0);
    }

    #[test]
    fn text_serializes_to_the_c1_wire_shape() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: 1.0,
            baseline_y: 2.0,
            size: 12.0,
            text: "hi".to_string(),
            paint: ScenePaint::BLACK,
            family: None,
            local_key: LocalKey::default(),
        }));
        let out = lower(&dl);
        let json = serde_json::to_value(&out.layer).unwrap();
        let item = &json["items"][0];
        assert_eq!(item["kind"], "text");
        assert_eq!(item["text"], "hi");
        assert_eq!(item["size"], 12.0);
        // `family: None` is skipped (skip_serializing_if), matching core.
        assert!(item.get("family").is_none());
    }

    #[test]
    fn image_serializes_to_the_c1_image_wire_shape() {
        use crate::display_list::WebImage;
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::DrawImage(WebImage {
            rgba: vec![0, 1, 2, 3],
            width: 1,
            height: 1,
            dest: RectPt::new(4.0, 5.0, 6.0, 7.0),
        }));
        let out = lower(&dl);
        let json = serde_json::to_value(&out.layer).unwrap();
        let item = &json["items"][0];
        assert_eq!(item["kind"], "image");
        assert_eq!(item["width"], 1);
        assert_eq!(item["height"], 1);
        assert_eq!(item["x"], 4.0);
        assert_eq!(item["y"], 5.0);
        assert_eq!(item["w"], 6.0);
        assert_eq!(item["h"], 7.0);
        assert_eq!(item["rgba"], serde_json::json!([0, 1, 2, 3]));
    }

    #[test]
    fn linear_gradient_lowers_and_serializes_to_the_c1_3_wire_shape() {
        use crate::display_list::{WebGradient, WebGradientStop};
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: RectPt::new(0.0, 0.0, 10.0, 10.0).to_closed_path(),
            gradient: WebGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 10.0,
                y1: 0.0,
                stops: vec![
                    WebGradientStop {
                        offset: 0.0,
                        r: 1.0,
                        g: 0.0,
                        b: 0.0,
                        a: 1.0,
                    },
                    WebGradientStop {
                        offset: 1.0,
                        r: 0.0,
                        g: 0.0,
                        b: 1.0,
                        a: 1.0,
                    },
                ],
            },
        });
        let out = lower(&dl);
        let json = serde_json::to_value(&out.layer).unwrap();
        let item = &json["items"][0];
        // The exact keys/tags core (`paged_compose::SceneLayer`) consumes.
        assert_eq!(item["kind"], "fillPathGradient");
        assert_eq!(item["path"][0]["op"], "moveTo");
        assert_eq!(item["gradient"]["type"], "linear");
        assert_eq!(item["gradient"]["x0"], 0.0);
        assert_eq!(item["gradient"]["x1"], 10.0);
        let s = &item["gradient"]["stops"][0];
        assert_eq!(s["offset"], 0.0);
        assert_eq!(s["r"], 1.0);
        assert_eq!(s["g"], 0.0);
        assert_eq!(s["b"], 0.0);
        assert_eq!(s["a"], 1.0);
    }

    #[test]
    fn radial_gradient_lowers_and_serializes_to_the_c1_3_wire_shape() {
        use crate::display_list::{WebGradient, WebGradientStop};
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillGradient {
            path: RectPt::new(0.0, 0.0, 10.0, 10.0).to_closed_path(),
            gradient: WebGradient::Radial {
                cx: 5.0,
                cy: 5.0,
                radius: 5.0,
                stops: vec![
                    WebGradientStop {
                        offset: 0.0,
                        r: 1.0,
                        g: 1.0,
                        b: 1.0,
                        a: 1.0,
                    },
                    WebGradientStop {
                        offset: 1.0,
                        r: 0.0,
                        g: 0.0,
                        b: 0.0,
                        a: 1.0,
                    },
                ],
            },
        });
        let out = lower(&dl);
        let json = serde_json::to_value(&out.layer).unwrap();
        let g = &json["items"][0]["gradient"];
        assert_eq!(g["type"], "radial");
        assert_eq!(g["cx"], 5.0);
        assert_eq!(g["cy"], 5.0);
        assert_eq!(g["radius"], 5.0);
        assert_eq!(g["stops"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn cubic_segment_serializes_with_control_point_fields() {
        let mut dl = WebDisplayList::new();
        dl.push(WebDrawCmd::FillPath {
            path: vec![
                crate::wire::ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                crate::wire::ScenePathSeg::CubicTo {
                    cx1: 1.0,
                    cy1: 2.0,
                    cx2: 3.0,
                    cy2: 4.0,
                    x: 5.0,
                    y: 6.0,
                },
                crate::wire::ScenePathSeg::Close,
            ],
            paint: ScenePaint::BLACK,
        });
        let out = lower(&dl);
        let json = serde_json::to_value(&out.layer).unwrap();
        let cubic = &json["items"][0]["path"][1];
        assert_eq!(cubic["op"], "cubicTo");
        assert_eq!(cubic["cx1"], 1.0);
        assert_eq!(cubic["cy2"], 4.0);
        assert_eq!(cubic["x"], 5.0);
    }
}
