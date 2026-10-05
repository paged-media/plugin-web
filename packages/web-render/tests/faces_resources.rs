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

//! Faces and sub-resources against the real engine: runs shape in, and carry,
//! their own face (family, weight, italic); faces registered by the host shape
//! under the family the source names; images, stylesheets and `@font-face`
//! sources load from registered bytes and `data:` URIs — never the network —
//! and what does not load is reported.
//!
//! Every test runs on a FRESH thread: the font context and the resource
//! registry are per engine thread, as in the wasm engine.

#![allow(non_snake_case)] // the `__feat__<id>` cockpit suffix

use serde_json::Value;
use web_render::capture::render_and_lower;
use web_render::fonts::{register_font, INTER_REGULAR};
use web_render::resources::{register_resource, take_resource_misses};

/// A 4 x 4 opaque red PNG.
const RED_PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC";

fn red_png() -> Vec<u8> {
    web_render::resources::decode_data_url(&format!("data:image/png;base64,{RED_PNG_B64}"))
        .expect("png")
}

/// Shaping shares process state across threads (see `capture::SHAPE_LOCK`):
/// one render at a time.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn on_fresh_thread(f: impl FnOnce() + Send + 'static) {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::thread::spawn(f).join().expect("test thread");
}

fn items(html: &str) -> Vec<Value> {
    let low = render_and_lower(html, 400, 300);
    let v = serde_json::to_value(&low.layer).unwrap();
    v["items"].as_array().cloned().unwrap_or_default()
}

fn text_item(items: &[Value], text: &str) -> Value {
    items
        .iter()
        .find(|i| i["kind"] == "text" && i["text"].as_str().map(str::trim) == Some(text))
        .cloned()
        .unwrap_or_else(|| panic!("no text item {text:?} in {items:?}"))
}

fn kinds(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|i| i["kind"].as_str().unwrap_or("").to_string())
        .collect()
}

#[test]
fn bold_and_italic_runs_carry_their_face__feat__plugin_web_web_fonts() {
    on_fresh_thread(|| {
        let it = items("<p>Plain <b>Heavy</b> <i>Slanted</i></p>");
        let plain = text_item(&it, "Plain");
        assert_eq!(plain["family"], "Inter");
        assert!(
            plain.get("weight").is_none(),
            "regular weight stays off the wire"
        );
        assert!(plain.get("italic").is_none(), "upright stays off the wire");
        let heavy = text_item(&it, "Heavy");
        assert_eq!(heavy["family"], "Inter");
        assert_eq!(heavy["weight"].as_f64(), Some(700.0));
        let slanted = text_item(&it, "Slanted");
        assert_eq!(slanted["italic"], true);
    });
}

#[test]
fn a_bold_run_shapes_in_the_bold_face__feat__plugin_web_web_fonts() {
    // Inter is variable: a bold run shapes at wght 700, which is wider.
    on_fresh_thread(|| {
        let regular = render_and_lower("<p>Hamburgefonstiv</p>", 600, 200);
        let bold = render_and_lower("<p><b>Hamburgefonstiv</b></p>", 600, 200);
        let (r, b) = (regular.text_advances[0], bold.text_advances[0]);
        assert!(r > 10.0, "a measured advance, not zero: {r}");
        assert!(b > r * 1.03, "bold {b} is wider than regular {r}");
    });
}

#[test]
fn a_family_nobody_registered_falls_back_instead_of_vanishing__feat__plugin_web_web_fonts() {
    // Before the bundled face was the script fallback, a run naming an
    // unknown family shaped with no face and painted nothing.
    on_fresh_thread(|| {
        let it = items("<p style=\"font-family:Georgia\">Still here</p>");
        assert_eq!(text_item(&it, "Still here")["family"], "Inter");
    });
}

#[test]
fn a_registered_face_shapes_under_the_family_the_source_names__feat__plugin_web_web_fonts() {
    on_fresh_thread(|| {
        let html = "<p style=\"font-family:'Brand Sans'\">Branded</p>";
        // Unregistered: the run falls back to the bundled face.
        assert_eq!(text_item(&items(html), "Branded")["family"], "Inter");
        let names = register_font(INTER_REGULAR, Some("Brand Sans"));
        assert_eq!(names, vec!["Brand Sans".to_string()]);
        assert_eq!(text_item(&items(html), "Branded")["family"], "Brand Sans");
    });
}

