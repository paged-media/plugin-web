//! The capture layer (feature = "blitz") — records Blitz's paint output
//! into a [`WebDisplayList`], then drives parse→style→layout→paint exactly
//! like the W0 spike so the lowering consumes REAL Blitz layout.
//!
//! This is the engine-coupled half of the crate. It is the spike's
//! `CountingScene` turned into a `CapturingScene`: instead of incrementing
//! counters in `PaintScene`'s methods, it pushes [`WebDrawCmd`]s. Behind
//! the `blitz` feature so the default build, the bundle CI gate, and the
//! lowering tests never pull the alpha Blitz/anyrender/kurbo/peniko stack.
//!
//! THE NAMED NEXT SLICE (the honest deferral): `render_html` below compiles
//! and runs against this stack on NATIVE today (the spike proved both
//! native and wasm32 compile + paint). What remains is the bundle WASM
//! ARTIFACT — `cargo build --target wasm32-unknown-unknown` + `wasm-bindgen`
//! of THIS crate into `bin/blitz_web.wasm` (manifest `capabilities.wasm`),
//! plus font registration parity (the spike's W1 task: register pinned
//! faces like `ViewerSession::register_font` so text shapes on wasm where
//! there are no system fonts). The integration point is exactly
//! [`capture_paint`] / [`render_html`]: their output `WebDisplayList`
//! already lowers via [`crate::lower::lower`]. See `scripts/build-wasm.sh`.
//!
//! (Gated `#[cfg(feature = "blitz")]` at the `mod capture` declaration in
//! `lib.rs`, so this whole module only compiles with the engine stack.)

use anyrender::{Glyph, NormalizedCoord, PaintRef, PaintScene, RenderContext};
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use kurbo::{Affine, BezPath, PathEl, Point, Rect, Shape, Stroke, Vec2};
use peniko::{BlendMode, Color, Fill, FontData, StyleRef};

use crate::display_list::{UnsupportedKind, WebDisplayList, WebDrawCmd, WebGlyphRun};
use crate::wire::{RectPt, ScenePaint, ScenePathSeg};

/// CSS px → PostScript points (1 px = 1/96 in, 1 pt = 1/72 in → 72/96).
const PX_TO_PT: f64 = 72.0 / 96.0;

/// Curve-flattening tolerance, in CSS px (kurbo `path_elements`). 0.1 px is
/// well below a printed dot at any sane DPI; the lowering re-expresses the
/// flattened cubics as C-1 `cubicTo` segments, so this only bounds the
/// quad→cubic elevation, not raster quality.
const FLATTEN_TOL: f64 = 0.1;

/// A `PaintScene` sink that records draw commands into a
/// [`WebDisplayList`] in content points (CSS px scaled by [`PX_TO_PT`]),
/// with each command's `Affine` already folded into its geometry.
#[derive(Default)]
pub struct CapturingScene {
    dl: WebDisplayList,
}

impl CapturingScene {
    pub fn new() -> Self {
        CapturingScene::default()
    }

    /// Consume the sink and return what was painted.
    pub fn into_display_list(self) -> WebDisplayList {
        self.dl
    }

    fn px_pt(v: f64) -> f32 {
        (v * PX_TO_PT) as f32
    }
}

/// Extract a solid sRGB paint from a brush, or `None` if it is a
/// gradient/image/custom brush (which the C-1 wire can't carry — the
/// caller records a `NonSolidPaint` drop instead of faking a colour).
fn solid_paint<'a>(brush: impl Into<PaintRef<'a>>) -> Option<ScenePaint> {
    match brush.into() {
        anyrender::Paint::Solid(c) => {
            // peniko `Color` components are sRGB f32 [r,g,b,a].
            let [r, g, b, a] = c.components;
            Some(ScenePaint::rgba(r, g, b, a))
        }
        _ => None,
    }
}

/// Map a transformed kurbo `Point` to a content-point `(x, y)`.
fn pt(transform: Affine, p: Point) -> (f32, f32) {
    let tp = transform * p;
    (CapturingScene::px_pt(tp.x), CapturingScene::px_pt(tp.y))
}

