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

Ordered by what a reader of the canvas sees first. Numbers are at width 240 unless noted.

| Id | Defect | Fixtures | Measured |
|---|---|---|---|
| CW-01 | Text recovery copies a parley Run's whole text onto every glyph run the Run is split into by a style change (decoration, `<code>`, `<small>`), so the canvas paints the same words over each other. | inline-bold-italic | 8 extra words at 240, 18 at 400 ("underline" 3x, "strike code" 4x) |
| CW-02 | An outside list marker's glyph run takes the text of the next item; that item's text is painted at the marker position, one line up. Any list whose items wrap. | lists, lists-long | 4 of 9 runs (lists), 7 of 16 runs (lists-long) off their line |
| CW-03 | Text in an anonymous block box (inline text beside a block child, e.g. `<li>text<ul>…`) is never recovered: missing on the canvas. | lists-nested | 2 words missing |
| CW-04 | `line-height: normal` is 1.2 em; Chrome uses the font's rounded ascent + descent (+ line gap). | inline-line-height-normal | 19.2 vs 20 px per line at 16 px; 6.4 px drift after 8 lines |
| CW-05 | `font-optical-sizing: auto` is ignored: the variable `opsz` axis stays at 14, Chrome sets it to the font size. | text-optical-sizing | text ≈1 % wider at 16 px; 8 lines vs 7 at 240 |
| CW-06 | Max-content (shrink-to-fit) widths are rounded up to whole px. | flex-row, positioned | flex item 40.00 vs 39.02 px; abs box 94.00 vs 93.05 px |
| CW-07 | Column flexbox: an item's `margin-top: auto` does not absorb free space before `justify-content: flex-end`; items shift by the free space and overflow. | flex-column | items 80 px lower (100 px at 400) |
| CW-08 | Line boxes do not shorten beside floats: text runs under the float. | floats | 7 lines vs 9; wrapper 224 vs 180 px tall |
| CW-09 | Consecutive left floats stack vertically instead of side by side. | floats-stack | container 112 vs 48 px tall |
| CW-10 | `vertical-align: sub/super` do not grow the line box. | inline-bold-italic | paragraph 40.00 vs 47.17 px |
| CW-11 | A no-break space (U+00A0) is a break opportunity. | inline-hard-breaks | 3 lines vs 2 |
| CW-12 | Multi-column layout (`column-count`) is not implemented: one full-width column. | multicol | 7 lines vs 14 |
| CW-13 | Percentage padding and margins resolve against the box's own width instead of the containing block's. | sizing-percent | padding 10.8 vs 12 px; child offset 64.8 vs 60 px |
| CW-14 | `border-spacing` is not applied at the table's outer edges. | table-basic | cells at x 0 vs 2; table 114 vs 118 px tall |
| CW-15 | `border-collapse: collapse` is not implemented: adjacent borders double. | table-collapse | table 116 vs 104 px tall |
| FW-01 | The flow reports overset although all content fits the chain. | flow-forced-break, flow-headings-margins, flow-orphans-widows, flow-split-paragraph | 4 of 7 flows |
| FW-02 | Fragmenting a list repeats and drops items across frames (CW-02 in the flow). | flow-list | 64/61/48 words vs 36/36/36 |
| FW-03 | The last frame keeps a table row that does not fit its height. | flow-table-rows | 6 rows vs 5 in a 150 px frame |

## Divergences (documented, not defects)

| Fixture / aspect | Why |
|---|---|
| positioned-zindex / boxes, lines | `getBoundingClientRect` and Range rects include a CSS `transform`; Blitz's layout box is pre-transform. The pre-transform boxes agree (offset is exactly the translate). |
| lists-nested / lines | An inside `::marker` is inline text in Blitz (the line starts at the marker) and invisible to Range in Chrome (the line starts at the first character). Breaks agree after removing the marker. |

## What agrees

Block layout with margin collapsing through parents and empty blocks, the box model and
`box-sizing`, line breaking of plain, bold and italic text (weights via the `wght` axis), `white-space`
modes, hard breaks and soft hyphens, mixed font sizes and explicit line heights, `text-align`
left/center/right/justify, `letter-spacing`/`word-spacing`/`text-indent`/`text-transform`,
`overflow-wrap`/`word-break`, flex rows with grow/wrap/gap, grid templates, areas and spans,
absolute and relative positioning, `::before`/`::after`, borders and radii, user-agent heading and
blockquote defaults, inline-block. In the flow lane, Chrome and Blitz break paragraphs, split
paragraphs mid-text, honour default orphans/widows, truncate heading margins at a break and honour a
forced break on the same word in every case except lists and the last table row.

