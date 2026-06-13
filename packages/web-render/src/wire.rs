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
//!     `text` / `image` / `fillPathGradient` / `fillPathBlend` /
//!     `dropShadow` / `innerShadow` / `strokePathGradient` /
//!     `fillPathGradientBlend`), camelCase.
//!   · `ScenePathSeg` is internally tagged `op` (`moveTo` / `lineTo` /
//!     `cubicTo` / `close`), camelCase.
//!   · `SceneGradient` is internally tagged `type` (`linear` / `radial` /
//!     `sweep`); `SceneBlendMode` is a camelCase unit enum serializing to a
//!     bare string (`multiply` / `screen` / `colorDodge` / …).
//!   · field names are camelCase WHERE serde renames them — note that
//!     serde's `rename_all = "camelCase"` does NOT reach the struct fields of
//!     an INTERNALLY-TAGGED enum variant, so multi-word variant fields stay
//!     SNAKE_CASE on the wire (`start_angle`, `offset_x`, `offset_y`,
//!     `blur_radius`). Core uses the identical derive, so this matches core
//!     byte-for-byte (the JSON-shape contract tests pin each key).
//! Only the subset the web lane lowers to today is exercised (fillPath +
//! text + gradient + blend + drop-shadow); the other variants exist so the
//! type is the full contract and a widening slice (strokePath, image) is
//! additive.

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
    /// Fill a bezier path with a linear, radial, or sweep (conic) gradient
    /// (C-1.3). The gradient geometry is authored in frame-content points
    /// (the SAME space as `path`); core maps both by the frame transform, so
    /// the web lane emits gradient endpoints in the same content-point space
    /// its fills use. Additive to `FillPath` — solid fills are untouched.
    FillPathGradient {
        path: Vec<ScenePathSeg>,
        gradient: SceneGradient,
    },
    /// Fill a bezier path with a solid paint under a non-`Normal`
    /// compositing blend mode (C-1.4 — per-fill blend). A faithful twin of
    /// core's `SceneItem::FillPathBlend`: the `path` + `paint` are identical
    /// to a solid `FillPath`, plus a [`SceneBlendMode`] selecting how the
    /// fill composites onto the frame content already painted below it. The
    /// web lane lowers a CSS `mix-blend-mode` solid fill here. Additive to
    /// `FillPath`.
    FillPathBlend {
        path: Vec<ScenePathSeg>,
        paint: ScenePaint,
        blend: SceneBlendMode,
    },
    /// Stamp a CSS-style drop shadow behind a path (C-1.5 — `box-shadow` /
    /// `filter: drop-shadow`). A faithful twin of core's
    /// `SceneItem::DropShadow`: the path filled with the shadow `(r,g,b,a)`
    /// colour, offset by `(offset_x, offset_y)` content points and softened by
    /// a Gaussian of `blur_radius` (pt; all three stay snake_case on the wire,
    /// matching core). Core keeps the colour opaque and
    /// rides `a` as the shadow opacity, so emit `a` as the shadow alpha.
    /// Additive — it emits ONLY the shadow stamp (submit it BEFORE the fill,
    /// like CSS draws the shadow behind the element). Inset shadows + the CSS
    /// `spread` radius are honest follow-ons (not on this wire).
    DropShadow {
        path: Vec<ScenePathSeg>,
        offset_x: f32,
        offset_y: f32,
        blur_radius: f32,
        r: f32,
        g: f32,
        b: f32,
        a: f32,
    },
    /// Stamp an INSET (inner) shadow inside a path (C-1.6, protocol v47 — the
    /// CSS `box-shadow: inset` case). A faithful twin of core's
    /// `SceneItem::InnerShadow`: the path filled with the shadow `(r,g,b,a)`
    /// colour, composited INSIDE the path edge (CSS inset semantics) and
    /// softened by a Gaussian of `blur_radius` (pt). `choke` (pt) expands the
    /// shadow's hard edge before blurring (the inset-spread control); the web
    /// lane passes `choke: 0` because blitz-paint bakes the inset offset into
    /// the rect and does NOT inflate it by CSS `spread` (so inset spread beyond
    /// the offset is an honest follow-on, not faked into `choke`). Core keeps
    /// the colour opaque and rides `a` as the shadow opacity, composited Normal
    /// (CSS-faithful — not InDesign's Multiply default). As with `DropShadow`
    /// the variant's struct fields stay SNAKE_CASE on the wire (serde does not
    /// rename internally-tagged-variant fields here), matching core's identical
    /// derive byte-for-byte.
    InnerShadow {
        path: Vec<ScenePathSeg>,
        offset_x: f32,
        offset_y: f32,
        blur_radius: f32,
        choke: f32,
        r: f32,
        g: f32,
        b: f32,
        a: f32,
    },
    /// Stroke a bezier path with a linear / radial / sweep gradient (C-1.7,
    /// protocol v48). A faithful twin of core's `SceneItem::StrokePathGradient`:
    /// the gradient resolution of [`SceneItem::FillPathGradient`] on the stroke
    /// lane, plus the stroke `width` in content points. Lowers to core's
    /// existing `DisplayCommand::StrokePath` with a gradient `Paint`. The
    /// variant's three fields are SINGLE-TOKEN (`path`/`gradient`/`width`), so
    /// serde's camelCase rename is the identity — no snake_case wire key here
    /// (unlike `offset_x`/`start_angle`), matching core's identical derive
    /// byte-for-byte. Additive — solid strokes stay [`SceneItem::StrokePath`].
    StrokePathGradient {
        path: Vec<ScenePathSeg>,
        gradient: SceneGradient,
        width: f32,
    },
    /// Fill a bezier path with a gradient under a non-`Normal` compositing
    /// blend mode (C-1.8, protocol v48). A faithful twin of core's
    /// `SceneItem::FillPathGradientBlend`: the gradient of
    /// [`SceneItem::FillPathGradient`] composited like
    /// [`SceneItem::FillPathBlend`] (the [`SceneBlendMode`] selects how it
    /// composites onto the frame content below). Lowers to core's existing
    /// `DisplayCommand::FillPathBlend` carrying a gradient `Paint`. The three
    /// fields are SINGLE-TOKEN (`path`/`gradient`/`blend`), so the camelCase
    /// rename is the identity (no snake_case wire key), matching core's derive
    /// byte-for-byte. Additive — a SOLID fill under a blend stays
    /// [`SceneItem::FillPathBlend`]; a gradient NOT under a blend stays
    /// [`SceneItem::FillPathGradient`].
    FillPathGradientBlend {
        path: Vec<ScenePathSeg>,
        gradient: SceneGradient,
        blend: SceneBlendMode,
    },
}

