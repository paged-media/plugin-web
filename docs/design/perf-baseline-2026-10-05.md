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

Pinned in `perf_budgets.rs` as `#[should_panic]` defect tests (they start failing when fixed):

1. **Colour-only spans repeat their line's text.** Spans that differ only in colour share one
   shaping run, and text recovery slices each glyph run by the shaping run's range — so every
   colour run carries the whole line (the 200-span paragraph paints 3 257 words for 200). On the
   canvas the line's text is drawn once per colour run, overlapping.
2. **A flow reports overset for content that fits.** The last frame's content bottom includes the
   viewport-sized transparent root fill, so `overset` is true whenever the last frame is shorter
   than the 4 096 px paint viewport.

## Wave 2 targets, ranked by measured cost

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
   precision). Not in the Wave 2 list; recorded so it can be weighed against the above.
7. **Parse once per flow, not per flow group** — 1 parse per group (the single-flow workloads here
   show 1); matters for multi-flow sources only.

## After Wave 2 (host)

Same workloads, same real headless host and engine wasm (`perf-budgets.spec.ts`; the headless
host now boots the published `@paged-media/canvas-wasm` 0.67.0, pinned as a devDependency —
before, it resolved whatever copy sat in a parent `node_modules`). Each pin was lowered in the
commit that earned it, beside a behaviour assertion.

| Command | door calls | `mutate` | `collection` | stories reads / rows | other | wall-clock |
|---|---:|---:|---:|---:|---|---:|
| render one frame | 8 → **6** | 0 | 0 | 0 / 0 | no `parts.read` | 62 → 81 ms |
| render one flow into 12 frames | 11 → **7** | 0 | 0 | 0 / 0 | no `parts.read` (9 before ADR 409) | 37 → 35 ms |
| bake a frame of 200 text runs | 1 410 → **207** | 801 → **1** (batch of 1 001 ops) | 400 → **1** (`swatches`) | 400 / 40 000 → **0 / 0** | 200 `measureString` | 891 → 120 ms |
| 1 000 document changes, font watch live | 1 003 → **3** | 0 | 1 001 → **2** (`fonts`) | — | panel updates 1 001 → 1 | (the edits dominate) |
| cold boot | — | — | — | — | 1 instantiation, 1 loader import | — |

What changed:

- **Bake as one batch** (`bakeBatchOps` in `bake-plan.ts`, pure). Every run is measured first;
  then one `batch`: new swatches, then per frame each rectangle, path and text run, each creating
  op followed by `bindCreated` and later ops addressing `$h:<handle>` — a text frame's handle in a
  `storyId` / `story_id` position resolves to the story it minted. Created items are counted from
  the outcome's `minted`. One bake = one undo step (asserted: one undo removes all 200 stories,
  redo restores them); a flow bake is one batch across its frames. The swatches collection is
  read once so an existing `Color/wb-…` swatch is not created again — the engine refuses a
  duplicate self-id, and in one batch that would roll back the whole bake. The bake's cost is now
  linear: one measurement per run plus a constant.
- **Font watch per burst** (`font-watch.ts`). `DocumentChangeEvent` carries no hint of which
  edits touch fonts, so the watch cannot filter by kind: a burst of changes collapses into one
  trailing read 250 ms after the last change, and the panel is told only when the sorted family
  list differs. The budget runs with a quiet time no edit loop reaches plus `flush()`, so the count
  does not depend on machine speed.
- **No legacy-part read for new labels** (`source-part.ts`). The writer marks every envelope
  `legacyPart: false` (web-model `NO_LEGACY_PART`); the reader skips `<id>/source.json` for a
  marked label. This also fixed a stale read: a small source saved onto a frame that carried a
  large legacy part read back the legacy part.
- **Multi-flow geometry in one read**, and the template pass memoized per source content
  (`engine-document.ts`) — only for sources with `vars`: without them the composition is a
  passthrough cheaper than hashing the source (0.002 ms against 0.04 ms for the 40-paragraph
  article); with them the pass costs ~7 ms for 45 KB against ~0.1 ms for the key.

Recorded, not built (the engine half):

- **One parse per multi-flow source.** `render_web_flow` takes one flow root per call, so a source
  with N named flows is parsed and resolved N times. Needs an engine entry point that lays out
  every group from one parse.
- **One source load per command.** The bake and flow commands load the source twice (the chain
  resolve and the render each call `loadWebSource`: 2 `getMetadata`). Small, host-side, left for
  the Wave 4 command rework that touches the same paths.
- **Font faces on baked text.** `characterFontFamily` / `characterFontStyle` per run fit the same
  batch (the core contract test carries them) once runs carry faces (Wave 5).
