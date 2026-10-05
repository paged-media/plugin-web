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
  On save, container parts that no label names and that no undo step of the session can
  reach are dropped ([ADR 410](adr/410-unreachable-source-parts-dropped-on-save.md); needs the
  engine's delete door, protocol 66).
- **Source panel.** HTML and CSS editors, a sandboxed browser preview at the frame's content
  size (following resizes and undo) refreshed 300 ms after typing stops, an HTML linter, font diagnostics, template variables (`{{name}}` plus four
  filters), a tag outline, sanitised clipboard paste, an explicit "Save to document", and a
  readout of the last render, flow render or flatten. Unsaved edits are kept per frame while
  the panel is open and come back, still marked unsaved, when the frame is selected again.
  While the frame's edit context is active, the host's Undo/Redo step the frame's draft edits
  (quick edits are one step); leaving the frame hands Undo back to the document.
- **In-frame text editing.** Inside the frame's edit context a click on rendered text places
  a caret in the DOM text node it was painted from (the engine's inspected render maps every
  painted cluster to its text node). Typing, Backspace/Delete, arrows and Home/End edit that
  node; the frame re-renders live and the caret is drawn on the canvas. Enter writes the
  source as one undoable step (markup and untouched character references stay as they were),
  Esc restores the frame, Cmd+Z steps the keystrokes while an edit is open; a click on other
  text commits and opens that node.
- **Outline and canvas.** Clicking a tag in the panel's outline outlines the element's painted
  box on the canvas; a press inside the entered frame marks the tag of the element under it.
- **Bound data.** Templates can name `{{doc.title}}`, `{{doc.pages}}`, `{{doc.<key>}}` (a
  document value map, set in the panel), `{{frame.page}}` and `{{data.<field>}}` /
  `{{data.<provider>.<field>}}` (the first record of a `dataset` data provider, which paged.data
  publishes). The panel lists the bound names a draft uses with their values; every render
  substitutes them, and the canvas re-renders when a value changes.
- **Import.** A `.html` or `.htm` file opens as a new web frame: `<style>` blocks become the
  CSS, the content of `<body>` becomes the HTML, and the sanitiser runs on it.
- **Render to canvas.** Web frames render through the wasm engine to a scene layer by
  themselves: on activation, when a document opens, and after a save, an undo or redo, a
  resize, a thread or unthread (`auto-render.ts`). A source re-renders only when its label or
  the size of a frame it renders into changed; a move renders nothing. A frame that leaves a
  flow or is deleted is cleared. The "Render web frame to canvas" command renders now. Layers
  carry solid fills and strokes, text runs, linear, radial and sweep gradient fills, outset
  and inset box shadows, and raster images.
- **Faces and resources from the document** ([ADR 411](adr/411-faces-and-resources-from-the-document.md)).
  Before a render the document fonts the CSS names (from the asset store, in the styles the
  source uses) are registered with the engine, so bold, italic and other weights shape in
  their own faces; a family nobody registered falls back to the bundled face instead of
  vanishing. Each text run carries its family, and its weight and italic when not regular.
  Images (`<img>`, CSS backgrounds), linked stylesheets and `@font-face` sources load from
  the container part `resources/<path>`, from `data:` URIs, or (`paged-image:<element id>`)
  from the document's placed images; anything else, network URLs included, is reported as
  not loaded. A host that draws scene text in its own face (protocol 68) reports the faces
  it had to substitute, and those are reported too, except the bundled face.
- **Overflow policies.** clip; shrink to fit (laid out in a larger box and scaled into the
  frame); grow frame (the frame's height follows the content, one undoable resize, never
  redone after an undo); continue into thread (the flow; on an unthreaded frame it clips and
  says to thread it).
- **Flow.** Frames can be threaded to and unthreaded from a web frame, and the chain is
  saved. The flow render lays the remainder out again at each frame's width and cuts between
  blocks, lines of a paragraph, children of a container and table body rows (a `<thead>`
  repeats). `break-before`, `break-after` and `break-inside` (and the CSS 2 `page-break-*`
  aliases), `orphans` and `widows` (initial value 2) are honoured; a frame is a page box, so
  `page` and `column` both force the next frame and `@page` margins inset every frame
  ([ADR 412](adr/412-a-frame-is-a-page-box.md)). Content left after the last frame is reported as overset. A CSS `flow-into` rule
  selects the subtree that flows; several named flows each go to their own frames.
- **Flatten.** "Bake web frame to document" creates, in one undoable batch, native swatches,
  gradient swatches, rectangles, paths (with every subpath) and image frames, and a text frame
  per run set in its own family and style, for one frame or for a primary flow chain. Strokes,
  item opacity for translucent paint and the drop shadow of a rectangle are kept; it reports
  what it left out. InDesign opens the result with each item, face, stroke, opacity, shadow,
  path and image where the bake put it (the InDesign lane in `packages/web-conformance`).

## Limits of what is shipped

- **Rendering is not stored.** The layer is not in the document; every open renders again.
  Discovery reads the scene tree once per change burst; on an engine before protocol 65 (no
  plugin labels on tree rows) it reads each page item's label instead. Shrink to fit searches
  with about ten layouts and grow measures with one, because the engine has no content-height
  export. Flatten ("Bake") lays out at the frame's size and ignores the overflow policy.
- **Fonts on the canvas.** A host before protocol 68 draws every scene text run in the
  document's default font, whatever face it was shaped in. A host at 68 draws the run in its
  family when the document has registered it; the plugin has no door to register a face with
  the host, so the bundled Inter and any `@font-face` face are drawn in the default font
  there. Faces are registered with the engine once per engine instance; a font served later
  under the same family is not picked up until the engine restarts.
- **Paint that is not carried.** Image and pattern brushes, rotated or sheared images and
  gradient-painted text are dropped and counted, but `render_web_frame` returns only the
  layer, so the count does not reach the user. Clip shapes, layer opacity and the spread of
  an inset shadow are ignored without a count. Blended fills and gradient strokes are
  lowered and tested, but the pinned engine never emits them from HTML.
- **Images.** Only images the document holds load (see Faces and resources); SVG images do
  not decode. Pixels cross the wasm boundary, and the bake's image bytes cross to the host,
  as JSON arrays of byte values. A resource part changed under the same path is not read
  again until the engine restarts.
- **Frame options.** `media` only sets a class on `<body>`: `@media print` never matches, in
  the preview or on the canvas (the engine supports a print media type; the render exports
  take no media argument yet). `viewportWidth` from older documents is kept and unused. The
  preview draws document fonts and the canvas does not (see Fonts); shrink to fit scales only
  on the canvas.
- **Fragmentation cannot split** a table row, an image or other replaced element, a form
  control, or a block whose one line is taller than the frame; such a block moves whole to
  the next frame. Table columns are resolved again in each frame and may shift. The
  fragmentation properties are read from the source's CSS by a scanner (the layout engine does
  not compute them): rules apply in source order without comparing specificity, rules inside
  `@media` are not read, and `@page size` is not applied (the frame's size is the page size).
- **A flow** re-renders when its source or a frame's size changes; a deleted recipient is
  skipped (the chain keeps its id, so undo of the delete brings it back). Overset is a warning
  only, no frame or page is created, and DOM `flow-from` regions are ignored. An overset last
  frame ends at its last block, line or table row that fits; the rest is the overset.
- **Layout against Chrome.** 39 hand-written fixtures and 7 flows are replayed against
  Chrome recordings (`packages/web-conformance/chrome/PARITY.md`): 123 of 156 layout verdicts
  agree, every flow agrees. The 13 open defects are in the pinned layout engine
  (`line-height: normal`, optical sizing, shrink-to-fit rounding, flex auto margins with
  `justify-content`, `vertical-align`, a no-break space that breaks, multi-column, percentage
  padding, table spacing and collapsed borders, `position: sticky`, `text-align-last`,
  `hyphens: none`); upstream reports are drafted in `chrome/UPSTREAM.md`.
- **The flatten does not carry** sweep gradients, gradient strokes, blended fills, inner
  shadows, the shadow of a rounded box (the engine sets drop shadows on rectangles and text
  frames only) or translucent gradient stops (baked opaque); each is counted in the report. A
  gradient keeps its angle and length but not its start point. Each text run becomes its own
  text frame. Items are created by kind (rectangles, paths, images, then text), not in paint
  order, and are offset from the frame's top-left corner with no rotation or scale. Of a
  flow, only the primary chain is flattened. Nothing is removed: the web frame, its source
  and earlier flatten items stay. A bold italic run in Inter arrives in InDesign as Inter
  Italic, because the bundled Inter offers InDesign no bold italic face (pinned as a defect).
- **Storage.** The engine caps a metadata label at 64 KiB; a larger source needs a host with
  container parts, and without one the save is refused with a visible message. Every saved
  version of a large source written in a session stays as a part until a later session's
  save (that is what lets undo return to it). The engine versions stamped into each envelope match the
  lockfile (a spec checks it) but nothing reads them back.
- **In-frame editing** edits one text node at a time: the caret does not cross into the
  neighbouring node (a bold word, a link), and Enter commits rather than starting a paragraph.
  Text a template produced, and text the parser moves (fostered out of a table), is refused with
  a note. A threaded frame and a shrink-to-fit frame are edited in the panel. The double-click
  that enters the frame is not delivered to the plugin, so a further click places the caret.
  The caret is a line drawn through the host's tool-preview overlay, which other tools share.
- **Bound data** reads one record (the first) of a provider. Document values live in a
  container part, which undo does not restore, and writing one raises no document change (the
  panel re-renders the frames itself).
- **Import** reads the one file. Linked stylesheets, images and fonts are not brought into
  the container, so they are reported as not loaded until they are stored there.

## Not built

- Execution of page JavaScript, and any scripted transform: the template pass has no
  expressions ([ADR 408](adr/408-no-page-javascript.md)).
- An exporter: the manifest contributes none ([ADR 407](adr/407-baking-flattens-to-native-items.md)).
- A raster fallback: the `dpi` field of the render request feeds only a stub.
- A flow the host knows about: the chain is plugin data ([ADR 405](adr/405-flow-chain-is-plugin-data.md)).
- Inspection of computed styles, and a CSS compatibility table: the linter works on the source
  text, and the outline maps tags to painted boxes but shows no metrics.
- The engine-neutral `renderWebFrame` and `renderWebFlow` in `packages/web-model/src/render.ts`:
  they always answer "not loaded", and the bundle calls the engine object directly.

The as-built detail of the flow lane is in [`design/flow-fragmentation.md`](design/flow-fragmentation.md).

## CI

`vitest` (push, pull request) builds the engine wasm from the checkout and fails on a red
spec; `rust` (push, pull request) runs `cargo fmt --check`, clippy with `-D warnings` for both
feature sets and `cargo test` with and without `blitz`; `publish` runs only after a green
`vitest` push run, waits for `rust` on the same commit, tests again, and fails when the
sources changed since the published version without a version bump.
