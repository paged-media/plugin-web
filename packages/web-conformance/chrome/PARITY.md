# Chrome parity

How Blitz (the layout engine inside paged.web, `packages/web-render`) lays out HTML compared with
Chrome, measured on hand-written fixtures. Recorded with headless Chromium 153 (Playwright 1.63) on
2026-10-05; replayed in CI by `packages/web-render/tests/chrome_parity.rs` and `flow_parity.rs`
without a browser.

## Method

- **Same input, same font.** Every fixture is one HTML file under `fixtures/` (layout) or
  `flow-fixtures/` (fragmentation). The recorder injects the engine's own font file
  (`packages/web-render/assets/fonts/Inter.ttf`, the variable Inter face with `wght` 100–900 and
  `opsz` 14–32) as an `@font-face` with `font-weight: 100 900`, so both engines shape with identical
  glyph data and bold uses the `wght` axis in both. Fixtures render at frame widths 240 and 400 CSS
  px in a 1000 px tall viewport.
- **Controlled defaults.** The layout fixtures set `line-height: 1.25` and
  `font-optical-sizing: none` on `html`. Both defaults differ between the engines (CW-04, CW-05);
  each has its own fixture that pins the difference, and every other fixture is measured without it.
- **What is compared** (each over both widths):
  - `boxes`: border box of every non-inline `[data-id]` element (`getBoundingClientRect` against
    Taffy's unrounded layout), ±0.5 px on x, y, width and height. Table rows and row groups are
    skipped: Blitz lays tables out as a grid and gives rows no box.
  - `breaks`: per text-bearing block, the same lines with the same words (whitespace collapsed,
    case folded, soft hyphens removed). Generated `::before`/`::after` text is folded into Chrome's
    lines because Range client rects cannot see it.
  - `lines`: for blocks whose breaks agree, each line's glyph box (top, bottom, left and right of
    its non-blank characters), ±0.5 px. Chrome reports a glyph box with ascent and descent rounded
    to whole px; the Blitz side rounds the same way, so the delta measures baseline and advances.
  - `paint`: the words the paint capture attaches to its glyph runs (what reaches the canvas) equal
    Chrome's words as a multiset, and every run sits on a line of Blitz's own layout that carries
    its text.
  - Flow fixtures: Chrome pours the content through a multi-column box whose columns are the frames
    (equal frame sizes only, since Chrome has no CSS Regions); every character goes to the column
    its glyph box lands in. `breaks`: every frame holds the same words; `overset`: same overset
    status; `conserve`: Blitz's frames lose and duplicate nothing compared with the same flow in one
    tall frame.
- **Verdicts.** `agree` is asserted (a regression fails CI). `defect` is a pinned engine
  disagreement that must keep disagreeing: the day it starts agreeing the test fails and the
  `EXPECT` row goes. `diverges` is a documented difference that is measured but not asserted.
- **Re-recording** (local, needs Chromium): `pnpm --filter @paged-media/web-conformance record`
  and `record:flow`; then run the two Rust tests and `node chrome/parity-table.mjs` to refresh the
  tables below. `test/recordings.spec.ts` fails when a fixture changed after its recording.

## Defects (pinned)

Ordered by what a reader of the canvas sees first. Numbers are at width 240 unless noted. Every
open defect is in the pinned upstream layout stack (Blitz 0.3.0-alpha.4, Taffy
0.11.0-experimental-cache-fix.3, Parley 0.9; ADR 401 keeps the pin); the cause column names the
code. Drafted upstream reports, each with a minimal reproduction, are in
[`UPSTREAM.md`](UPSTREAM.md).