## Not covered yet

- Pixels: the PNGs are recorded, but no rasteriser for the captured display list exists in this
  repo (the host paints), so there is no pixel diff yet; `paint` checks text placement only.
- Images, web fonts other than the bundled face, `background-image`, `object-fit` (Blitz loads no
  resources in the plugin today).
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
chains hold, except lists (FW-02).

## Measured tables

<!-- GENERATED:BEGIN (chrome/parity-table.mjs) -->

### Summary by family

| Family | Fixtures | boxes | breaks | lines | paint |
|---|---:|---|---|---|---|
| blocks | 3 | 3 agree | 3 agree | 3 agree | 3 agree |
| flex | 3 | 1 agree, 2 defect | 3 agree | 1 agree, 2 defect | 3 agree |
| floats | 2 | 2 defect | 1 agree, 1 defect | 2 defect | 2 agree |
| grid | 2 | 2 agree | 2 agree | 2 agree | 2 agree |
| headings | 1 | 1 agree | 1 agree | 1 agree | 1 agree |
| inline | 6 | 3 agree, 3 defect | 5 agree, 1 defect | 4 agree, 2 defect | 5 agree, 1 defect |
| lists | 3 | 3 agree | 3 agree | 2 agree, 1 diverges | 3 defect |
| multicol | 1 | 1 defect | 1 defect | 1 agree | 1 agree |
| paint | 1 | 1 agree | 1 agree | 1 agree | 1 agree |
| positioned | 2 | 1 defect, 1 diverges | 2 agree | 1 defect, 1 diverges | 2 agree |
| pseudo | 1 | 1 agree | 1 agree | 1 agree | 1 agree |
| sizing | 1 | 1 defect | 1 agree | 1 defect | 1 agree |
| table | 2 | 2 defect | 2 agree | 2 defect | 2 agree |
| text | 5 | 4 agree, 1 defect | 4 agree, 1 defect | 4 agree, 1 defect | 5 agree |

