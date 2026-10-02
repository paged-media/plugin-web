# ADR 402 — Text crosses to the page as plain strings; the engine repaints it

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-render/src/capture.rs`, `fonts.rs`, `lower.rs`, the text item in
  `wire.rs`, and `packages/web-render/assets/fonts/`

## Context

The scene layer's text item is a single-line run: a baseline origin, a string, a point
size and a paint. The host draws that string itself, in the document's default font; the
`family` field is described as a reserved hint (`packages/web-render/src/wire.rs:274-292`,
mirroring `core: crates/paged-compose/src/scene_layer.rs`).

Blitz does not hand strings to its paint sink. `draw_glyphs` receives glyph ids and
positions only (`packages/web-render/src/capture.rs:655-657`). The lowering therefore
"needs the plain text, never the glyph ids" (`capture.rs:657-659`).

On `wasm32` the text stack has no system font discovery, so without a registered face
"text shapes to NOTHING": boxes paint and glyph runs do not
(`packages/web-render/src/fonts.rs:21-25`).

## Decision

Text leaves the plugin as plain strings with positions. Glyph ids never leave it. Layout is
shaped with one face compiled into the crate, and the host repaints each string.

- `draw_glyphs` records one run per call with an empty string, the painted baseline and a
  `local_key`: the first glyph's position in the inline root's untransformed local space.
- After painting, the capture walks every inline root's Parley layout, slices the source
  text of each glyph run by its byte range, and attaches it to the captured run with the
  same `local_key` (tolerance 0.5 pt). A tie is broken by the nearest untransformed absolute
  baseline. Each recovered string is used once. A run with no match keeps an empty string,
  and the lowering skips it.
- The only font context given to Blitz is built from Inter Regular, embedded with
  `include_bytes!`, with system fonts off. The same context is used in native builds so that
  tests shape identically on every machine (`fonts.rs:30-32`). One weight is enough because
  "the recovered geometry + plain text is what crosses the wire, not glyphs"
  (`fonts.rs:35-36`).
- The emitted item carries `x`, `y`, `text`, `size`, `paint`, `family` (the bundled family
  name) and `style: None`.

## Evidence

- `packages/web-render/src/capture.rs:631-691` — `draw_glyphs` records `text: String::new()`
  and the `local_key`
- `packages/web-render/src/capture.rs:833-906` — text recovery from each layout by byte range
- `packages/web-render/src/capture.rs:924-960` — matching, tie-break, single use; `:957`
  sets `family` to the bundled family
- `packages/web-render/src/fonts.rs:21-36`, `:43`, `:54-56` — why a face is bundled; the
  embedded bytes; `blitz_dom::build_single_font_ctx`
- `packages/web-render/src/capture.rs:801-804`, `packages/web-render/src/flow.rs:156-159` —
  the two places a document is created, both with that font context
- `packages/web-render/src/lower.rs:386-399`, `packages/web-render/src/wire.rs:274-292` —
  `lower_text` (empty text skipped, `style: None`); the text item and its `family` comment

## Alternatives considered

Two are named in comments and ruled out without further argument: recovering text by
reverse-mapping glyph ids (`capture.rs:830-832`), and filling an unmatched run with a
glyph-id string (`capture.rs:680-683`).

The first version of the recovery (commit `c4519e2`) matched a captured run's painted
baseline against the untransformed absolute position computed from the DOM. Commit `cce2b19`
replaced that key with `local_key`, because under a CSS transform the two no longer agree
and the text of a transformed run failed to attach.

## Consequences

Line breaks and run positions are computed with Inter's metrics, and the host draws the
strings in another face. Nothing in this repository reconciles the two. The font family,
weight and style chosen in CSS do not reach the page: `family` is always the bundled family
name and `style` is always `None`.

The document's own font bytes are used by the browser preview only. The panel inlines them
as `@font-face` rules (`packages/web-bundle/src/panels/web-source-panel.tsx:766-776`), while
the engine path composes the document without that prelude
(`packages/web-bundle/src/bake.ts:250`).

When several transformed inline roots collide on one `local_key`, the loser keeps an empty
string and is not drawn (`capture.rs:916-923`). The flatten to native items
([ADR 407](407-baking-flattens-to-native-items.md)) inherits all of these limits.

`Inter.ttf` is committed and compiled into the wasm; its notice is
`packages/web-render/assets/fonts/OFL-Inter.txt`.

## Related

- [ADR 401](401-layout-engine-pinned.md) — the engine whose paint sink sees only glyphs
- [ADR 407](407-baking-flattens-to-native-items.md) — what the flatten does with text runs
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) — the scene layer and its text item