| Id | Defect | Fixtures | Measured | Cause (upstream) |
|---|---|---|---|---|
| CW-04 | `line-height: normal` is 1.2 em; Chrome uses the font's rounded ascent + descent (+ line gap). | inline-line-height-normal | 19.2 vs 20 px per line at 16 px; 6.4 px drift after 8 lines | blitz-dom `stylo_to_parley::style` maps `Normal` to `FontSizeRelative(1.2)` |
| CW-05 | `font-optical-sizing: auto` is ignored: the variable `opsz` axis stays at 14, Chrome sets it to the font size. | text-optical-sizing | text ≈1 % wider at 16 px; 8 lines vs 7 at 240 | blitz-dom passes only `font-variation-settings` to Parley |
| CW-06 | Max-content (shrink-to-fit) widths are rounded up to whole px. | flex-row, positioned | flex item 40.00 vs 39.02 px; abs box 94.00 vs 93.05 px | blitz-dom `layout/inline.rs` calls `ceil()` on the inline content width |
| CW-07 | Flexbox: main-axis `auto` margins take the free space, and `justify-content` then distributes the same free space again. | flex-column | items 80 px lower (100 px at 400) | taffy `distribute_remaining_free_space` does not zero the free space after the auto margins |
| CW-10 | `vertical-align: sub/super` do not grow the line box. | inline-bold-italic | paragraph 40.00 vs 47.17 px | no `vertical-align` in blitz-dom or Parley 0.9 |
| CW-11 | A no-break space (U+00A0) is a break opportunity. | inline-hard-breaks | 3 lines vs 2 | Parley `line_break.rs` hangs an overflowing cluster when `is_space_or_nbsp()` and breaks after it |
| CW-12 | Multi-column layout (`column-count`) is not implemented: one full-width column. | multicol | 7 lines vs 14 | no multi-column layout in blitz-dom |
| CW-13 | Percentage padding and children's percentage margins resolve against the box's own width instead of the containing block's. | sizing-percent | padding 10.8 vs 12 px; child offset 64.8 vs 60 px | taffy `compute/block.rs` resolves them against `container_outer_width` |
| CW-14 | `border-spacing` is not applied at the table's outer edges. | table-basic | cells at x 0 vs 2; table 114 vs 118 px tall | blitz-dom `layout/table.rs` maps `border-spacing` to grid gaps only |
| CW-15 | `border-collapse: collapse` is not implemented: cells keep their full borders and a border-wide gap is added; auto column widths differ. | table-collapse | table 116 vs 104 px tall; rows 36 vs 34 px | blitz-dom `layout/table.rs` (collapse approximated by gaps) |
| CW-16 | `position: sticky` is laid out as `relative`: the inset moves a box that is not stuck. | positioned-sticky | `top: 10px` box at y 58 vs 48 | stylo_taffy `convert.rs` maps `Sticky` to `Position::Relative` |
| CW-17 | `text-align-last` is ignored. | text-align-last | centred last line starts at x 0 vs 66.9 | not mapped by blitz-dom; no last-line alignment in Parley 0.9 |
| CW-18 | `hyphens: none` is ignored: a soft hyphen always breaks. | text-hyphens | 5 lines vs 4 (100 vs 80 px) | `hyphens` not read by blitz-dom; Parley breaks at U+00AD unconditionally |

### Fixed

| Id | Was | Fixed by |
|---|---|---|
| CW-01 | Every glyph run of a style-split line (colour, decoration, `<code>`, `<small>`) carried the shaping run's whole text: words painted over each other. | Text recovery slices each glyph run by its own clusters (unit test over every split kind). |
| CW-02 | An outside list marker's run took the next item's text, painted one line up. | Text recovery walks each item's outside-marker layout. |
| CW-03 | Text in an anonymous block box (`<li>text<ul>…`) was never painted. | Text recovery enters anonymous-block layout children. |
| CW-08 | Line boxes did not shorten beside floats. | Blitz's opt-in `floats` feature is enabled. |
| CW-09 | Consecutive left floats stacked vertically. | Same feature. |
| FW-01 | The flow reported overset although all content fit. | The canvas background no longer counts as content. |
| FW-02 | A fragmented list repeated and dropped items (CW-02 in the flow): 50/49/48 words vs 36/36/36. | CW-02's fix. |
| FW-03 | The last frame kept a table row that did not fit its height. | An overset last frame is cut like every other frame. |

## Divergences (documented, not defects)

| Fixture / aspect | Why |
|---|---|
| positioned-zindex / boxes, lines | `getBoundingClientRect` and Range rects include a CSS `transform`; Blitz's layout box is pre-transform. The pre-transform boxes agree (offset is exactly the translate). |
| lists-nested / lines | An inside `::marker` is inline text in Blitz (the line starts at the marker) and invisible to Range in Chrome (the line starts at the first character). Breaks agree after removing the marker. |

## What agrees

