# paged.web performance baseline — 2026-10-05

The first measurement of paged.web's work, taken before any optimisation. Every gated number
is a **count** (the same on every machine); wall-clock is recorded for information only and is
never gated. Each budget is pinned at the value measured here, beside a behaviour assertion,
and is lowered only in the commit that earns it.

## How it is measured

| Lane | Where | What it counts | Run |
|---|---|---|---|
| Engine counters | `packages/web-render/src/perf.rs` (feature `perf-counters`) | HTML parses, style/layout resolves, paint captures, painted draw commands, run-match comparisons in text recovery, font-context builds, bytes in/out across the wasm boundary | thread-local; zero cost with the feature off (every `bump` is an empty inline fn) |
| Engine budgets | `packages/web-render/tests/perf_budgets.rs` | the counters above per workload | `cargo test --features blitz,perf-counters --test perf_budgets` |
| Engine benches | `packages/web-render/benches/render.rs` | wall-clock, trended | `cargo bench --features blitz --bench render` |
| Host budgets | `packages/web-bundle/test/perf/perf-budgets.spec.ts` | every host door call per command (a Proxy over the real headless host), wasm calls, boundary bytes, rows read back from `collection` | `pnpm --filter @paged-media/web test` (`PERF_SHOW=1` prints one `PERF` line per scenario) |
| Counting wasm | `scripts/build-wasm-perf.sh` → `packages/web-render/target/perf-wasm/` | adds `perf_counters()` / `perf_counters_reset()` exports; when present the host spec also prints the engine counters | never shipped; the bundled `bin/` artifact stays the non-counting build |

The workloads are built in code (no corpus files): a 40-paragraph article (each paragraph
~5 lines at 400 px), a 300-row three-column table, one paragraph of 200 colour-styled spans,
and a 200-cell flex grid (one text run per cell) for the bake.

## Engine (native, `perf_budgets.rs`)

| Workload | parses | resolves | paint captures | painted cmds | run-match comparisons | font ctx | bytes in | bytes out | wall-clock (release) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| article, 1 frame (400 × 8192 px) | 1 | 1 | 1 | 243 | 40 000 | 1 | 8 894 | 58 784 | 4.1 ms |
| article flowed into 4 frames (400 × 1500 px) | 1 | 4 | 4 | 514 | 60 896 | 1 | 9 023 | 64 594 | 9.1 ms |
| article flowed into 12 frames (400 × 500 px) | 1 | 12 | 12 | 1 360 | 150 365 | 1 | 9 267 | 78 153 | 27.7 ms |
| 300-row table, 1 frame | 1 | 1 | 1 | 2 121 | 815 409 | 1 | 15 942 | 814 706 | 23.1 ms |
| 200 styled runs, 1 frame | 1 | 1 | 1 | 403 | 159 201 | 1 | 7 722 | 71 303 | 2.1 ms |

Shapes the numbers show (asserted in `baseline_shapes_are_per_frame_and_quadratic`):

- **A flow costs one full resolve and one full paint per frame**, and each paint covers the whole
  remainder: painted commands ≈ C × (F + 1) / 2 for C commands and F frames (243 → 514 → 1 360).
  12 frames cost 6.7× the wall-clock of one frame for the same content.
- **Run matching is R²**: every captured run is compared with every recovered run, including runs
  recovered from inline layouts that are not painted (article: 200 line runs → exactly 40 000
  comparisons; a 960 px frame that paints 40 of those lines still compares them against all 200:
  8 000; table: ~900 runs → 815 409).
- **One font context per render call** — nothing is cached across calls.
- **The JSON wire dominates output**: the 300-row table returns 815 KB for 16 KB of HTML (51×).

## Host (bundle, `perf-budgets.spec.ts`, real headless host + real engine wasm)

| Command | door calls | document reads | `mutate` | `collection` | rows read back | wasm calls | bytes in / out | wall-clock |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| render one frame (40-paragraph article, 400 × 960 px) | 8 | 2 | 0 | 0 | 0 | 1 | 8 936 / 12 788 | 62 ms |
| render one flow into 12 frames | 9 | 1 | 0 | 0 | 0 | 1 | 9 309 / 78 153 | 37 ms |
| bake a frame of 200 text runs | **1 410** | 403 | **801** | **400** (all `stories`) | **40 000** story rows | 1 | 3 628 / 152 754 | 891 ms |
| 1 000 document changes, panel font watch live | 1 003 | 1 002 | 0 | **1 001** (all `fonts`) | 0 | 0 | — | 1 416 ms (incl. the 1 000 edits) |
| cold boot (all of the above) | — | — | — | — | — | 1 instantiation, 1 loader import | — | 10 ms |

The headless host wires no scene channel (`rendering.sceneLayer@1` is false), so the render
commands stop before `contribute.sceneLayer().submit`: in the editor the frame render adds one
door call and the flow render twelve. The behaviour assertions read the layer at the wasm
boundary instead (the article's first marker is on the frame; the flow conserves every word
exactly once across the twelve frames; the bake mints exactly one story per run).

Per baked text run the bake spends 7 awaited door calls: two full `stories` reads (to find the
new story by diffing), `text.measureString`, `insertTextFrame`, `insertText` and two
`setElementProperty`. The story reads grow with the document, so rows read back are
quadratic in runs (200 runs → 40 000 rows), and the 801 mutations are 801 undo steps.

## Defects the workloads exposed

Pinned in `perf_budgets.rs` as `#[should_panic]` defect tests (they start failing when fixed).
Both are fixed; see "After the engine optimisations".

1. **Colour-only spans repeat their line's text.** Spans that differ only in colour share one
   shaping run, and text recovery slices each glyph run by the shaping run's range — so every
   colour run carries the whole line (the 200-span paragraph paints 3 257 words for 200). On the
   canvas the line's text is drawn once per colour run, overlapping.
