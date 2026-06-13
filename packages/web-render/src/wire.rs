//! The C-1 `SceneLayer` wire IR (plugin scene-layer contract).
//!
//! These types are a faithful Rust twin of core's
//! `paged_compose::scene_layer` (canvas-wasm v0.40+) AND of the TS twin in
//! `web-model/src/render.ts`. The lowering ([`crate::lower`]) emits these;
//! serialized to JSON they are the exact payload the bundle hands to
//! `host.contribute.sceneLayer().submit(frameId, { items })`, which core
//! deserializes into its own `SceneLayer` and composes inside the frame
//! under `ItemTransform` + a content-box clip.
//!
//! The serde attributes are LOAD-BEARING — they make this Rust type and
//! core's produce/consume the same JSON:
//!   · `SceneItem` is internally tagged `kind` (`fillPath` / `strokePath` /
//!     `text` / `image`), camelCase.
//!   · `ScenePathSeg` is internally tagged `op` (`moveTo` / `lineTo` /
//!     `cubicTo` / `close`), camelCase.
//!   · field names are camelCase.
//! Only the subset the web lane lowers to today is exercised (fillPath +
//! text); the other variants exist so the type is the full contract and a
//! widening slice (strokePath, image) is additive.

use serde::{Deserialize, Serialize};

/// A plugin-submitted vector layer in frame-content coordinates (origin =
/// content-box top-left, x right, y down, points). Submitted keyed by the
/// host element id of the frame it renders into.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneLayer {
    pub items: Vec<SceneItem>,
}

/// One drawable in a [`SceneLayer`]. Coordinates are frame-content points.
/// The web lane lowers to `FillPath` + `Text` today; `StrokePath` and
/// `Image` are the contract's other variants (widening slices).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SceneItem {
    /// Fill a bezier path (non-zero winding) with a solid paint.
    FillPath {
        path: Vec<ScenePathSeg>,
        paint: ScenePaint,
    },
    /// Stroke a bezier path; `width` in content-space points.
    StrokePath {
        path: Vec<ScenePathSeg>,
        paint: ScenePaint,
        width: f32,
    },
    /// A single-line text run (C-1.1) — newlines are not laid out.
    Text(SceneTextItem),
    /// A pre-decoded RGBA8 image (C-1.2). Not produced by the web lane yet
    /// (the raster escape hatch / GPU-texture stage — deferred).
    Image {
        rgba: Vec<u8>,
        width: u32,
        height: u32,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
    },
}

/// A single-line text run in frame-content coordinates (C-1.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTextItem {
    /// Baseline origin x (points).
    pub x: f32,
    /// Baseline origin y (the text baseline, points).
    pub y: f32,
    /// The run's text (single line).
    pub text: String,
    /// Point size.
    pub size: f32,
    pub paint: ScenePaint,
    /// Reserved face hint — core v1 renders in the document default font.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

/// A bezier path segment in frame-content coordinates (points).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ScenePathSeg {
    MoveTo {
        x: f32,
        y: f32,
    },
    LineTo {
        x: f32,
        y: f32,
    },
    CubicTo {
        cx1: f32,
        cy1: f32,
        cx2: f32,
        cy2: f32,
        x: f32,
        y: f32,
    },
    Close,
}

/// A solid paint in **sRGB** (0..=1 per channel; alpha linear). Core
/// linearises it to match document colours — the lowering must hand sRGB.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePaint {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl ScenePaint {
    /// Opaque black — the default text/border colour when a paint can't be
    /// resolved to a solid (the honest fallback, never an invisible run).
    pub const BLACK: ScenePaint = ScenePaint {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };

    pub fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        ScenePaint { r, g, b, a }
    }
}

/// Axis-aligned rectangle in content points — a fill/border box from the
/// display list, before it is lowered to a closed `fillPath`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RectPt {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl RectPt {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        RectPt { x, y, w, h }
    }

    /// The rect as a closed 4-corner `fillPath` segment list (CW from the
    /// top-left). Used by the lowering to express a background/border box
    /// as the C-1 `FillPath` the wire carries.
    pub fn to_closed_path(self) -> Vec<ScenePathSeg> {
        vec![
            ScenePathSeg::MoveTo {
                x: self.x,
                y: self.y,
            },
            ScenePathSeg::LineTo {
                x: self.x + self.w,
                y: self.y,
            },
            ScenePathSeg::LineTo {
                x: self.x + self.w,
                y: self.y + self.h,
            },
            ScenePathSeg::LineTo {
                x: self.x,
                y: self.y + self.h,
            },
            ScenePathSeg::Close,
        ]
    }

    /// Whether the rect has positive area (a zero/negative box lowers to
    /// nothing — the honest skip).
    pub fn is_positive(self) -> bool {
        self.w > 0.0 && self.h > 0.0
    }
}