/// A compositing blend mode for [`SceneItem::FillPathBlend`] (C-1.4). A
/// faithful twin of core's `paged_compose::scene_layer::SceneBlendMode` —
/// the CSS-relevant subset of the display list's blend modes. `Normal` is
/// intentionally absent (a normal fill is just [`SceneItem::FillPath`]). The
/// camelCase serde rename is LOAD-BEARING: each variant serializes to the
/// exact JSON string core deserializes (`multiply`, `screen`, `overlay`,
/// `darken`, `lighten`, `colorDodge`, `colorBurn`, `hardLight`, `softLight`,
/// `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`);
/// a drift silently drops the item at core's deserialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SceneBlendMode {
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
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
    /// Sweep (conic) gradient centred at `(cx,cy)` in content points, with
    /// the colour ramp beginning at `start_angle` (radians, from +x, turning
    /// CLOCKWISE in the y-down content space — the SAME convention peniko's
    /// `SweepGradientPosition::start_angle` uses) and wrapping once around the
    /// full turn. Lowers a CSS `conic-gradient`. A faithful twin of core's
    /// `SceneGradient::Sweep`: core carries only `startAngle` (a single full
    /// turn), so the captured `endAngle` is not on this wire — repeating /
    /// partial-arc conic gradients collapse to the full-turn ramp (the honest
    /// approximation, counted by the lowering).
    Sweep {
        cx: f32,
        cy: f32,
        start_angle: f32,
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

    #[test]
    fn sweep_gradient_serializes_to_the_exact_v46_keys_core_consumes() {
        // CONTRACT GUARD vs core (`SceneGradient::Sweep`, protocol v46):
        // tag = "type" → "sweep", fields cx / cy / start_angle / stops.
        // NOTE: serde's `rename_all = "camelCase"` on an INTERNALLY-TAGGED
        // enum does NOT rename the variant's struct FIELDS in this serde
        // version — so `start_angle` stays SNAKE_CASE on the wire. Core uses
        // the identical derive (same attrs, same field name), so snake_case
        // is exactly what core produces AND deserializes. (This is the silent-
        // drop trap the gradient lowering hit; the test pins the REAL key.)
        let g = SceneGradient::Sweep {
            cx: 25.0,
            cy: 30.0,
            start_angle: std::f32::consts::FRAC_PI_2,
            stops: vec![stop(0.0, 1.0, 0.0, 0.0, 1.0), stop(1.0, 0.0, 0.0, 1.0, 1.0)],
        };
        let json = serde_json::to_value(&g).unwrap();
        assert_eq!(json["type"], "sweep");
        assert_eq!(json["cx"], 25.0);
        assert_eq!(json["cy"], 30.0);
        // The wire key is `start_angle` (snake_case — what core emits/consumes).
        assert_eq!(json["start_angle"], std::f32::consts::FRAC_PI_2);
        assert!(
            json.get("startAngle").is_none(),
            "core emits start_angle (snake), NOT startAngle"
        );
        assert_eq!(json["stops"].as_array().unwrap().len(), 2);
        // Linear/radial-only fields are absent on a sweep.
        assert!(json.get("x0").is_none());
        assert!(json.get("radius").is_none());
        // Round-trips back to the same Rust value (deserialize parity).
        let back: SceneGradient = serde_json::from_value(json).unwrap();
        assert_eq!(back, g);
    }

    #[test]
    fn fill_path_blend_serializes_to_the_exact_v46_keys_core_consumes() {
        // CONTRACT GUARD vs core (`SceneItem::FillPathBlend`, protocol v46):
        // tag = "kind" → "fillPathBlend"; path + paint identical to a solid
        // FillPath, plus `blend` as the camelCase SceneBlendMode string.
        let item = SceneItem::FillPathBlend {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 10.0, y: 0.0 },
                ScenePathSeg::Close,
            ],
            paint: ScenePaint::rgba(1.0, 0.0, 0.0, 1.0),
            blend: SceneBlendMode::Multiply,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "fillPathBlend");
        assert_eq!(json["path"][0]["op"], "moveTo");
        assert_eq!(json["paint"]["r"], 1.0);
        assert_eq!(json["paint"]["a"], 1.0);
        // SceneBlendMode is a bare camelCase string (NOT an object/tag).
        assert_eq!(json["blend"], "multiply");
        let back: SceneItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn every_blend_mode_serializes_to_the_css_string_core_expects() {
        // The 15 CSS modes → the exact JSON string core's SceneBlendMode
        // deserializes (the camelCase rename of each variant). A mismatch on
        // ANY mode silently drops that blended fill at submit.
        let cases = [
            (SceneBlendMode::Multiply, "multiply"),
            (SceneBlendMode::Screen, "screen"),
            (SceneBlendMode::Overlay, "overlay"),
            (SceneBlendMode::Darken, "darken"),
            (SceneBlendMode::Lighten, "lighten"),
            (SceneBlendMode::ColorDodge, "colorDodge"),
            (SceneBlendMode::ColorBurn, "colorBurn"),
            (SceneBlendMode::HardLight, "hardLight"),
            (SceneBlendMode::SoftLight, "softLight"),
            (SceneBlendMode::Difference, "difference"),
            (SceneBlendMode::Exclusion, "exclusion"),
            (SceneBlendMode::Hue, "hue"),
            (SceneBlendMode::Saturation, "saturation"),
            (SceneBlendMode::Color, "color"),
            (SceneBlendMode::Luminosity, "luminosity"),
        ];
        for (mode, want) in cases {
            let json = serde_json::to_value(mode).unwrap();
            assert_eq!(json, want, "{mode:?} must serialize to {want:?}");
            // And round-trips back.
            let back: SceneBlendMode = serde_json::from_value(json).unwrap();
            assert_eq!(back, mode);
        }
    }

    #[test]
    fn drop_shadow_serializes_to_the_exact_v46_keys_core_consumes() {
        // CONTRACT GUARD vs core (`SceneItem::DropShadow`, protocol v46):
        // tag = "kind" → "dropShadow"; path + offset_x/offset_y/blur_radius +
        // the flat r/g/b/a colour fields. As with the sweep, the variant's
        // struct fields stay SNAKE_CASE on the wire (serde does not rename
        // internally-tagged-variant fields here) — and core's identical derive
        // emits/consumes the same snake_case keys.
        let item = SceneItem::DropShadow {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 20.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 20.0, y: 20.0 },
                ScenePathSeg::Close,
            ],
            offset_x: 4.0,
            offset_y: 6.0,
            blur_radius: 3.0,
            r: 0.1,
            g: 0.2,
            b: 0.3,
            a: 0.6,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "dropShadow");
        assert_eq!(json["path"][3]["op"], "close");
        // The SNAKE_CASE keys core emits/consumes (NOT camelCase).
        assert_eq!(json["offset_x"], 4.0);
        assert_eq!(json["offset_y"], 6.0);
        assert_eq!(json["blur_radius"], 3.0);
        assert!(
            json.get("offsetX").is_none(),
            "core emits offset_x (snake), NOT offsetX"
        );
        assert!(json.get("blurRadius").is_none());
        // The flat colour fields are present (exact float values are covered
        // by the round-trip below, which is the real deserialize-parity guard).
        for k in ["r", "g", "b", "a"] {
            assert!(json.get(k).is_some(), "colour field {k} present");
        }
        let back: SceneItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn inner_shadow_serializes_to_the_exact_v47_keys_core_consumes() {
        // CONTRACT GUARD vs core (`SceneItem::InnerShadow`, protocol v47, at
        // core commit dbf68d3): tag = "kind" → "innerShadow"; path +
        // offset_x/offset_y/blur_radius/choke + the flat r/g/b/a colour fields.
        // As with the sweep + drop shadow, the variant's struct fields stay
        // SNAKE_CASE on the wire (serde does not rename internally-tagged-
        // variant fields here) — and core's identical derive emits/consumes the
        // same snake_case keys. A drift silently DROPS the item at core's
        // deserialize, so it must fail HERE.
        let item = SceneItem::InnerShadow {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 20.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 20.0, y: 20.0 },
                ScenePathSeg::Close,
            ],
            offset_x: 2.0,
            offset_y: 3.0,
            blur_radius: 5.0,
            choke: 0.0,
            r: 0.1,
            g: 0.2,
            b: 0.3,
            a: 0.5,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "innerShadow");
        assert_eq!(json["path"][3]["op"], "close");
        // The SNAKE_CASE keys core emits/consumes (NOT camelCase).
        assert_eq!(json["offset_x"], 2.0);
        assert_eq!(json["offset_y"], 3.0);
        assert_eq!(json["blur_radius"], 5.0);
        assert_eq!(json["choke"], 0.0);
        assert!(
            json.get("offsetX").is_none(),
            "core emits offset_x (snake), NOT offsetX"
        );
        assert!(json.get("blurRadius").is_none());
        // The flat colour fields are present (exact float values covered by the
        // round-trip below, the real deserialize-parity guard).
        for k in ["r", "g", "b", "a"] {
            assert!(json.get(k).is_some(), "colour field {k} present");
        }
        // No stray keys leaked (the drop-shadow `choke`-less shape is distinct).
        assert!(json.get("width").is_none());
        let back: SceneItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn stroke_path_gradient_serializes_to_the_exact_v48_keys_core_consumes() {
        // CONTRACT GUARD vs core (`SceneItem::StrokePathGradient`, protocol
        // v48, at core commit 529767d): tag = "kind" → "strokePathGradient";
        // `path` + a `gradient` (the SAME tag = "type" SceneGradient as
        // FillPathGradient) + a `width`. All three variant fields are
        // SINGLE-TOKEN, so serde's camelCase rename is the IDENTITY here
        // (`path`/`gradient`/`width` — NOT snake_case, unlike `offset_x` /
        // `start_angle`), exactly what core's identical derive emits AND
        // deserializes. A drift silently DROPS the item at core's deserialize,
        // so it must fail HERE.
        let item = SceneItem::StrokePathGradient {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 40.0, y: 0.0 },
                ScenePathSeg::Close,
            ],
            gradient: SceneGradient::Linear {
                x0: 0.0,
                y0: 0.0,
                x1: 40.0,
                y1: 0.0,
                stops: vec![stop(0.0, 1.0, 0.0, 0.0, 1.0), stop(1.0, 0.0, 0.0, 1.0, 1.0)],
            },
            width: 3.5,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "strokePathGradient");
        assert_eq!(json["path"][0]["op"], "moveTo");
        // The gradient rides under "gradient" with the tag = "type" shape.
        assert_eq!(json["gradient"]["type"], "linear");
        assert_eq!(json["gradient"]["x1"], 40.0);
        assert_eq!(json["gradient"]["stops"].as_array().unwrap().len(), 2);
        // `width` is a single-token field — the camelCase rename is identity.
        assert_eq!(json["width"], 3.5);
        // No snake_case alias leaked (it never had a multi-token name, but pin
        // the wire key core consumes is literally `width`).
        assert!(
            json.get("paint").is_none(),
            "a gradient stroke carries no solid paint"
        );
        // Round-trips back to the same Rust value (deserialize parity).
        let back: SceneItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }

    #[test]
    fn fill_path_gradient_blend_serializes_to_the_exact_v48_keys_core_consumes() {
        // CONTRACT GUARD vs core (`SceneItem::FillPathGradientBlend`, protocol
        // v48, at core commit 529767d): tag = "kind" → "fillPathGradientBlend";
        // `path` + a `gradient` (tag = "type" SceneGradient) + a `blend` (the
        // camelCase SceneBlendMode string). All three variant fields are
        // SINGLE-TOKEN, so the camelCase rename is the IDENTITY here, exactly
        // what core's identical derive emits AND deserializes. A drift silently
        // DROPS the item at core's deserialize, so it must fail HERE.
        let item = SceneItem::FillPathGradientBlend {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 10.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 10.0, y: 10.0 },
                ScenePathSeg::Close,
            ],
            gradient: SceneGradient::Radial {
                cx: 5.0,
                cy: 5.0,
                radius: 5.0,
                stops: vec![stop(0.0, 1.0, 1.0, 1.0, 1.0), stop(1.0, 0.0, 0.0, 0.0, 1.0)],
            },
            blend: SceneBlendMode::Screen,
        };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "fillPathGradientBlend");
        assert_eq!(json["path"][3]["op"], "close");
        // The gradient rides under "gradient" with the tag = "type" shape.
        assert_eq!(json["gradient"]["type"], "radial");
        assert_eq!(json["gradient"]["radius"], 5.0);
        // `blend` is a bare camelCase SceneBlendMode string (NOT an object).
        assert_eq!(json["blend"], "screen");
        // No solid paint leaked (the blended fill carries a gradient, not a
        // ScenePaint — this is what distinguishes it from `fillPathBlend`).
        assert!(
            json.get("paint").is_none(),
            "a gradient blend carries no solid paint"
        );
        // Round-trips back to the same Rust value (deserialize parity).
        let back: SceneItem = serde_json::from_value(json).unwrap();
        assert_eq!(back, item);
    }
}
