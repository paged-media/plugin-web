//! The captured web display list — the PURE boundary type between Blitz's
//! paint output and the C-1 lowering.
//!
//! Blitz (`blitz-paint`) paints by pushing commands into an
//! `anyrender::PaintScene` sink. The W0 spike's `CountingScene` just
//! *counted* those commands; the capture layer ([`crate::capture`], behind
//! the `blitz` feature) instead *records* them into a [`WebDisplayList`].
//!
//! Crucially this type is PLAIN RUST with no Blitz/anyrender/kurbo deps —
//! so the lowering ([`crate::lower`]) is `WebDisplayList -> SceneLayer`,
//! a pure total function unit-testable on HAND-BUILT display lists with no
//! live Blitz. The capture layer's only job is to populate this type
//! faithfully; the mapping correctness is proven here, deterministically.
//!
//! Geometry is already in **content points** (the capture flattens Blitz's
//! `Affine` transform into the recorded points and converts CSS px → pt at
//! the document scale), so the lowering is a coordinate-preserving walk —
//! it never needs a transform stack.

use crate::wire::{RectPt, ScenePaint, ScenePathSeg};

/// A flattened bezier path in content points (the result of
/// `kurbo::Shape::path_elements` with quads already elevated to cubics).
/// Plain data so tests build paths without kurbo.
pub type FlatPath = Vec<ScenePathSeg>;

/// One captured paint command, in content points, with its transform
/// already folded into the geometry. The variants are exactly the
/// `PaintScene` sink methods the lowering can express on the C-1 wire
/// today (fills + glyph runs) plus the ones it deliberately drops to a
/// diagnostic (gradient/image brushes, box shadows) — recorded so the
/// lowering can COUNT what it skipped and report honestly, never silently.
#[derive(Debug, Clone, PartialEq)]
pub enum WebDrawCmd {
    /// A solid-colour fill of an axis-aligned rectangle — the overwhelming
    /// majority of web paint (backgrounds, borders-as-rects, block boxes).
    /// Fast-pathed to a 4-corner `fillPath` by the lowering.
    FillRect { rect: RectPt, paint: ScenePaint },

    /// A solid-colour fill of an arbitrary bezier path (border-radius,
    /// clip-path-shaped fills, non-rect backgrounds). Lowers 1:1 to a
    /// `fillPath`.
    FillPath { path: FlatPath, paint: ScenePaint },

    /// A solid-colour stroke of a path. Lowers to a `strokePath` (C-1 has
    /// the variant); kept for the widening slice.
    StrokePath {
        path: FlatPath,
        paint: ScenePaint,
        width: f32,
    },

    /// A shaped text run: one logical line at a baseline, in content
    /// points, with the run's plain text recovered. Lowers to a C-1
    /// `text` item. (The capture recovers `text` from the DOM run, not the
    /// glyph ids — C-1.1 reshapes in the document default font.)
    GlyphRun(WebGlyphRun),

    /// A pre-decoded raster image painted into an axis-aligned destination
    /// box (content points). `rgba` is straight (un-premultiplied) RGBA8,
    /// `width`×`height` its pixel dims; `dest` the on-page box (origin +
    /// size in points, with the paint transform + object-fit already
    /// folded in). Lowers to the EXISTING C-1 `SceneItem::Image` (Stage A,
    /// canvas-wasm v0.41+) — no core change. A rotated/sheared image dest
    /// is NOT this variant (the capture records it as an `ImageFill` drop,
    /// honestly counted, until C-1 carries an image transform).
    DrawImage(WebImage),

    /// A linear/radial gradient fill of a path (C-1.3). `path` is the
    /// flattened fill geometry (content points), `gradient` the gradient's
    /// endpoints + stops already resolved into the SAME content-point space
    /// (the paint/brush transform folded into the endpoints by the capture,
    /// like fills/images). Lowers to the C-1 `SceneItem::FillPathGradient`.
    /// Sweep/conic gradients are NOT this variant (no C-1 equivalent — the
    /// capture records them as a `NonSolidPaint` drop, honestly counted).
    FillGradient {
        path: FlatPath,
        gradient: WebGradient,
    },

    /// A fill/stroke/glyph whose brush was NOT a solid colour AND not a
    /// linear/radial gradient (image, pattern, sweep/conic gradient) — the
    /// C-1 wire can't carry it, so the lowering DROPS it and counts it as an
    /// unsupported-paint skip. Recorded (not discarded at capture) so the
    /// diagnostic is truthful.
    NonSolidPaint { what: UnsupportedKind },

