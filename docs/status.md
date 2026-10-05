# Status

What `paged.web` ships and what it does not, read from the code on 2026-10-05
(`@paged-media/web` 0.1.0-canary.9, not yet published). How the parts fit is in
[`architecture.md`](architecture.md); the gaps against Chrome and InDesign, the test baseline
and the performance reading are in [`design/analysis-2026-10-05.md`](design/analysis-2026-10-05.md).

## Shipped

- **Web frames.** "Insert web frame" creates a rectangle and its source in one undoable
  batch; the panel can also turn a selected frame into a web frame, from a default source or
  one of four starter templates. The source is saved in the frame's metadata label when it
  fits, otherwise in a content-addressed container part the label points to; undo of a save
  restores the previous source everywhere. A double-click enters the `webFrame` edit context.
- **Source panel.** HTML and CSS editors, a sandboxed browser preview refreshed 300 ms after
  typing stops, an HTML linter, font diagnostics, template variables (`{{name}}` plus four
  filters), a tag outline, sanitised clipboard paste, an explicit "Save to document", and a
  readout of the last render, flow render or flatten. Unsaved edits are kept per frame while
  the panel is open and come back, still marked unsaved, when the frame is selected again.
- **Import.** A `.html` or `.htm` file opens as a new web frame: `<style>` blocks become the
  CSS, the content of `<body>` becomes the HTML, and the sanitiser runs on it.
- **Render to canvas.** One command renders the selected frame through the wasm engine to a
  scene layer: solid fills and strokes, text runs, linear,
  radial and sweep gradient fills, outset and inset box shadows.
- **Flow.** Frames can be threaded to and unthreaded from a web frame, and the chain is
  saved. The flow render lays the remainder out again at each frame's width and cuts between
  blocks, lines of a paragraph, children of a container and table body rows (a `<thead>`
  repeats). Content left after the last frame is reported as overset. A CSS `flow-into` rule
  selects the subtree that flows; several named flows each go to their own frames.
- **Flatten.** "Bake web frame to document" creates native swatches, rectangles, paths and
  text frames for one frame or for a primary flow chain, and reports what it left out.

## Limits of what is shipped

- **Rendering is on command.** Nothing renders on open, on save, or when a frame is resized.
  The layer is not stored in the document.
- **Fonts on the canvas.** Layout is shaped with one bundled face, Inter Regular, with
  system fonts off. A scene text item carries position, size, colour and the string, no
  weight or style; per `packages/web-render/src/wire.rs` the host draws it in the document's
  default font. Document font bytes reach only the panel preview, which the browser draws.
- **Paint that is not carried.** Image and pattern brushes, rotated or sheared images and
  gradient-painted text are dropped and counted, but `render_web_frame` returns only the
  layer, so the count does not reach the user. Clip shapes, layer opacity and the spread of
  an inset shadow are ignored without a count. Blended fills and gradient strokes are
  lowered and tested, but the pinned engine never emits them from HTML.
- **Images.** The lowering of axis-aligned raster images is built and unit-tested on
  hand-built brushes, but no test shows an image reaching the layer from HTML, and the
  engine is built without a network provider. Pixels would cross the wasm boundary as a
  JSON array of byte values.
- **Frame options.** `media` only sets a class on `<body>`; `viewportWidth` applies to the
  panel preview; `overflow` has the single value `clip`.
- **Fragmentation cannot split** a table row, an image or other replaced element, a form
  control, or a block whose one line is taller than the frame; such a block moves whole to
  the next frame. There is no `break-*`, orphan or widow handling. Table columns are
  resolved again in each frame and may shift.
- **A flow does not update itself.** The chain stores frame ids. Nothing re-flows when the
  content or a frame changes, overset is a warning only, and no frame or page is created.
  DOM `flow-from` regions are ignored.
- **The flatten does not carry** images, strokes, gradients, shadows, blended fills or fills
  with more than one subpath. Partial transparency is lost, because swatches are opaque RGB.
  Each text run becomes its own text frame with only size and colour set. Items are created
  by kind (rectangles, paths, then text), not in paint order, and are offset from the
  frame's top-left corner with no rotation or scale. Of a flow, only the primary chain is
  flattened. Nothing is removed: the web frame, its source and earlier flatten items stay.
- **Storage.** The engine caps a metadata label at 64 KiB; a larger source needs a host with
  container parts, and without one the save is refused with a visible message. Every saved
  version of a large source stays as a part (that is what lets undo return to it); nothing
  removes unreachable ones yet. The engine versions stamped into each envelope match the
  lockfile (a spec checks it) but nothing reads them back.
- **Import** reads the one file. Linked stylesheets, images and fonts are not brought in.

## Not built

- Execution of page JavaScript, and any scripted transform: the template pass has no
  expressions ([ADR 408](adr/408-no-page-javascript.md)).
- An exporter: the manifest contributes none ([ADR 407](adr/407-baking-flattens-to-native-items.md)).
- A raster fallback: the `dpi` field of the render request feeds only a stub.
- Document fonts in the layout engine, and automatic re-rendering or re-flowing (see above).
- A flow the host knows about: the chain is plugin data ([ADR 405](adr/405-flow-chain-is-plugin-data.md)).
- Inspection of rendered boxes, and a CSS compatibility table: the outline and the linter
  work on the source text.
- The engine-neutral `renderWebFrame` and `renderWebFlow` in `packages/web-model/src/render.ts`:
  they always answer "not loaded", and the bundle calls the engine object directly.

The as-built detail of the flow lane is in [`design/flow-fragmentation.md`](design/flow-fragmentation.md).

## CI

`vitest` (push, pull request) builds the engine wasm from the checkout and fails on a red
spec; `rust` (push, pull request) runs `cargo fmt --check`, clippy with `-D warnings` for both
feature sets and `cargo test` with and without `blitz`; `publish` runs only after a green
`vitest` push run, waits for `rust` on the same commit, tests again, and fails when the
sources changed since the published version without a version bump.