Block layout with margin collapsing through parents and empty blocks, the box model and
`box-sizing`, line breaking of plain, bold and italic text (weights via the `wght` axis), `white-space`
modes, hard breaks, soft hyphens with `hyphens: manual` and hard hyphens, mixed font sizes and
explicit line heights, `text-align` left/center/right/end/justify, `letter-spacing`/`word-spacing`/`text-indent`/`text-transform`,
`overflow-wrap`/`word-break`, every `text-decoration` line, style and colour, flex rows with grow/wrap/gap, grid templates, areas and spans,
floats (text wrapping beside them, side-by-side floats, clearance), lists with outside and inside markers,
absolute and relative positioning, `::before`/`::after`, borders and radii, user-agent heading and
blockquote defaults, inline-block, and the boxes of `object-fit` images and `background-image` boxes. In the flow lane every fixture agrees: Chrome and Blitz break paragraphs, split
paragraphs mid-text, honour default orphans/widows, truncate heading margins at a break, honour a
forced break on the same word, fragment lists, and move a table row that does not fit the last frame to the overset.

## Not covered yet

- Pixels: the PNGs are recorded, but no rasteriser for the captured display list exists in this
  repo (the host paints), so there is no pixel diff yet; `paint` checks text placement only.
- The pixels of images, `background-image` and `object-fit`: their fixtures compare boxes and
  text only. Web fonts other than the bundled face.
- Frames of different sizes in the flow lane (Chrome has no Regions; the multicol model needs
  equal columns).

## The other oracles

