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
use blitz_dom::node::TextBrush;
use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use kurbo::{Affine, BezPath, PathEl, Point, Rect, Shape, Stroke, Vec2};
use parley::{Layout, PositionedLayoutItem};
use peniko::{BlendMode, Color, Fill, FontData, StyleRef};

use crate::display_list::{UnsupportedKind, WebDisplayList, WebDrawCmd, WebGlyphRun, WebImage};
use crate::fonts::{build_font_ctx, BUNDLED_FAMILY};
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

    /// Try to capture a raster image fill as a [`WebImage`]: extract straight
    /// RGBA8 pixels + dims, and the axis-aligned destination box (in content
    /// points) the `transform` maps the source rect onto. Returns `None`
    /// when the dest is rotated/sheared (no C-1 image transform yet — the
    /// caller records an honest `ImageFill` drop) or the pixels are
    /// malformed.
    fn capture_image(
        &self,
        image_brush: &peniko::ImageBrushRef<'_>,
        transform: Affine,
        shape: &impl Shape,
    ) -> Option<WebImage> {
        // The dest box: the source rect (`shape`) under the paint transform.
        // Only an axis-aligned dest lowers to a C-1 image (Stage A carries no
        // per-image transform); a rotated/sheared dest is the honest drop.
        let dest = as_axis_aligned_rect(shape, transform)?;
        if !dest.is_positive() {
            return None;
        }
        let image = image_brush.image;
        let rgba = image_to_straight_rgba8(image, image_brush.sampler.alpha)?;
        Some(WebImage {
            rgba,
            width: image.width,
            height: image.height,
            dest,
        })
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

/// Convert a peniko [`ImageData`] to straight (un-premultiplied) RGBA8 —
/// the C-1 `image` wire contract. Handles the two formats peniko exposes
/// (RGBA8 / BGRA8) and un-premultiplies premultiplied alpha. `extra_alpha`
/// (the brush sampler's alpha multiplier, 0..=1) folds into each pixel's
/// alpha. Returns `None` if the byte buffer doesn't describe `w*h` pixels
/// (a malformed image is dropped, never shipped truncated).
fn image_to_straight_rgba8(image: &peniko::ImageData, extra_alpha: f32) -> Option<Vec<u8>> {
    let (w, h) = (image.width as usize, image.height as usize);
    let px = w.checked_mul(h)?;
    let need = px.checked_mul(4)?;
    let src = image.data.data();
    if src.len() < need {
        return None;
    }
    let extra = extra_alpha.clamp(0.0, 1.0);
    let premultiplied = matches!(image.alpha_type, peniko::ImageAlphaType::AlphaPremultiplied);
    let bgra = matches!(image.format, peniko::ImageFormat::Bgra8);
    let mut out = Vec::with_capacity(need);
    for chunk in src[..need].chunks_exact(4) {
        // Read channels in source order, then swizzle BGRA → RGBA.
        let (mut r, mut g, mut b, a) = if bgra {
            (chunk[2], chunk[1], chunk[0], chunk[3])
        } else {
            (chunk[0], chunk[1], chunk[2], chunk[3])
        };
        if premultiplied && a != 0 {
            // Un-premultiply: straight = premul * 255 / a (rounded).
            let unmul =
                |c: u8| -> u8 { ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8 };
            r = unmul(r);
            g = unmul(g);
            b = unmul(b);
        }
        let a = (a as f32 * extra).round().clamp(0.0, 255.0) as u8;
        out.extend_from_slice(&[r, g, b, a]);
    }
    Some(out)
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
        let pr: PaintRef<'a> = brush.into();
        // A raster image fill: the anyrender `draw_image` path lands here as
        // `Paint::Image` with `shape` = the natural-size source rect and
        // `transform` mapping it onto the page (object-fit + scale folded
        // in). If the transform keeps the box axis-aligned we capture a real
        // `DrawImage` → C-1 `image`; a rotated/sheared image dest has no
        // C-1 image transform yet, so it stays an honest `ImageFill` drop.
        if let anyrender::Paint::Image(image_brush) = &pr {
            match self.capture_image(image_brush, transform, shape) {
                Some(img) => self.dl.push(WebDrawCmd::DrawImage(img)),
                None => self.dl.push(WebDrawCmd::NonSolidPaint {
                    what: UnsupportedKind::ImageFill,
                }),
            }
            return;
        }
        // Determine the unsupported KIND before consuming `brush`.
        let kind = match &pr {
            anyrender::Paint::Resource(_) | anyrender::Paint::Custom(_) => {
                Some(UnsupportedKind::ImageFill)
            }
            anyrender::Paint::Gradient(_) => Some(UnsupportedKind::GradientFill),
            anyrender::Paint::Image(_) | anyrender::Paint::Solid(_) => None,
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
        // The run's baseline is the first POSITIONED glyph's pen position,
        // carried through the transform — the same point the recovery walk
        // ([`recover_run_texts`]) computes via `Node::absolute_position`, so
        // the two correlate EXACTLY (no fuzzy matching). The `PaintScene`
        // sink never sees the run's source text (blitz-paint hands it only
        // glyph ids + positions), so this records empty `text`; the recovery
        // pass in [`render_html`] fills it from the DOM by baseline key.
        // C-1.1 reshapes the recovered string in the document default font,
        // so the lowering needs the plain text, never the glyph ids.
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
            // Empty here; [`render_html`]'s recovery pass keys this run's
            // baseline against a DOM inline-layout walk and fills the plain
            // text. An unmatched run STAYS empty (the lowering skips it),
            // never a faked glyph-id string — the seam stays honest.
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

/// Max baseline distance (in content points) at which a captured glyph
/// run is considered the SAME run as a recovered (text-carrying) one. The
/// two compute the same geometric point through equivalent transforms (at
/// scale 1, no CSS transforms — the v0 fragment scope), so a real match is
/// sub-point; this tolerance only absorbs f32 rounding.
const RUN_MATCH_TOL_PT: f32 = 0.5;

/// One run recovered from the DOM inline-layout walk: the run's first
/// positioned-glyph baseline (in content points, matching the capture's
/// key) + the run's PLAIN source text, sliced from the inline formatting
/// context's text by the run's byte range.
struct RecoveredRun {
    x: f32,
    y: f32,
    text: String,
}

/// Drive parse→style→layout→paint over `html` at `width_px`×`height_px`
/// (CSS px) and CAPTURE the paint into a [`WebDisplayList`], with each text
/// run's PLAIN TEXT recovered from the DOM. Mirrors the W0 spike's
/// `render_fragment`, but records commands instead of counting them, and:
///
///   1. registers the bundled fallback face ([`build_font_ctx`]) so text
///      SHAPES on wasm (parley/fontique exposes no system fonts there —
///      the spike's 22-vs-19 delta); the same context drives the native
///      build so tests exercise real shaping deterministically;
///   2. after paint, walks every inline root's parley `Layout` and slices
///      each glyph run's source text by its byte range, keyed by the run's
///      baseline, then fills that text into the matching captured run.
///
/// The output lowers via [`crate::lower::lower`]. A run with no recovered
/// match keeps empty text (the lowering skips it) — never a faked string.
pub fn render_html(html: &str, width_px: u32, height_px: u32) -> WebDisplayList {
    let config = DocumentConfig {
        font_ctx: Some(build_font_ctx()),
        ..Default::default()
    };
    let mut doc = HtmlDocument::from_html(html, config);
    doc.set_viewport(Viewport::new(width_px, height_px, 1.0, ColorScheme::Light));
    doc.resolve(0.0);

    let mut scene = CapturingScene::new();
    paint_scene(&mut scene, &mut doc, 1.0, width_px, height_px, 0, 0);
    let mut dl = scene.into_display_list();

    // Recover run text from the resolved document + attach it by baseline.
    // `HtmlDocument` derefs to `BaseDocument`.
    let recovered = recover_run_texts(&doc);
    attach_run_texts(&mut dl, &recovered);
    dl
}

/// Walk every inline-root node's parley `Layout`, slicing each glyph run's
/// PLAIN TEXT by its byte range and keying it on the run's first
/// positioned-glyph baseline in content points (the same key the capture
/// records). This is the honest text-recovery path: the text comes from
/// the DOM's own inline formatting context (`TextLayout::text`), not from
/// reverse-mapping glyph ids.
fn recover_run_texts(doc: &BaseDocument) -> Vec<RecoveredRun> {
    let mut out = Vec::new();
    // The node arena is contiguous ids; walk all of them and pick inline
    // roots (each owns one inline formatting context's layout + text).
    let root = doc.root_node().id;
    collect_inline_runs(doc, root, &mut out);
    out
}

/// Depth-first walk from `node_id`, collecting recovered runs from every
/// inline-root descendant (and the node itself if it is one).
fn collect_inline_runs(doc: &BaseDocument, node_id: usize, out: &mut Vec<RecoveredRun>) {
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    if node.flags.is_inline_root() {
        if let Some(element) = node.element_data() {
            if let Some(ild) = element.inline_layout_data.as_ref() {
                recover_layout_runs(node, &ild.text, &ild.layout, out);
            }
        }
    }
    for child in &node.children {
        collect_inline_runs(doc, *child, out);
    }
}

/// Recover every glyph run of one inline formatting context: for each run
/// on each line, slice `text[run.text_range()]` and compute the run's
/// first positioned-glyph baseline in absolute (page) content points via
/// `Node::absolute_position` — the SAME point the capture's `draw_glyphs`
/// records (`transform * first_positioned_glyph`), so they correlate.
fn recover_layout_runs(
    inline_root: &blitz_dom::Node,
    text: &str,
    layout: &Layout<TextBrush>,
    out: &mut Vec<RecoveredRun>,
) {
    for line in layout.lines() {
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                continue;
            };
            let run = glyph_run.run();
            let range = run.text_range();
            let Some(slice) = text.get(range) else {
                continue; // defensive: a non-char-boundary range never happens here
            };
            if slice.trim().is_empty() {
                continue;
            }
            // The run's first positioned glyph sits at (offset, baseline) in
            // the inline root's content-local space; map to absolute page
            // coords (CSS px, scale 1) then px→pt to match the capture key.
            let local_x = glyph_run.offset();
            let local_y = glyph_run.baseline();
            let abs = inline_root.absolute_position(local_x, local_y);
            out.push(RecoveredRun {
                x: CapturingScene::px_pt(abs.x as f64),
                y: CapturingScene::px_pt(abs.y as f64),
                text: slice.to_string(),
            });
        }
    }
}

/// Fill each captured `GlyphRun`'s empty `text` (and `family` hint) from
/// the recovered runs, matched by nearest baseline within
/// [`RUN_MATCH_TOL_PT`]. A captured run with no match stays empty (the
/// lowering then skips it). Each recovered run is consumed at most once so
/// two runs at (numerically) the same baseline don't both grab it.
fn attach_run_texts(dl: &mut WebDisplayList, recovered: &[RecoveredRun]) {
    let mut used = vec![false; recovered.len()];
    for cmd in &mut dl.commands {
        let WebDrawCmd::GlyphRun(run) = cmd else {
            continue;
        };
        let mut best: Option<(usize, f32)> = None;
        for (i, rec) in recovered.iter().enumerate() {
            if used[i] {
                continue;
            }
            let d = (rec.x - run.baseline_x).hypot(rec.y - run.baseline_y);
            if d <= RUN_MATCH_TOL_PT && best.map(|(_, bd)| d < bd).unwrap_or(true) {
                best = Some((i, d));
            }
        }
        if let Some((i, _)) = best {
            used[i] = true;
            run.text = recovered[i].text.clone();
            run.family = Some(BUNDLED_FAMILY.to_string());
        }
    }
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
    use crate::wire::SceneItem;

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

    fn image_data(
        rgba: Vec<u8>,
        w: u32,
        h: u32,
        format: peniko::ImageFormat,
        alpha_type: peniko::ImageAlphaType,
    ) -> peniko::ImageData {
        peniko::ImageData {
            data: peniko::Blob::from(rgba),
            format,
            alpha_type,
            width: w,
            height: h,
        }
    }

    #[test]
    fn rgba8_image_passes_through_straight() {
        // A 1×2 RGBA8 image (already straight) survives byte-for-byte.
        let src = vec![10, 20, 30, 255, 40, 50, 60, 128];
        let img = image_data(
            src.clone(),
            1,
            2,
            peniko::ImageFormat::Rgba8,
            peniko::ImageAlphaType::Alpha,
        );
        let out = image_to_straight_rgba8(&img, 1.0).expect("rgba8");
        assert_eq!(out, src);
    }

    #[test]
    fn bgra8_image_is_swizzled_to_rgba() {
        // One pixel in BGRA order (B=10, G=20, R=30, A=255) → RGBA (30,20,10,255).
        let img = image_data(
            vec![10, 20, 30, 255],
            1,
            1,
            peniko::ImageFormat::Bgra8,
            peniko::ImageAlphaType::Alpha,
        );
        let out = image_to_straight_rgba8(&img, 1.0).expect("bgra8");
        assert_eq!(out, vec![30, 20, 10, 255]);
    }

    #[test]
    fn premultiplied_image_is_unpremultiplied() {
        // Premultiplied (128,128,128) at a=128 → straight ~ (255,255,255,128).
        let img = image_data(
            vec![128, 128, 128, 128],
            1,
            1,
            peniko::ImageFormat::Rgba8,
            peniko::ImageAlphaType::AlphaPremultiplied,
        );
        let out = image_to_straight_rgba8(&img, 1.0).expect("premul");
        assert_eq!(out[3], 128);
        // 128 * 255 / 128 = 255 (rounded).
        assert_eq!(&out[0..3], &[255, 255, 255]);
    }

    #[test]
    fn sampler_alpha_folds_into_pixel_alpha() {
        let img = image_data(
            vec![10, 20, 30, 200],
            1,
            1,
            peniko::ImageFormat::Rgba8,
            peniko::ImageAlphaType::Alpha,
        );
        let out = image_to_straight_rgba8(&img, 0.5).expect("alpha");
        // a = round(200 * 0.5) = 100; colour channels untouched.
        assert_eq!(out, vec![10, 20, 30, 100]);
    }

    #[test]
    fn malformed_image_buffer_is_rejected() {
        // 2×2 claims 16 bytes but carries 4 → None (never shipped truncated).
        let img = image_data(
            vec![1, 2, 3, 4],
            2,
            2,
            peniko::ImageFormat::Rgba8,
            peniko::ImageAlphaType::Alpha,
        );
        assert!(image_to_straight_rgba8(&img, 1.0).is_none());
    }

    #[test]
    fn capture_image_maps_source_rect_to_an_axis_aligned_dest() {
        // The anyrender `draw_image` shape is the natural-size source rect
        // (0,0,w,h); the transform maps it onto the page. Capture computes
        // the dest in content points (px→pt).
        let scene = CapturingScene::new();
        let img = image_data(
            vec![0; 16],
            2,
            2,
            peniko::ImageFormat::Rgba8,
            peniko::ImageAlphaType::Alpha,
        );
        let brush = peniko::ImageBrush::new(img);
        let brush_ref = brush.as_ref();
        // Natural-size source rect.
        let src_rect = kurbo::Rect::new(0.0, 0.0, 2.0, 2.0);
        // Map onto a 96×96 px box at (96, 0) px → 72×72 pt at (72, 0) pt.
        let xf = Affine::translate((96.0, 0.0)) * Affine::scale_non_uniform(48.0, 48.0);
        let captured = scene
            .capture_image(&brush_ref, xf, &src_rect)
            .expect("axis-aligned image dest");
        assert_eq!((captured.width, captured.height), (2, 2));
        assert_eq!(captured.rgba.len(), 16);
        assert!(
            (captured.dest.x - 72.0).abs() < 1e-3,
            "x={}",
            captured.dest.x
        );
        assert!(
            (captured.dest.y - 0.0).abs() < 1e-3,
            "y={}",
            captured.dest.y
        );
        assert!(
            (captured.dest.w - 72.0).abs() < 1e-3,
            "w={}",
            captured.dest.w
        );
        assert!(
            (captured.dest.h - 72.0).abs() < 1e-3,
            "h={}",
            captured.dest.h
        );
    }

    #[test]
    fn capture_image_rejects_a_rotated_dest() {
        // A rotated image dest has no C-1 image transform → None (the caller
        // records an honest ImageFill drop instead).
        let scene = CapturingScene::new();
        let img = image_data(
            vec![0; 4],
            1,
            1,
            peniko::ImageFormat::Rgba8,
            peniko::ImageAlphaType::Alpha,
        );
        let brush = peniko::ImageBrush::new(img);
        let brush_ref = brush.as_ref();
        let src_rect = kurbo::Rect::new(0.0, 0.0, 1.0, 1.0);
        let xf = Affine::rotate(0.4) * Affine::scale(40.0);
        assert!(scene.capture_image(&brush_ref, xf, &src_rect).is_none());
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
    fn text_shapes_into_glyph_runs_with_the_bundled_face() {
        // The font-on-wasm proof (run natively against the SAME bundled
        // face the wasm engine uses): with the bundled Inter registered,
        // a paragraph SHAPES into at least one glyph run — i.e. glyph
        // count > 0. (Without a registered face, parley/fontique on wasm
        // shapes nothing — the spike's 22-vs-19 delta this closes.)
        let dl = render_html("<html><body><p>hello world</p></body></html>", 480, 320);
        let glyph_runs = dl
            .commands
            .iter()
            .filter(|c| matches!(c, WebDrawCmd::GlyphRun(_)))
            .count();
        assert!(
            glyph_runs >= 1,
            "expected the paragraph to shape into >=1 glyph run, got {glyph_runs} (dl: {dl:?})"
        );
    }

    #[test]
    fn render_html_recovers_run_text_to_a_lowered_c1_text_item() {
        // THE text-recovery round trip: a `<p>hello</p>` fragment must
        // lower to a C-1 `text` item whose `text` is the RECOVERED DOM
        // string "hello" (not glyph ids, not empty). This is the end-to-end
        // proof of step 3 (DOM run-text recovery).
        let dl = render_html("<html><body><p>hello</p></body></html>", 480, 320);
        let out = lower(&dl);
        let texts: Vec<&str> = out
            .layer
            .items
            .iter()
            .filter_map(|it| match it {
                SceneItem::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            texts.iter().any(|t| t.contains("hello")),
            "expected a recovered text item containing 'hello', got {texts:?} \
             (report {:?})",
            out.report
        );
        // The recovered run carries the bundled family hint, and the JSON
        // is the C-1 text wire shape.
        let json = serde_json::to_string(&out.layer).unwrap();
        assert!(json.contains("\"kind\":\"text\""), "json: {json}");
        assert!(json.contains("hello"), "json: {json}");
    }

    #[test]
    fn recovered_text_preserves_word_content_across_a_multi_word_run() {
        // A multi-word run recovers its full text (the byte-range slice of
        // the inline formatting context), not a truncation.
        let dl = render_html(
            "<html><body><p>paged web engine</p></body></html>",
            480,
            320,
        );
        let out = lower(&dl);
        let joined: String = out
            .layer
            .items
            .iter()
            .filter_map(|it| match it {
                SceneItem::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        for word in ["paged", "web", "engine"] {
            assert!(
                joined.contains(word),
                "recovered text {joined:?} missing {word:?}"
            );
        }
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
