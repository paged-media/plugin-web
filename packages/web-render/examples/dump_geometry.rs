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

//! Print Blitz's layout geometry for one HTML file as JSON — the engine side
//! of a Chrome conformance recording, for debugging a disagreement:
//!
//!   cargo run --features blitz --example dump_geometry -- <file.html> <width> [height]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: dump_geometry <file.html> <width> [height]");
        std::process::exit(2);
    }
    let html = std::fs::read_to_string(&args[1]).expect("read html");
    let width: u32 = args[2].parse().expect("width");
    let height: u32 = args
        .get(3)
        .map(|h| h.parse().expect("height"))
        .unwrap_or(1000);
    let g = web_render::geometry::layout_geometry(&html, width, height);
    println!("{}", serde_json::to_string_pretty(&g).unwrap());
}