#[test]
fn registering_the_same_face_twice_registers_it_once__feat__plugin_web_web_fonts() {
    on_fresh_thread(|| {
        web_render::perf::reset_perf_counters();
        let _ = items("<p>warm</p>");
        let builds = web_render::perf::perf_counters().font_context_builds;
        register_font(INTER_REGULAR, Some("Twice"));
        register_font(INTER_REGULAR, Some("Twice"));
        let _ = items("<p style=\"font-family:Twice\">x</p>");
        let c = web_render::perf::perf_counters();
        if web_render::perf::ENABLED {
            assert_eq!(c.font_registrations, 1);
            assert_eq!(
                c.font_context_builds, builds,
                "no context rebuild for a face"
            );
        }
        assert!(register_font(b"not a font", Some("Junk")).is_empty());
    });
}

#[test]
fn an_img_loads_from_a_registered_resource__feat__plugin_web_resources() {
    on_fresh_thread(|| {
        register_resource("img/red.png", &red_png());
        let it = items("<img src=\"img/red.png\" style=\"width:40px;height:40px\">");
        assert!(
            kinds(&it).contains(&"image".to_string()),
            "{:?}",
            kinds(&it)
        );
        let img = it.iter().find(|i| i["kind"] == "image").unwrap();
        assert_eq!(img["width"], 4);
        assert_eq!(img["w"].as_f64(), Some(30.0), "40 px = 30 pt");
        assert!(take_resource_misses().is_empty());
    });
}

#[test]
fn a_data_uri_image_loads_without_registration__feat__plugin_web_resources() {
    on_fresh_thread(|| {
        let html = format!(
            "<img src=\"data:image/png;base64,{RED_PNG_B64}\" style=\"width:8px;height:8px\">"
        );
        assert!(kinds(&items(&html)).contains(&"image".to_string()));
    });
}

#[test]
fn a_css_background_image_loads__feat__plugin_web_resources() {
    on_fresh_thread(|| {
        register_resource("img/red.png", &red_png());
        let it =
            items("<div style=\"width:40px;height:40px;background-image:url(img/red.png)\"></div>");
        assert!(
            kinds(&it).contains(&"image".to_string()),
            "{:?}",
            kinds(&it)
        );
    });
}

#[test]
fn a_linked_stylesheet_applies__feat__plugin_web_resources() {
    on_fresh_thread(|| {
        register_resource("css/site.css", b"p { color: #ff0000 }");
        let it = items("<link rel=\"stylesheet\" href=\"css/site.css\"><p>Red</p>");
        let red = text_item(&it, "Red");
        assert_eq!(red["paint"]["r"].as_f64(), Some(1.0));
        assert_eq!(red["paint"]["g"].as_f64(), Some(0.0));
    });
}

#[test]
fn a_font_face_source_loads_and_shapes__feat__plugin_web_web_fonts() {
    on_fresh_thread(|| {
        register_resource("fonts/brand.ttf", INTER_REGULAR);
        let it = items(
            "<style>@font-face{font-family:'Face From Css';src:url(fonts/brand.ttf)}</style>\
             <p style=\"font-family:'Face From Css'\">Faced</p>",
        );
        // The face loaded: the run shaped with it (its own name table says
        // Inter, the bytes being Inter) — and nothing was missing.
        assert!(take_resource_misses().is_empty());
        assert_eq!(text_item(&it, "Faced")["family"], "Inter");
    });
}

#[test]
fn an_asset_store_url_loads_only_when_registered_as_is__feat__plugin_web_resources() {
    on_fresh_thread(|| {
        register_resource("paged-image:u1a", &red_png());
        let it = items("<img src=\"paged-image:u1a\" style=\"width:10px;height:10px\">");
        assert!(kinds(&it).contains(&"image".to_string()));
        assert!(take_resource_misses().is_empty());
    });
}

#[test]
fn what_does_not_load_is_reported__feat__plugin_web_resources() {
    on_fresh_thread(|| {
        let it = items(
            "<img src=\"missing.png\" style=\"width:10px;height:10px\">\
             <img src=\"https://example.com/remote.png\" style=\"width:10px;height:10px\">",
        );
        assert!(!kinds(&it).contains(&"image".to_string()));
        assert_eq!(
            take_resource_misses(),
            vec![
                "missing.png".to_string(),
                "https://example.com/remote.png".to_string()
            ]
        );
    });
}
