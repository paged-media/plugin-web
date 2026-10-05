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

//! Print the text runs `render_web_flow` puts in each frame — the engine side
//! of a Chrome flow recording, for debugging a disagreement:
//!
//!   cargo run --features blitz --example dump_flow -- <file.html> WxH[,WxH…]

use web_render::display_list::WebDrawCmd;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: dump_flow <file.html> WxH[,WxH...]");
        std::process::exit(2);
    }
    let html = std::fs::read_to_string(&args[1]).expect("read html");
    let frames: Vec<(u32, u32)> = args[2]
        .split(',')
        .map(|f| {
            let (w, h) = f.split_once('x').expect("WxH");
            (w.parse().expect("w"), h.parse().expect("h"))
        })
        .collect();
    let flow = web_render::flow::render_web_flow_variable(&html, &frames);
    for (i, dl) in flow.frames.iter().enumerate() {
        println!("--- frame {i}");
        for c in &dl.commands {
            if let WebDrawCmd::GlyphRun(r) = c {
                println!(
                    "  y={:7.2} x={:7.2} {:?}",
                    r.baseline_y, r.baseline_x, r.text
                );
            }
        }
    }
    println!("overset: {}", flow.overset);
}
