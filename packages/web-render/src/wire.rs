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
    /// Fill a bezier path with a linear or radial gradient (C-1.3). The
    /// gradient geometry is authored in frame-content points (the SAME space
    /// as `path`); core maps both by the frame transform, so the web lane
    /// emits gradient endpoints in the same content-point space its fills
    /// use. Additive to `FillPath` — solid fills are untouched.
    FillPathGradient {
        path: Vec<ScenePathSeg>,
        gradient: SceneGradient,
    },
}

/// A plugin gradient paint for [`SceneItem::FillPathGradient`] (C-1.3). A
/// faithful twin of core's `paged_compose::scene_layer::SceneGradient` —
/// the serde tag (`type`) + camelCase fields are LOAD-BEARING (a drift
/// silently drops the item at core's deserialize). Coordinates are
/// frame-content points; colours are sRGB 0..=1 (core linearises +
/// offset-sorts at lowering, so stop order/space need not be normalised
/// here — but emit 0..=1 sRGB).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SceneGradient {
    /// Linear gradient from `(x0,y0)` to `(x1,y1)` in content points.
    Linear {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        stops: Vec<SceneGradientStop>,
    },
    /// Radial gradient centred at `(cx,cy)` with `radius`, in content points.
    Radial {
        cx: f32,
        cy: f32,
        radius: f32,
        stops: Vec<SceneGradientStop>,
    },
}

/// One colour stop in a [`SceneGradient`]. `offset` is `0.0..=1.0` along the
/// gradient axis; the colour is sRGB 0..=1 (core linearises at lowering).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneGradientStop {
    pub offset: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
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

#[cfg(test)]
mod gradient_wire_tests {
    //! The CONTRACT GUARD for the C-1.3 gradient wire. These pin the exact
    //! serde tags + field names core's `paged_compose::scene_layer`
    //! (`SceneItem::FillPathGradient` / `SceneGradient` / `SceneGradientStop`)
    //! deserializes. If the shape drifts from core, the item is silently
    //! DROPPED at submit — so a drift must fail HERE, not in production.
    use super::*;

    fn stop(offset: f32, r: f32, g: f32, b: f32, a: f32) -> SceneGradientStop {
        SceneGradientStop { offset, r, g, b, a }
    }

    #[test]
    fn linear_fill_path_gradient_serializes_to_the_exact_c1_3_keys() {
        let item = SceneItem::FillPathGradient {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 10.0, y: 0.0 },
                ScenePathSeg::Close,
            ],
            gradient: SceneGradient::Linear {
                x0: 1.0,
                y0: 2.0,
                x1: 3.0,
                y1: 4.0,
                stops: vec![stop(0.0, 1.0, 0.0, 0.0, 1.0), stop(1.0, 0.0, 0.0, 1.0, 0.5)],
            },
        };
        let json = serde_json::to_value(&item).unwrap();
        // SceneItem is tag = "kind", camelCase.
        assert_eq!(json["kind"], "fillPathGradient");
        // The path carries through under "path".
        assert_eq!(json["path"][0]["op"], "moveTo");
        // SceneGradient is tag = "type", camelCase; linear endpoints + stops.
        assert_eq!(json["gradient"]["type"], "linear");
        assert_eq!(json["gradient"]["x0"], 1.0);
        assert_eq!(json["gradient"]["y0"], 2.0);
        assert_eq!(json["gradient"]["x1"], 3.0);
        assert_eq!(json["gradient"]["y1"], 4.0);
        // SceneGradientStop fields: offset + r/g/b/a (camelCase = identity).
        let s0 = &json["gradient"]["stops"][0];
        assert_eq!(s0["offset"], 0.0);
        assert_eq!(s0["r"], 1.0);
        assert_eq!(s0["g"], 0.0);
        assert_eq!(s0["b"], 0.0);
        assert_eq!(s0["a"], 1.0);
        assert_eq!(json["gradient"]["stops"][1]["a"], 0.5);
        // No stray keys leaked onto the gradient (radial-only fields absent).
        assert!(json["gradient"].get("cx").is_none());
        assert!(json["gradient"].get("radius").is_none());
        // It round-trips back to the same Rust value (deserialize parity).
        let back: SceneItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn radial_gradient_serializes_with_centre_and_radius() {
        let g = SceneGradient::Radial {
            cx: 5.0,
            cy: 6.0,
            radius: 7.0,
            stops: vec![stop(0.0, 1.0, 1.0, 1.0, 1.0), stop(1.0, 0.0, 0.0, 0.0, 1.0)],
        };
        let json = serde_json::to_value(&g).unwrap();
        assert_eq!(json["type"], "radial");
        assert_eq!(json["cx"], 5.0);
        assert_eq!(json["cy"], 6.0);
        assert_eq!(json["radius"], 7.0);
        assert_eq!(json["stops"].as_array().unwrap().len(), 2);
        // Linear-only endpoints are absent on a radial.
        assert!(json.get("x0").is_none());
        assert!(json.get("x1").is_none());
        // Round-trips.
        let back: SceneGradient = serde_json::from_value(json).unwrap();
        assert_eq!(back, g);
    }
}
