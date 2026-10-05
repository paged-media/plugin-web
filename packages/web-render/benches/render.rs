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

//! Wall-clock trend for the perf workloads — TRENDED, NOT GATED (the gate is
//! the count budgets in `tests/perf_budgets.rs`). Same workloads, through the
//! same entries the wasm exports call.
//!
//! `cargo bench --features blitz --bench render`

use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

#[path = "../tests/common/workloads.rs"]
mod workloads;

use web_render::{render_web_flow_boundary_json, render_web_frame_json};
use workloads::*;

fn benches(c: &mut Criterion) {
    let mut g = c.benchmark_group("web-render");
    g.sample_size(10);

    let art = article(40);
    g.bench_function("article-40/1-frame", |b| {
        b.iter(|| render_web_frame_json(black_box(&art), FRAME_W, 8192))
    });
    for n in [4usize, 12] {
        let fj = frames_json(&frames(n, 6000 / n as u32));
        g.bench_function(format!("article-40/flow-{n}"), |b| {
            b.iter(|| render_web_flow_boundary_json(black_box(&art), &fj, ""))
        });
    }

    let tbl = table(300);
    g.bench_function("table-300/1-frame", |b| {
        b.iter(|| render_web_frame_json(black_box(&tbl), FRAME_W, 8192))
    });

    let runs = styled_runs(200);
    g.bench_function("styled-runs-200/1-frame", |b| {
        b.iter(|| render_web_frame_json(black_box(&runs), FRAME_W, TALL_H))
    });

    g.finish();
}

criterion_group!(render, benches);
criterion_main!(render);