/// Flatten a kurbo `Shape` (under `transform`) to C-1 path segments in
/// content points. Quads are elevated to cubics (C-1 has no quad op); the
/// transform is applied per-point so the captured path is transform-free.
fn flatten_shape(shape: &impl Shape, transform: Affine) -> Vec<ScenePathSeg> {
    let mut out = Vec::new();
    // Track the current point so a QuadTo can be elevated to a cubic.
    let mut cur = Point::ZERO;
    for el in shape.path_elements(FLATTEN_TOL) {
        match el {
            PathEl::MoveTo(p) => {
                let (x, y) = pt(transform, p);
                out.push(ScenePathSeg::MoveTo { x, y });
                cur = p;
            }
            PathEl::LineTo(p) => {
                let (x, y) = pt(transform, p);
                out.push(ScenePathSeg::LineTo { x, y });
                cur = p;
            }
            PathEl::QuadTo(c, p) => {
                // Quad → cubic elevation: c1 = cur + 2/3(c-cur), c2 = p +
                // 2/3(c-p). Done in CSS-px space, then transformed.
                let c1 = cur + (2.0 / 3.0) * (c - cur);
                let c2 = p + (2.0 / 3.0) * (c - p);
                let (cx1, cy1) = pt(transform, c1);
                let (cx2, cy2) = pt(transform, c2);
                let (x, y) = pt(transform, p);
                out.push(ScenePathSeg::CubicTo {
                    cx1,
                    cy1,
                    cx2,
                    cy2,
                    x,
                    y,
                });
                cur = p;
            }
            PathEl::CurveTo(c1, c2, p) => {
                let (cx1, cy1) = pt(transform, c1);
                let (cx2, cy2) = pt(transform, c2);
                let (x, y) = pt(transform, p);
                out.push(ScenePathSeg::CubicTo {
                    cx1,
                    cy1,
                    cx2,
                    cy2,
                    x,
                    y,
                });
                cur = p;
            }
            PathEl::ClosePath => out.push(ScenePathSeg::Close),
        }
    }
    out
}

/// Whether a transformed shape is an axis-aligned rectangle — the common
/// case (backgrounds, borders), fast-pathed to a [`WebDrawCmd::FillRect`]
/// so the lowering emits a tidy box rather than a 5-segment path.
fn as_axis_aligned_rect(shape: &impl Shape, transform: Affine) -> Option<RectPt> {
    let rect = shape.as_rect()?;
    // Only a rotation-free / shear-free transform keeps a rect a rect.
    let c = transform.as_coeffs();
    let axis_aligned = c[1].abs() < 1e-6 && c[2].abs() < 1e-6;
    if !axis_aligned {
        return None;
    }
    let tl = transform * Point::new(rect.x0, rect.y0);
    let br = transform * Point::new(rect.x1, rect.y1);
    let x = CapturingScene::px_pt(tl.x.min(br.x));
    let y = CapturingScene::px_pt(tl.y.min(br.y));
    let w = CapturingScene::px_pt((br.x - tl.x).abs());
    let h = CapturingScene::px_pt((br.y - tl.y).abs());
    Some(RectPt::new(x, y, w, h))
}

impl RenderContext for CapturingScene {}

impl PaintScene for CapturingScene {
    fn reset(&mut self) {
        self.dl = WebDisplayList::default();
    }

    // Clip/layer stack is not lowered (C-1 already clips the layer to the
    // content box). A no-op keeps painter's order intact.
    fn push_layer(
        &mut self,
        _blend: impl Into<BlendMode>,
        _alpha: f32,
        _transform: Affine,
        _clip: &impl Shape,
    ) {
    }

    fn push_clip_layer(&mut self, _transform: Affine, _clip: &impl Shape) {}

