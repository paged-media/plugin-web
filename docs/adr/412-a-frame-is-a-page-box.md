# ADR 412 — A frame is a page box; fragmentation rules are read from the source CSS

- **Status:** Accepted, 2026-10-05.
- **Scope:** `packages/web-render/src/break_rules.rs`, `flow.rs` (cut planning),
  `capture.rs` (`render_html`)

## Context

A web flow is cut into frames by laying the remainder out again (ADR 404). Authors control
where print content breaks with `break-before`, `break-after`, `break-inside`, `orphans`,
`widows` and `@page`. The pinned style engine (ADR 401) builds all of these for its other
host browser only: the computed style of a node never carries them, so the cut planner could
not see them. CSS also has no notion of a layout frame: its fragmentation contexts are pages,
columns and regions, and `@page` describes a page box whose size the document chooses.

## Decision

- **A frame is a page box.** Every frame of a flow, and a single frame on its own, is one page
  (and one column) of the content. A forced break of any kind (`page`, `column`, `always`,
  `left`, `right`, `recto`, `verso`, `region`; the CSS 2 `page-break-*` aliases) starts the next
  frame; in the last frame it leaves the rest overset. Avoid values of every kind keep content
  together where the frame is not otherwise left empty.
- **`@page` margins inset the page area** of every frame; they are applied as padding of the
  root element (the engine ignores root margins, and padding, like a page margin, does not
  collapse with the first child's margin). `@page size` is not applied: the layout owns the
  frame's geometry, and the frame's content box is the page size. Margin boxes (`@top-center`
  and the like) and page selectors (`:first`, named pages) are not distinguished.
- **The rules are read from the source CSS by a scanner** in the renderer, as the bundle reads
  CSS Regions `flow-into` (`web-model/src/css-flow.ts`): the text of every `<style>` element
  and each element's `style` attribute; selectors are matched by the layout engine's own
  selector matching. The cascade is simplified: rules apply in source order and a later rule
  wins per property; an inline `style` wins over every rule; specificity is not compared;
  `@media` blocks are skipped (the engine lays out for the screen).
- **`orphans` and `widows` take their CSS initial value 2** when nothing declares them, as
  Chrome does. They are inherited.

## Consequences

- The cut planner honours forced breaks between blocks and inside blocks that fit, keeps an
  avoid box whole, pulls a block with `break-after: avoid` along with what follows, and moves
  a paragraph line split to satisfy orphans and widows. Three Chrome fragmentation fixtures
  (`flow-break-forced`, `flow-break-avoid`, `flow-orphans-widows-rules`) check it; the
  `page` value and `@page` margins are checked by `tests/page_breaks.rs`, because the Chrome
  oracle models frames as columns.
- A rule whose selector the engine cannot parse, or that needs specificity to win, may apply
  where Chrome would not. A stylesheet that sets these properties only inside `@media print`
  is not honoured.
- With the initial orphans and widows, cuts move compared with the earlier "break after the
  last line that fits": the flow budgets in `tests/perf_budgets.rs` are pinned for the new
  policy.

## Alternatives considered

- **Patch the style engine to build the properties for this host.** The engine is pinned
  exactly (ADR 401); a fork for five properties is the cost ADR 020 declined.
- **Scan the rules in the bundle and pass them across the boundary.** It would add an argument
  to the flow export (ADR 403) and a second place where the CSS is read; the renderer already
  has the document and a selector engine, and the Chrome replay calls it directly.
- **Apply `@page size` to the frame.** Resizing a frame from its content contradicts the
  layout owning geometry; the overflow policy `grow` is the deliberate way content resizes a
  frame.
- **Keep "break after the last line that fits" when nothing declares orphans or widows.** It
  would keep the earlier cuts, but disagree with Chrome on every paragraph that leaves one
  line on either side of a break.

## Evidence

- `packages/web-render/tests/flow_parity.rs` with the fixtures
  `packages/web-conformance/chrome/flow-fixtures/flow-break-forced.html`,
  `flow-break-avoid.html`, `flow-orphans-widows-rules.html` (red before the change, green
  after).
- `packages/web-render/tests/page_breaks.rs`; `packages/web-render/src/break_rules.rs` (scanner
  tests).

## Related

- [ADR 404](404-fragmentation-by-relayout.md) — fragmentation by laying the remainder out again
- [ADR 401](401-layout-engine-pinned.md) — the pinned layout engine
- [ADR 405](405-flow-chain-is-plugin-data.md) — the frame chain of a flow