33 fixtures x 2 widths, 132 aspect verdicts: **97 agree, 32 defect, 3 diverges, 0 fail**. 16 fixtures agree on every aspect.

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
| floats | **defect CW-08** | **defect CW-08** | **defect CW-08** | agree | 1/5 (180) / 1/5 (340) | 10/8 / 6/5 | 0/1 (44) / 0/1 (64) |
| floats-stack | **defect CW-09** | agree | **defect CW-09** | agree | 1/7 (162) / 1/7 (216) | 2/2 / 2/2 | 0/2 (64) / 0/2 (88) |
| grid-areas | agree | agree | agree | agree | 9/9 (0) / 9/9 (0.39) | 8/8 / 7/7 | 8/8 (0.01) / 7/7 (0.4) |
| grid-template | agree | agree | agree | agree | 7/7 (0.01) / 7/7 (0.01) | 7/7 / 6/6 | 7/7 (0.01) / 6/6 (0.01) |
| headings | agree | agree | agree | agree | 7/7 (0.03) / 7/7 (0.03) | 9/9 / 7/7 | 9/9 (0.06) / 7/7 (0.06) |
| inline-bold-italic | **defect CW-10** | agree | **defect CW-10** | **defect CW-01** | 1/3 (7.17) / 1/3 (7.17) | 14/14 / 10/10 | 5/14 (7.17) / 3/10 (7.17) |
| inline-font-sizes | agree | agree | agree | agree | 5/5 (0.02) / 5/5 (0.01) | 23/23 / 14/14 | 23/23 (0.41) / 14/14 (0.41) |
| inline-hard-breaks | **defect CW-11** | **defect CW-11** | agree | agree | 1/2 (20) / 2/2 (0) | 5/6 / 5/5 | 3/3 (0.01) / 5/5 (0.01) |
| inline-line-breaking | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 20/20 / 12/12 | 20/20 (0.01) / 12/12 (0.01) |
| inline-line-height-normal | **defect CW-04** | agree | **defect CW-04** | agree | 0/3 (9.4) / 0/3 (5.8) | 15/15 / 9/9 | 0/15 (10.4) / 0/9 (6.8) |
| inline-white-space | agree | agree | agree | agree | 4/4 (0) / 4/4 (0) | 9/9 / 7/7 | 9/9 (0.01) / 7/7 (0.01) |
| lists | agree | agree | agree | **defect CW-02** | 7/7 (0) / 7/7 (0) | 13/13 / 9/9 | 13/13 (0.01) / 9/9 (0.01) |
| lists-long | agree | agree | agree | **defect CW-02** | 9/9 (0) / 9/9 (0) | 16/16 / 8/8 | 16/16 (0.01) / 8/8 (0.01) |
| lists-nested | agree | agree | diverges | **defect CW-03** | 11/11 (0) / 11/11 (0) | 7/7 / 7/7 | 5/7 (22) / 5/7 (22) |
| multicol | **defect CW-12** | **defect CW-12** | agree | agree | 0/3 (160) / 0/3 (208) | 29/14 / 17/8 | 0/0 (0) / 0/0 (0) |
| paint-borders-radius | agree | agree | agree | agree | 5/5 (0) / 5/5 (0) | 4/4 / 4/4 | 4/4 (0.01) / 4/4 (0.01) |
| positioned | **defect CW-06** | agree | **defect CW-06** | agree | 5/6 (0.95) / 5/6 (0.95) | 4/4 / 4/4 | 3/4 (0.95) / 3/4 (0.95) |
| positioned-zindex | diverges | agree | diverges | agree | 3/4 (10) / 3/4 (10) | 2/2 / 1/1 | 0/2 (10.01) / 0/1 (10.01) |
| pseudo | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 11/11 / 7/7 | 11/11 (0.01) / 7/7 (0.01) |
| sizing-percent | **defect CW-13** | agree | **defect CW-13** | agree | 0/5 (4.8) / 0/5 (8) | 5/5 / 3/3 | 0/5 (4.4) / 0/3 (6) |
| table-basic | **defect CW-14** | agree | **defect CW-14** | agree | 0/7 (4) / 0/7 (4) | 7/7 / 6/6 | 0/7 (12) / 0/6 (2.01) |
| table-collapse | **defect CW-15** | agree | **defect CW-15** | agree | 0/8 (12) / 0/8 (37.55) | 8/8 / 7/7 | 1/8 (8) / 1/7 (20.81) |
| text-align | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 21/21 / 12/12 | 21/21 (0.01) / 12/12 (0.01) |
| text-justify | agree | agree | agree | agree | 2/2 (0) / 2/2 (0) | 16/16 / 10/10 | 16/16 (0.01) / 10/10 (0.01) |
| text-optical-sizing | **defect CW-05** | **defect CW-05** | **defect CW-05** | agree | 0/3 (20) / 0/3 (20) | 16/17 / 10/11 | 0/7 (20) / 0/6 (22.2) |
| text-overflow-wrap | agree | agree | agree | agree | 3/3 (0) / 3/3 (0) | 8/8 / 6/6 | 8/8 (0.29) / 6/6 (0.01) |
| text-spacing | agree | agree | agree | agree | 4/4 (0) / 4/4 (0) | 34/34 / 20/20 | 34/34 (0.01) / 20/20 (0.01) |

### Fragmentation (flow) fixtures

Words per frame, Chrome vs Blitz (`+` = overset).

| Fixture | breaks | overset | conserve | Chrome words | Blitz words |
|---|---|---|---|---|---|
| flow-forced-break | agree | **defect FW-01** | agree | 36/29/0 | 36/29/0 + |
| flow-headings-margins | agree | **defect FW-01** | agree | 23/33/28 | 23/33/28 + |
| flow-list | **defect FW-02** | agree | **defect FW-02** | 36/36/36 + | 64/61/48 + |
| flow-orphans-widows | agree | **defect FW-01** | agree | 37/38/9 | 37/38/9 + |
| flow-paragraphs | agree | agree | agree | 36/36/36 + | 36/36/36 + |
| flow-split-paragraph | agree | **defect FW-01** | agree | 34/38/15 | 34/38/15 + |
| flow-table-rows | **defect FW-03** | agree | agree | 20/20/20 + | 20/20/24 + |

<!-- GENERATED:END -->
