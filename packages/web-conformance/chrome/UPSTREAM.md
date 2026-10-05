# Upstream reports (drafts)

Draft issue texts for the layout defects in [`PARITY.md`](PARITY.md) whose cause is in the pinned
layout stack: Blitz 0.3.0-alpha.4 (`blitz-dom`, `stylo_taffy`), Taffy
0.11.0-experimental-cache-fix.3 and Parley 0.9. They are not filed from here. Each reproduction
assumes a single-face font (the measurements use Inter at 16 px, `line-height: 1.25` unless noted)
and a viewport 240 px wide; "Chrome" is headless Chromium 153. Before filing, check the defect
against the current upstream release: a fix there is picked up by moving the pin, not by a
patch here.

## Taffy

### CW-07 Flexbox: free space is used twice when a main-axis margin is `auto`

`distribute_remaining_free_space` (`compute/flexbox.rs`) gives the positive free space to the
`auto` margins, then computes `justify-content` offsets from the same, unreduced `free_space`.
Per CSS Flexbox 9.5 the auto margins absorb the free space, so `justify-content` has nothing left.

```html
<div style="display:flex; flex-direction:column; height:200px; justify-content:flex-end">
  <div style="height:28px">a</div>
  <div style="height:28px">b</div>
  <div style="height:28px; margin-top:auto">c</div>
</div>
```

Expected (Chrome): `a` at y 0, `c` at the bottom. Actual: `a` at y 80 (the free space), the items
overflow the container by 80 px. The code path is the same for rows.

### CW-13 Block layout: percentage padding and child margins use the box's own width

In `compute/block.rs` the container's padding and border are resolved again against
`container_outer_width` (the box's own border-box width) for the final layout, and its children's
percentage margins resolve against that width too. CSS resolves both against the containing
block's width (the parent's content box for the children).

```html
<div style="width:80%; padding:5%">
  <div style="width:50%; height:40px; margin-left:25%"></div>
</div>
```

At 240 px: expected padding 12 px (5 % of 240) and the child at x 60 (12 + 25 % of 192).
Actual: padding 10.8 px (5 % of 216) and the child at x 64.8 (10.8 + 25 % of 216).

## Parley

### CW-11 A no-break space that overflows the line becomes a break