    fn pop_layer(&mut self) {}

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        _brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        match solid_paint(brush) {
            Some(paint) => {
                let path = flatten_shape(shape, transform);
                // Stroke width scales with the transform's average scale.
                let c = transform.as_coeffs();
                let scale = ((c[0] * c[3] - c[1] * c[2]).abs()).sqrt();
                let width = CapturingScene::px_pt(style.width * scale);
                self.dl.push(WebDrawCmd::StrokePath { path, paint, width });
            }
            None => self.dl.push(WebDrawCmd::NonSolidPaint {
                what: UnsupportedKind::GradientStroke,
            }),
        }
    }

    fn fill<'a>(
        &mut self,
        _style: Fill,
        transform: Affine,
        brush: impl Into<PaintRef<'a>>,
        _brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        // Determine the unsupported KIND before consuming `brush`.
        let pr: PaintRef<'a> = brush.into();
        let kind = match &pr {
            anyrender::Paint::Image(_) | anyrender::Paint::Resource(_) => {
                Some(UnsupportedKind::ImageFill)
            }
            anyrender::Paint::Gradient(_) => Some(UnsupportedKind::GradientFill),
            anyrender::Paint::Custom(_) => Some(UnsupportedKind::ImageFill),
            anyrender::Paint::Solid(_) => None,
        };
        match solid_paint(pr) {
            Some(paint) => {
                if let Some(rect) = as_axis_aligned_rect(shape, transform) {
                    self.dl.push(WebDrawCmd::FillRect { rect, paint });
                } else {
                    let path = flatten_shape(shape, transform);
                    self.dl.push(WebDrawCmd::FillPath { path, paint });
                }
            }
            None => self.dl.push(WebDrawCmd::NonSolidPaint {
                what: kind.unwrap_or(UnsupportedKind::GradientFill),
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_glyphs<'a, 's: 'a>(
        &'s mut self,
        _font: &'a FontData,
        font_size: f32,
        _hint: bool,
        _normalized_coords: &'a [NormalizedCoord],
        _embolden: Vec2,
        _style: impl Into<StyleRef<'a>>,
        brush: impl Into<PaintRef<'a>>,
        brush_alpha: f32,
        transform: Affine,
        _glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        // The run's baseline is the first glyph's pen position, carried
        // through the transform. Text RECOVERY (glyph ids → chars) needs a
        // cmap reverse map the capture doesn't own yet; C-1.1 reshapes in
        // the document default font, so the lowering needs the run's plain
        // text from the DOM, not the glyph ids. This native sink records
        // the geometry + paint; the wasm integration attaches the DOM run
        // text (the named next slice). Empty text here → the lowering skips
        // it (no fake glyph-id text), keeping the seam honest.
        let paint = match solid_paint(brush) {
            Some(mut p) => {
                p.a *= brush_alpha.clamp(0.0, 1.0);
                p
            }
            None => {
                self.dl.push(WebDrawCmd::NonSolidPaint {
                    what: UnsupportedKind::GradientText,
                });
                return;
            }
        };
        let Some(first) = glyphs.clone().next() else {
            return;
        };
        let baseline = transform * Point::new(first.x as f64, first.y as f64);
        self.dl.push(WebDrawCmd::GlyphRun(WebGlyphRun {
            baseline_x: CapturingScene::px_pt(baseline.x),
            baseline_y: CapturingScene::px_pt(baseline.y),
            size: CapturingScene::px_pt(font_size as f64),
            // The capture cannot recover characters from glyph ids without
            // a reverse cmap; the wasm integration supplies the DOM run
            // text. Empty here keeps the seam honest (skipped, never faked).
            text: String::new(),
            paint,
            family: None,
        }));
    }

    fn draw_box_shadow(
        &mut self,
        _transform: Affine,
        _rect: Rect,
        _brush: Color,
        _radius: f64,
        _std_dev: f64,
    ) {
        self.dl.push(WebDrawCmd::BoxShadow);
    }
}

/// Drive parse→style→layout→paint over `html` at `width_px`×`height_px`
/// (CSS px) and CAPTURE the paint into a [`WebDisplayList`]. Mirrors the W0
/// spike's `render_fragment`, but records commands instead of counting
/// them. The output lowers via [`crate::lower::lower`].
///
/// NOTE: on a host with no registered fonts (wasm32) text shapes to
/// nothing — the spike's documented 22-vs-19 delta. The wasm integration
/// registers pinned faces first (W1 task); this native driver uses the
/// system-font path only when the `blitz-dom/system_fonts` feature is on
/// (it is OFF by default here to keep the build deterministic), so the
/// boxes/borders capture is the deterministic part exercised in tests.
pub fn render_html(html: &str, width_px: u32, height_px: u32) -> WebDisplayList {
    let mut doc = HtmlDocument::from_html(html, DocumentConfig::default());
    doc.set_viewport(Viewport::new(width_px, height_px, 1.0, ColorScheme::Light));
    doc.resolve(0.0);
    let mut scene = CapturingScene::new();
    paint_scene(&mut scene, &mut doc, 1.0, width_px, height_px, 0, 0);
    scene.into_display_list()
}

/// Lower a captured render in one call — the bundle/native convenience
/// path: HTML in, C-1 layer + report out (the ADR-011 contract end-to-end
/// once Blitz is the wasm artifact).
pub fn render_and_lower(html: &str, width_px: u32, height_px: u32) -> crate::lower::Lowered {
    crate::lower::lower(&render_html(html, width_px, height_px))
}

/// A tiny demonstrator path so the capture machinery is reachable +
/// non-trivial in any build that enables `blitz` (and a place the wasm
/// entry point can call). Returns a small content-point bezier built from
/// kurbo so `flatten_shape` is exercised.
pub fn _demo_flatten() -> Vec<ScenePathSeg> {
    let mut bp = BezPath::new();
    bp.move_to(Point::new(0.0, 0.0));
    bp.quad_to(Point::new(10.0, 0.0), Point::new(10.0, 10.0));
    bp.close_path();
    flatten_shape(&bp, Affine::IDENTITY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lower::lower;

    /// A flexbox card with backgrounds + borders — the W0 spike's
    /// representative fragment shape (without relying on system fonts).
    const FRAGMENT: &str = r#"<!DOCTYPE html><html><head><style>
      body { margin: 0; background: #eef1f5; }
      .card { display: flex; gap: 12px; padding: 16px;
              border: 2px solid #314158; background: #ffffff; }
      .badge { width: 64px; height: 64px; background: #0a6e8a; }
    </style></head><body>
      <div class="card"><div class="badge"></div></div>
    </body></html>"#;

    #[test]
    fn pt_conversion_is_css_px_to_points() {
        // 96 CSS px = 1 in = 72 pt.
        assert!((CapturingScene::px_pt(96.0) - 72.0).abs() < 1e-3);
    }

    #[test]
    fn axis_aligned_rect_fast_path_round_trips_under_translation() {
        let r = kurbo::Rect::new(10.0, 20.0, 110.0, 70.0); // 100×50 px
        let xf = Affine::translate((5.0, 5.0));
        let rp = as_axis_aligned_rect(&r, xf).expect("axis-aligned rect");
        // (15,25) px → ×0.75 = (11.25, 18.75) pt; 100×50 px → 75×37.5 pt.
        assert!((rp.x - 11.25).abs() < 1e-3, "x={}", rp.x);
        assert!((rp.y - 18.75).abs() < 1e-3, "y={}", rp.y);
        assert!((rp.w - 75.0).abs() < 1e-3, "w={}", rp.w);
        assert!((rp.h - 37.5).abs() < 1e-3, "h={}", rp.h);
    }

    #[test]
    fn rotated_transform_is_not_treated_as_an_axis_aligned_rect() {
        let r = kurbo::Rect::new(0.0, 0.0, 10.0, 10.0);
        let xf = Affine::rotate(0.5);
        assert!(as_axis_aligned_rect(&r, xf).is_none());
    }

    #[test]
    fn quad_is_elevated_to_a_cubic_segment() {
        let segs = _demo_flatten();
        assert!(matches!(segs[0], ScenePathSeg::MoveTo { .. }));
        assert!(
            matches!(segs[1], ScenePathSeg::CubicTo { .. }),
            "quad must elevate to cubic, got {:?}",
            segs[1]
        );
        assert!(matches!(segs.last(), Some(ScenePathSeg::Close)));
    }

    #[test]
    fn real_blitz_paint_captures_solid_box_fills_that_lower() {
        // The end-to-end native proof: parse → style → layout → paint the
        // fragment, capture, lower. The card/badge backgrounds + the body
        // background must show up as solid fills in the C-1 layer. (Text is
        // absent without registered fonts — the documented wasm parity gap;
        // the boxes are the deterministic, font-free part.)
        let dl = render_html(FRAGMENT, 480, 320);
        assert!(!dl.is_empty(), "Blitz painted nothing");
        let out = lower(&dl);
        assert!(
            out.report.fills >= 3,
            "expected the body+card+badge backgrounds as fills, got report {:?}",
            out.report
        );
        // Every emitted item is a real C-1 SceneItem (no panic, no fake).
        assert_eq!(out.report.emitted, out.layer.items.len());
        // It serializes to the wire core consumes.
        let json = serde_json::to_string(&out.layer).unwrap();
        assert!(json.contains("\"kind\":\"fillPath\""), "json: {json}");
    }
}