2. **A flow reports overset for content that fits.** The last frame's content bottom includes the
   viewport-sized transparent root fill, so `overset` is true whenever the last frame is shorter
   than the 4 096 px paint viewport.

## Targets, ranked by measured cost

1. **Bake as one batch** — 1 410 door calls, 801 mutations (801 undo steps), 400 full story reads
   and 40 000 rows for 200 runs; 891 ms. Story ids from the `insertTextFrame` result instead of
   collection diffing, all runs and shapes in one `mutate`. Target: a handful of calls, one undo
   step, 0 story reads.
2. **Font watch only on font-changing events** — 1 001 `fonts` reads per 1 000 edits. Target: 1
   (+1 per real font change).
3. **Run matching by index** — R² comparisons (815 409 for the table, 150 365 for the 12-frame
   flow). Target: ~R.
4. **Incremental flow fragmentation** — 12 resolves, 12 full-remainder paints, 1 360 painted
   commands for 243 commands of content; 6.7× the one-frame wall-clock. Target: painted
   commands ≈ one pass, paint only each frame's band.
5. **Font context once per engine** — 1 build per render call. Target: 1 per engine lifetime.
6. **Wire size** — 815 KB of JSON for a 300-row table (borders as path segments, full float
   precision). Not in the original list; recorded so it can be weighed against the above.
7. **Parse once per flow, not per flow group** — 1 parse per group (the single-flow workloads here
   show 1); matters for multi-flow sources only.

## After the engine optimisations

Same workloads, same counters, measured on a warm engine (the font context is built before the
counters are reset). Every lowered count is the new pin in `perf_budgets.rs`, lowered in the
commit that earned it.

| Workload | parses | resolves | paint captures | painted cmds | run-match comparisons | font ctx | bytes in | bytes out | wall-clock (release) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| article, 1 frame (400 × 8192 px) | 1 | 1 | 1 | 243 → **200** | 40 000 → **200** | 1 → **0** | 8 894 | 58 784 → **31 634** | 4.1 → 3.1 ms |
| article flowed into 4 frames (400 × 1500 px) | 1 | 4 | 4 | 514 → **217** | 60 896 → **217** | 1 → **0** | 9 023 | 64 594 → **31 646** | 9.1 → 6.2 ms |
| article flowed into 12 frames (400 × 500 px) | 1 | 12 | 12 | 1 360 → **250** | 150 365 → **250** | 1 → **0** | 9 267 | 78 153 → **31 873** | 27.7 → 14.8 ms |
| 300-row table, 1 frame | 1 | 1 | 1 | 2 121 → **1 214** | 815 409 → **903** | 1 → **0** | 15 942 | 814 706 → **190 761** | 23.1 → 17.1 ms |
| 200 styled runs, 1 frame | 1 | 1 | 1 | 403 → **399** | 159 201 → **200** | 1 → **0** | 7 722 | 71 303 → **26 515** | 2.1 → 2.3 ms |

Host side (`perf-budgets.spec.ts`), engine bytes out: render one frame 12 788 → **6 302**,
render one flow into 12 frames 78 153 → **31 873**; the bake's one engine call 152 754 → 24 023
(not budgeted). Wall-clock is one `cargo bench` run on one machine, for information only.

What changed, each in its own commit with its budget:

- **Font context once per engine.** Built on first use per thread (the wasm engine is
  single-threaded) and cloned into each document; `font_context_is_built_once_per_engine` pins
  cold = 1, warm = 0.
- **Run matching by index.** Recovered runs are bucketed in a 1 pt grid by untransformed
  absolute baseline and by local key; a captured run reads the 3 × 3 cells at its painted
  baseline and falls back to its local-key cells only for a transformed inline root. The
  absolute baseline now includes the inline root's border + padding inset (where paint draws
  the text); without it every table cell missed the fast path. Same matches as before.
- **A flow frame paints only its band.** Layout keeps the tall viewport; a non-last frame paints
  its height + 64 px (Blitz culls elements whose box starts below the paint height) and text
  recovery skips the culled inline roots. The last frame paints its whole remainder, which
  decides overset. The JSON of four differential flows (variable widths, a table with header
  repeat, upward box shadows, colour runs) is byte-identical before and after.
- **Wire size.** A fully transparent fill outside every layer (the canvas background when the
  page sets none) and zero-extent border subpaths (every border side is a filled subpath,
  zero-width ones included) are not recorded: neither paints anything. The wire contract is
  unchanged. Floats were not rounded: after the subpath drop the table's text items and real
  border fills are what remains, and their values are already short.

Defects, fixed:

1. **Colour-only spans** — each glyph run now recovers only its own clusters' text (the shaping
   run's glyphs consumed by earlier glyph runs are tracked). The 200-span paragraph paints 200
   words. Test `styled_runs_carry_only_their_own_text` (was the `should_panic` defect test) and
   the unit test `colour_only_spans_each_recover_only_their_own_text`.
2. **Overset for content that fits** — the transparent canvas fill is gone and the flow's content
   bottom skips an opaque canvas background. Test `flow_that_fits_is_not_overset` (was the
   defect test); the 4- and 12-frame budgets assert not overset;
   `a_flow_that_fits_its_last_frame_is_not_overset` covers transparent and opaque page
   backgrounds, variable and equal width.

Recorded, not built:

- **Resolves stay one per frame**, also when consecutive frames share a width. After the
  consumed prefix is deleted the remainder has to be laid out again: a continuation re-applies
  box tops, margins and text indents, which scrolling the first layout would not. Skipping it
  needs a different fragmentation model, not a cache.
- **Parse once per flow group** (target 7) is host-side (the bundle calls the engine per group).