In `layout/line_break.rs`, when a cluster does not fit, the "hang overflowing whitespace and
break" branch tests `whitespace.is_space_or_nbsp()`. U+00A0 is not a break opportunity
(UAX #14 class GL); only a breakable space should hang.

```html
<p style="width:240px">Soft and non&nbsp;breaking&nbsp;space&nbsp;joined&nbsp;words&nbsp;here.</p>
```

Expected (Chrome): 2 lines, "non breaking space joined words here." kept together. Actual: 3
lines, broken after "words".

### CW-18 `hyphens: none` (no hyphenation control)

A soft hyphen (U+00AD) is always a line-break opportunity; there is no style to turn it off, and
`blitz-dom` does not read `hyphens`. With `hyphens: none` CSS Text 3 says a soft hyphen is not a
break opportunity.

```html
<p style="width:150px; hyphens:none">Extra&shy;ordinarily in&shy;compre&shy;hensible counter&shy;revolutionary inter&shy;nationalization.</p>
```

Expected (Chrome): 4 lines (80 px), no word split. Actual: 5 lines (100 px), split at the soft
hyphens.

### CW-17 `text-align-last`

Parley's alignment has no separate value for the last line, and `blitz-dom` does not map
`text-align-last`.

```html
<p style="text-align:justify; text-align-last:center">Justified with a centred last line. Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima.</p>
```

Expected (Chrome): last line "juliet kilo lima." centred, starting at x 66.9. Actual: at x 0.

### CW-10 `vertical-align: sub` / `super`

There is no baseline shift for inline content, so `<sub>`/`<sup>` sit on the baseline and do not
grow the line box.

```html
<p><strong>Strong</strong> <em>emphasis</em> <u>underline</u> <s>strike</s> <code>code</code> <small>small</small> <sub>sub</sub> <sup>sup</sup> text.</p>
```

Expected (Chrome, 240 px): paragraph 47.17 px tall. Actual: 40 px.

## Blitz

### CW-04 `line-height: normal` is a fixed 1.2

`stylo_to_parley::style` maps `LineHeight::Normal` to `FontSizeRelative(1.2)`. Browsers use the
primary font's metrics (ascent + descent + line gap; Chrome rounds ascent and descent).

```html
<p style="font:16px Inter; line-height:normal">Eight lines of text …</p>
```

Expected (Chrome, Inter 16 px): 20 px per line. Actual: 19.2 px; 6.4 px drift after 8 lines.

### CW-05 `font-optical-sizing: auto`

Only `font-variation-settings` reach Parley; a font with an `opsz` axis keeps its default instead
of following the font size.

```html
<p style="font:16px Inter; font-optical-sizing:auto">Optical size follows the font size …</p>
```

Expected (Chrome, Inter variable): `opsz` 16, text ≈1 % narrower, 7 lines at 240 px. Actual:
`opsz` 14, 8 lines.

### CW-06 Shrink-to-fit widths are rounded up

`layout/inline.rs` calls `ceil()` on the computed inline content width, so every
shrink-to-fit box (flex item, absolutely positioned box, inline-block) grows to a whole pixel.

```html
<div style="display:flex; gap:10px; padding:8px"><div style="padding:4px">One</div><div style="padding:4px">Two words</div></div>
```

Expected (Chrome): first item 39.02 px wide. Actual: 40 px; the next item starts 0.98 px late.

### CW-12 Multi-column layout

`column-count` / `column-width` have no effect: content lays out in one full-width column.

```html
<div style="column-count:2; column-gap:16px"><p style="margin:0 0 8px">Column text. Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.</p></div>
```

Expected (Chrome, 240 px): two 112 px columns, the paragraph in 14 lines. Actual: one 240 px
column, 7 lines.

### CW-14 `border-spacing` at the table's edges

`layout/table.rs` maps `border-spacing` to grid gaps, which apply only between tracks. CSS 2
also puts the spacing between the outer cells and the table's border.

```html
<table style="border-spacing:2px"><tr><td>Alpha</td><td>One</td></tr></table>
```

Expected (Chrome): first cell at x 2, y 2. Actual: x 0, y 0; the table is 4 px smaller in each
axis.

### CW-15 `border-collapse: collapse`

Collapse is approximated with a border-wide gap; the cells keep their full borders in layout,
so adjacent borders are not shared, and the auto column widths differ from the CSS 2 auto table
layout.

```html
<table style="border-collapse:collapse; width:100%">
  <tr><td style="border:2px solid; padding:6px" colspan="2">Spans two columns</td><td style="border:2px solid; padding:6px">C</td></tr>
  <tr><td style="border:2px solid; padding:6px">One</td><td style="border:2px solid; padding:6px" rowspan="2">Spans two rows</td><td style="border:2px solid; padding:6px">Three</td></tr>
  <tr><td style="border:2px solid; padding:6px">Four</td><td style="border:2px solid; padding:6px">Six</td></tr>
</table>
```

Expected (Chrome): table 104 px tall, rows 34 px. Actual: 116 px, rows 36 px.

### CW-16 `position: sticky` is `relative`

`stylo_taffy` (`convert.rs`) maps `Sticky` to `Position::Relative`, so the inset always moves the
box. A sticky box only moves when its scrollport would otherwise scroll it past the inset; in an
unscrolled document a box already below `top` stays where it is.

```html
<div style="height:40px; margin-bottom:8px">Above.</div>
<div style="position:sticky; top:10px">Sticky top ten, already below it.</div>
```

Expected (Chrome): the sticky box at y 48. Actual: y 58.