**InDesign** (`indesign/`). The real "Bake web frame to document" runs against a recording host
(`indesign/bake-lane.ts`, real engine wasm, Inter advance widths as the text measure); its wire
mutations become a core `paged script` (`indesign/scripts/<fixture>.js`, committed with the items
and swatches it should produce). `indesign/run.sh` (local: core's `paged` CLI and InDesign 2025)
applies the script to a blank 612 x 792 pt page, exports IDML with Inter staged in a
`Document fonts` folder, and asks InDesign (`indesign/probe.jsx`) for every page item, swatch and
font. `test/indesign-bake.spec.ts` checks in CI that the bake still produces the committed script
and that InDesign's committed answer agrees: item kinds, geometry ±0.5 pt, fills, text per frame
with nothing overset, point size, first baseline ±0.5 pt, RGB swatch values. Recorded with InDesign
20.0.1 on 2026-10-05 for 3 fixtures (card, swatches, shapes: 7 rectangles, 2 polygons from
`border-radius`, 4 text frames, 11 swatches): **every check agrees**; first baselines land exactly
on the runs' baselines. One defect is pinned against the source's intent:

| Id | Defect | Measured |
|---|---|---|
| IB-01 | The bake drops font weight and style: an `<h1>` (bold) arrives in InDesign as Inter Regular. | 1 of 4 runs |

**Property tests** (fast-check). `web-model/test/properties.spec.ts` found three sanitizer defects,
pinned with `it.fails`: S-01 an unterminated tag at the end of a paste keeps its surface
(`<script`, `<a href='javascript:`); S-02 a removal splices its neighbours into a new construct
(`<scr<script>ipt>alert(1)</scr<script>ipt>` becomes `<script>alert(1)`; `<a ON onclick="x"A=y>`
becomes `<a ONA=y>`); S-03 an empty `onerror=` is kept. The template pass, the envelope round-trip
and (`web-bundle/test/flow-properties.spec.ts`, real engine) text conservation across random frame
chains hold, lists included.

## Measured tables

<!-- GENERATED:BEGIN (chrome/parity-table.mjs) -->

### Summary by family

| Family | Fixtures | boxes | breaks | lines | paint |
|---|---:|---|---|---|---|
| blocks | 3 | 3 agree | 3 agree | 3 agree | 3 agree |
| flex | 3 | 1 agree, 2 defect | 3 agree | 1 agree, 2 defect | 3 agree |
| floats | 2 | 2 agree | 2 agree | 2 agree | 2 agree |
| grid | 2 | 2 agree | 2 agree | 2 agree | 2 agree |
| headings | 1 | 1 agree | 1 agree | 1 agree | 1 agree |
| inline | 6 | 3 agree, 3 defect | 5 agree, 1 defect | 4 agree, 2 defect | 6 agree |
| lists | 3 | 3 agree | 3 agree | 2 agree, 1 diverges | 3 agree |
| multicol | 1 | 1 defect | 1 defect | 1 agree | 1 agree |
| paint | 3 | 3 agree | 3 agree | 3 agree | 3 agree |
| positioned | 3 | 2 defect, 1 diverges | 3 agree | 2 defect, 1 diverges | 3 agree |
| pseudo | 1 | 1 agree | 1 agree | 1 agree | 1 agree |
| sizing | 1 | 1 defect | 1 agree | 1 defect | 1 agree |
| table | 2 | 2 defect | 2 agree | 2 defect | 2 agree |
| text | 8 | 6 agree, 2 defect | 6 agree, 2 defect | 5 agree, 3 defect | 7 agree, 1 defect |

39 fixtures x 2 widths, 156 aspect verdicts: **123 agree, 30 defect, 3 diverges, 0 fail**. 23 fixtures agree on every aspect.

### Per fixture

Numbers per width (`240 / 400`): boxes agreeing/checked and the largest box delta (px); lines Chrome/Blitz; line positions agreeing/checked and the largest delta (px).

| Fixture | boxes | breaks | lines | paint | boxes ok (max Δpx) | line count C/B | line pos ok (max Δpx) |
|---|---|---|---|---|---|---|---|
| blocks-box-model | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 8/8 / 6/6 | 8/8 (0.01) / 6/6 (0.01) |
| blocks-margin-collapse | agree | agree | agree | agree | 4/4 (0) / 4/4 (0) | 11/11 / 7/7 | 11/11 (0.01) / 7/7 (0.01) |
| blocks-parent-collapse | agree | agree | agree | agree | 6/6 (0) / 6/6 (0) | 5/5 / 4/4 | 5/5 (0.01) / 4/4 (0) |
| flex-column | **defect CW-07** | agree | **defect CW-07** | agree | 1/4 (80) / 1/4 (100) | 4/4 / 3/3 | 0/4 (80) / 0/3 (100) |
| flex-grow-wrap | agree | agree | agree | agree | 9/9 (0.01) / 9/9 (0.01) | 8/8 / 7/7 | 8/8 (0.01) / 7/7 (0.01) |
| flex-row | **defect CW-06** | agree | **defect CW-06** | agree | 4/8 (0.98) / 4/8 (1.36) | 8/8 / 6/6 | 3/8 (0.98) / 3/6 (1.36) |
| floats | agree | agree | agree | agree | 5/5 (0) / 5/5 (0) | 10/10 / 6/6 | 10/10 (0.01) / 6/6 (0.01) |
| floats-stack | agree | agree | agree | agree | 7/7 (0) / 7/7 (0) | 2/2 / 2/2 | 2/2 (0.01) / 2/2 (0.01) |
| grid-areas | agree | agree | agree | agree | 9/9 (0) / 9/9 (0.39) | 8/8 / 7/7 | 8/8 (0.01) / 7/7 (0.4) |
| grid-template | agree | agree | agree | agree | 7/7 (0.01) / 7/7 (0.01) | 7/7 / 6/6 | 7/7 (0.01) / 6/6 (0.01) |
| headings | agree | agree | agree | agree | 7/7 (0.03) / 7/7 (0.03) | 9/9 / 7/7 | 9/9 (0.06) / 7/7 (0.06) |
| inline-bold-italic | **defect CW-10** | agree | **defect CW-10** | agree | 1/3 (7.17) / 1/3 (7.17) | 14/14 / 10/10 | 5/14 (7.17) / 3/10 (7.17) |
| inline-font-sizes | agree | agree | agree | agree | 5/5 (0.02) / 5/5 (0.01) | 23/23 / 14/14 | 23/23 (0.41) / 14/14 (0.41) |
| inline-hard-breaks | **defect CW-11** | **defect CW-11** | agree | agree | 1/2 (20) / 2/2 (0) | 5/6 / 5/5 | 3/3 (0.01) / 5/5 (0.01) |
| inline-line-breaking | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 20/20 / 12/12 | 20/20 (0.01) / 12/12 (0.01) |
| inline-line-height-normal | **defect CW-04** | agree | **defect CW-04** | agree | 0/3 (9.4) / 0/3 (5.8) | 15/15 / 9/9 | 0/15 (10.4) / 0/9 (6.8) |
| inline-white-space | agree | agree | agree | agree | 4/4 (0) / 4/4 (0) | 9/9 / 7/7 | 9/9 (0.01) / 7/7 (0.01) |
| lists | agree | agree | agree | agree | 7/7 (0) / 7/7 (0) | 13/13 / 9/9 | 13/13 (0.01) / 9/9 (0.01) |
| lists-long | agree | agree | agree | agree | 9/9 (0) / 9/9 (0) | 16/16 / 8/8 | 16/16 (0.01) / 8/8 (0.01) |
| lists-nested | agree | agree | diverges | agree | 11/11 (0) / 11/11 (0) | 7/7 / 7/7 | 5/7 (22) / 5/7 (22) |
| multicol | **defect CW-12** | **defect CW-12** | agree | agree | 0/3 (160) / 0/3 (208) | 29/14 / 17/8 | 0/0 (0) / 0/0 (0) |
| paint-background-image | agree | agree | agree | agree | 5/5 (0) / 5/5 (0) | 5/5 / 5/5 | 5/5 (0.01) / 5/5 (0.01) |
| paint-borders-radius | agree | agree | agree | agree | 5/5 (0) / 5/5 (0) | 4/4 / 4/4 | 4/4 (0.01) / 4/4 (0.01) |
| paint-object-fit | agree | agree | agree | agree | 6/6 (0) / 6/6 (0) | 3/3 / 2/2 | 3/3 (0.01) / 2/2 (0.01) |
| positioned | **defect CW-06** | agree | **defect CW-06** | agree | 5/6 (0.95) / 5/6 (0.95) | 4/4 / 4/4 | 3/4 (0.95) / 3/4 (0.95) |
| positioned-sticky | **defect CW-16** | agree | **defect CW-16** | agree | 4/7 (12) / 4/7 (12) | 6/6 / 6/6 | 3/6 (12) / 3/6 (12) |
| positioned-zindex | diverges | agree | diverges | agree | 3/4 (10) / 3/4 (10) | 2/2 / 1/1 | 0/2 (10.01) / 0/1 (10.01) |
| pseudo | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 11/11 / 7/7 | 11/11 (0.01) / 7/7 (0.01) |
| sizing-percent | **defect CW-13** | agree | **defect CW-13** | agree | 0/5 (4.8) / 0/5 (8) | 5/5 / 3/3 | 0/5 (4.4) / 0/3 (6) |
| table-basic | **defect CW-14** | agree | **defect CW-14** | agree | 0/7 (4) / 0/7 (4) | 7/7 / 6/6 | 0/7 (12) / 0/6 (2.01) |
| table-collapse | **defect CW-15** | agree | **defect CW-15** | agree | 0/8 (12) / 0/8 (37.55) | 8/8 / 7/7 | 1/8 (8) / 1/7 (20.81) |
| text-align | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 21/21 / 12/12 | 21/21 (0.01) / 12/12 (0.01) |
| text-align-last | agree | agree | **defect CW-17** | agree | 4/4 (0.25) / 4/4 (0.5) | 15/15 / 9/9 | 13/15 (133.87) / 7/9 (19.86) |
| text-decoration | agree | agree | agree | agree | 4/4 (0) / 4/4 (0) | 12/12 / 7/7 | 12/12 (0.03) / 7/7 (0.02) |
| text-hyphens | **defect CW-18** | **defect CW-18** | **defect CW-18** | **defect CW-18** | 1/3 (20) / 1/3 (20) | 13/14 / 13/14 | 5/9 (20) / 5/9 (20) |
| text-justify | agree | agree | agree | agree | 2/2 (0) / 2/2 (0) | 16/16 / 10/10 | 16/16 (0.01) / 10/10 (0.01) |
| text-optical-sizing | **defect CW-05** | **defect CW-05** | **defect CW-05** | agree | 0/3 (20) / 0/3 (20) | 16/17 / 10/11 | 0/7 (20) / 0/6 (22.2) |
| text-overflow-wrap | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 8/8 / 6/6 | 8/8 (0.29) / 6/6 (0.01) |
| text-spacing | agree | agree | agree | agree | 4/4 (0) / 4/4 (0) | 34/34 / 20/20 | 34/34 (0.01) / 20/20 (0.01) |

### Fragmentation (flow) fixtures

Words per frame, Chrome vs Blitz (`+` = overset).

| Fixture | breaks | overset | conserve | Chrome words | Blitz words |
|---|---|---|---|---|---|
| flow-forced-break | agree | agree | agree | 36/29/0 | 36/29/0 |
| flow-headings-margins | agree | agree | agree | 23/33/28 | 23/33/28 |
| flow-list | agree | agree | agree | 36/36/36 + | 36/36/36 + |
| flow-orphans-widows | agree | agree | agree | 37/38/9 | 37/38/9 |
| flow-paragraphs | agree | agree | agree | 36/36/36 + | 36/36/36 + |
| flow-split-paragraph | agree | agree | agree | 34/38/15 | 34/38/15 |
| flow-table-rows | agree | agree | agree | 20/20/20 + | 20/20/20 + |

<!-- GENERATED:END -->