    /// A box shadow / blur — no C-1 representation; counted + skipped.
    BoxShadow,
}

/// What kind of primitive carried the unsupported (non-solid) paint —
/// surfaced in the lowering's diagnostics so the author knows WHAT didn't
/// render, not just that something didn't.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsupportedKind {
    GradientFill,
    ImageFill,
    GradientStroke,
    GradientText,
}

impl UnsupportedKind {
    pub fn label(self) -> &'static str {
        match self {
            UnsupportedKind::GradientFill => "gradient fill",
            UnsupportedKind::ImageFill => "image/pattern fill",
            UnsupportedKind::GradientStroke => "gradient stroke",
            UnsupportedKind::GradientText => "gradient text",
        }
    }
}

/// A captured, positioned text run — the input to the C-1 `text` lowering.
/// `baseline_x`/`baseline_y` are the run origin in content points (the
/// paint transform already folded in, so the wire baseline is correct under
/// CSS transforms); `text` is the run's plain string (single logical line).
#[derive(Debug, Clone, PartialEq)]
pub struct WebGlyphRun {
    pub baseline_x: f32,
    pub baseline_y: f32,
    pub size: f32,
    pub text: String,
    pub paint: ScenePaint,
    /// The resolved family name, if the capture knows it (a face HINT for
    /// the renderer; C-1.1 still reshapes in the doc default font).
    pub family: Option<String>,
    /// The run's first-glyph point in the inline root's UNTRANSFORMED
    /// content-local space (content points) — the capture's
    /// transform-INVARIANT correlation key. The DOM run-text recovery
    /// computes the same point straight from the parley layout
    /// (`offset`/`baseline`), so a run correlates by this key even when a
    /// CSS transform moved its painted (`baseline_x`/`baseline_y`) position.
    /// The lowering IGNORES it (it only crosses the wire via the baseline).
    pub local_key: LocalKey,
}

/// A run's transform-invariant correlation key: the first-glyph point in the
/// inline root's untransformed content-local space (content points). Two
/// runs in the same inline formatting context never share one; the recovery
/// computes it identically from the parley layout, so it survives any CSS
/// transform on the inline root.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LocalKey {
    pub x: f32,
    pub y: f32,
}

impl LocalKey {
    pub fn new(x: f32, y: f32) -> Self {
        LocalKey { x, y }
    }
}

/// A captured raster image — the input to the C-1 `image` lowering. `rgba`
/// is straight RGBA8 (`width * height * 4` bytes), `dest` the axis-aligned
/// on-page box in content points (the paint transform + object-fit folded
/// in). Plain data so the lowering is testable without Blitz.
#[derive(Debug, Clone, PartialEq)]
pub struct WebImage {
    /// Straight (un-premultiplied) RGBA8 pixels, row-major, `w*h*4` bytes.
    pub rgba: Vec<u8>,
    /// Source pixel width.
    pub width: u32,
    /// Source pixel height.
    pub height: u32,
    /// The on-page destination box (content points).
    pub dest: RectPt,
}

/// A captured gradient paint — the input to the C-1.3 `fillPathGradient`
/// lowering. Endpoints are in content points (the paint/brush transform
/// folded in by the capture, like image dests), stops are sRGB 0..=1.
/// Plain data (no peniko) so the lowering is testable without Blitz. Sweep/
/// conic gradients have no variant here (no C-1 equivalent — dropped at
/// capture).
#[derive(Debug, Clone, PartialEq)]
pub enum WebGradient {
    /// A linear gradient along the axis from `(x0,y0)` to `(x1,y1)`.
    Linear {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        stops: Vec<WebGradientStop>,
    },
    /// A radial gradient centred at `(cx,cy)` with `radius` (content points).
    Radial {
        cx: f32,
        cy: f32,
        radius: f32,
        stops: Vec<WebGradientStop>,
    },
}

/// One captured gradient colour stop: normalized `offset` (0..=1) + straight
/// sRGB RGBA (0..=1). The lowering passes these to the C-1 wire 1:1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WebGradientStop {
    pub offset: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

/// The recorded paint of one web frame, in z-order (painter's order —
/// exactly the order Blitz emitted, which is the order core composes).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WebDisplayList {
    pub commands: Vec<WebDrawCmd>,
}

impl WebDisplayList {
    pub fn new() -> Self {
        WebDisplayList::default()
    }

    pub fn push(&mut self, cmd: WebDrawCmd) {
        self.commands.push(cmd);
    }

    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    pub fn len(&self) -> usize {
        self.commands.len()
    }
}
