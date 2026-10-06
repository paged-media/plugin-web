# Architecture

How the `paged.web` plugin is built: HTML and CSS as a content type inside a page-layout
editor. It describes what the code does at commit `40792fa`. The reason behind each choice
is in an ADR under [`adr/`](adr/README.md), linked where it applies. A bare file name is in
the `src/` folder of the package being discussed.

## Packages

The repo is a pnpm workspace with three packages under `packages/`. Two are TypeScript. The
third is a Rust crate that is its own Cargo workspace with its own `Cargo.lock`; there is no
`Cargo.toml` at the repo root.

**`packages/web-model`** — TypeScript, private, no runtime dependencies, no DOM calls. It
holds everything that needs neither a host nor an engine: the source model and its saved
envelope (`source.ts`), the template pass (`transform.ts`), the HTML linter (`diagnose.ts`),
the sanitiser (`sanitize.ts`), the `.html` file splitter (`import-html.ts`), the scanner for
CSS Regions syntax (`css-flow.ts`), the font-family scan and `@font-face` composer
(`fonts.ts`), a TypeScript copy of the scene-layer types (`render.ts`) and the engine
version stamp (`engine.ts`). None of it parses HTML or CSS into a tree: the linter,
sanitiser and splitters are scanners written to return a result for any input.

**`packages/web-bundle`** — TypeScript and React, published to npm as `@paged-media/web`
(`dist`, `bin` with the wasm, and `manifest.json`). It holds `activate(host)`
(`src/activate.ts`), the seven commands, the source panel (`src/panels/`), the engine loader
(`src/engine-loader.ts`), the render path (`src/bake.ts`) and the flatten path
(`src/bake-plan.ts`, `src/bake-to-document.ts`). It is the only package that touches the host.

**`packages/web-render`** — Rust crate `web-render` (`cdylib` + `rlib`, `publish = false`).
Three modules are always built: `wire` (the scene-layer types as serde structs),
`display_list` (`WebDisplayList`, a plain list of captured paint commands) and `lower` (a
pure function from display list to scene layer, plus a coverage report). Three more are
compiled only with the Cargo feature `blitz`, which is off by default: `capture` (the paint
sink and text recovery), `flow` (fragmentation across frames) and `fonts` (the one bundled
face). See [ADR 400](adr/400-pure-lowering-and-capture-layer.md).

Dependency direction (`web-model` and `web-render` import nothing from this repo):

- `web-bundle` imports `web-model` by relative source path (`../../web-model/src`), and in
  one file by package name (`packages/web-bundle/src/bake-plan.ts:37`); tsup inlines it
  either way, so the published package does not depend on the private one.
- `web-bundle` reaches `web-render` only as a built artefact, `bin/blitz_web.js` and
  `bin/blitz_web_bg.wasm`, loaded at run time. No TypeScript is generated from the Rust
  types: the scene-layer shape is written by hand in `packages/web-render/src/wire.rs` and
  again in `packages/web-model/src/render.ts`.
- Towards the host, `@paged-media/plugin-api`, `@paged-media/plugin-sdk` and `react` are
  peer dependencies. `scripts/check-contract-imports.mjs` fails on any other package import.

The layout engine is the Blitz stack, pinned to `=0.3.0-alpha.4` in
`packages/web-render/Cargo.toml` (the lockfile resolves Stylo 0.17.0, Taffy
0.11.0-experimental-cache-fix.3, Parley 0.9.0 and anyrender 0.10.0). It parses, styles, lays
out and emits paint commands. No GPU renderer is linked: the lockfile has no `vello` and no
`wgpu` entry. See [ADR 401](adr/401-layout-engine-pinned.md).

## One render

```
selected frame (a rectangle carrying the source envelope)
   |  read: label (inline, or pointer -> part)            source-part.ts
   v
{ html, css, options, vars?, flow? }
   |  template pass, then one composed HTML document     transform.ts, source.ts
   |  frame size: points x 96/72 -> CSS px               bake.ts
   v
render_web_frame(html, width_px, height_px)              lib.rs (wasm export)
   |  parse -> style -> layout                           Blitz
   |  paint into CapturingScene -> WebDisplayList        capture.rs (px x 72/96 -> points)
   |  recover each text run's string from the DOM        capture.rs
   |  lower() -> SceneLayer                              lower.rs
   v
JSON { items: [...] }  ->  parseSceneLayer               engine-loader.ts
   v
surface.submit(frameId, layer)  ->  the host composes the layer inside the frame
```

1. The command `media.paged.web.command.renderWebFrame` (`render-command.ts`) needs exactly
   one selected element. `loadWebEngine` imports the wasm on first use and keeps one engine
   per process. If loading fails, or a render call throws, nothing is submitted and the
   command publishes an "engine not loaded" diagnostic.
2. `bakeWebFrame` (`bake.ts`) reads the source, asks the host for the frame's bounds,
   applies the template pass if the source has a `vars` map, and builds one HTML document
   with `composeSrcdoc`: the CSS in a single `<style>`, the HTML in `<body>`.
3. In the wasm, `capture::render_html` builds the document with a font context that holds
   one face, sets the viewport, resolves layout, and calls `blitz_paint::paint_scene` with a
   recording sink, `CapturingScene`. The sink converts CSS px to points and folds every
   transform into the geometry, so the display list is already in frame-content points.
4. The sink receives glyph ids and positions, not strings. After painting, `capture.rs`
   walks each inline root's Parley layout, slices the source text by each run's byte range,
   and attaches it to the captured run whose first-glyph position matches. A run with no
   match stays empty and is skipped. See [ADR 402](adr/402-text-crosses-as-strings.md).
5. `lower` maps each command to a scene item, in paint order: solid fills and strokes, text
   runs, axis-aligned raster images, linear, radial and sweep gradient fills, and outset and
   inset box shadows. Commands with no scene item (image or pattern brushes, rotated images,
   gradient-painted text) are counted in `LowerReport` and dropped.
6. The wasm returns the layer as a JSON string. The boundary is exported functions with
   strings and integers in, JSON out ([ADR 403](adr/403-json-wasm-boundary.md)):
   `render_web_frame`, `render_web_flow`, and `render_web_frame_inspect`, which adds to the
   layer the map from paint back to the DOM (`inspect.rs`: each line's clusters with the text
   node and offset they come from, each element's box by tag and occurrence) for in-frame
   editing and the outline highlight. The bundle parses the JSON (a malformed
   payload reads as an empty layer) and submits it through one scene-layer surface per
   host, created on first use and never disposed: disposing it clears what it submitted.

Why the host's scene layer: [ADR 011](adr/011-web-rendering-fork-defer-to-scenelayer.md).
The layer is session state: it is not written to the document, and a render happens only
when a render command runs. The source panel's preview is a different renderer: an
`<iframe sandbox="">` fed by `srcdoc`, drawn by the browser, with the document's fonts
inlined as `data:` URLs. Page JavaScript runs in neither; see
[ADR 408](adr/408-no-page-javascript.md).

## A flow across several frames

A web frame can pour its content through further frames. The chain is an ordered
`flow.recipients` list inside the source frame's own envelope, edited by the thread and
unthread commands and a picker in the panel; the source frame is position 0. See
[ADR 405](adr/405-flow-chain-is-plugin-data.md).

`renderSelectedWebFlow` (`render-flow-command.ts`) groups the recipients by flow name
(`flowGroups`) and, for each group, calls `render_web_flow(html, frames_json, flow_root)`
with the frames' sizes in CSS px. `flow_root` is the selector of a CSS `flow-into` rule,
found by the scanner in `css-flow.ts`, or empty for the whole body.

In `flow.rs` the engine handles one frame at a time: set the viewport to that frame's width,
resolve, capture, choose a cut, keep the commands above the cut, then remove the consumed
content from the DOM and repeat for the next frame. The last frame keeps what fits its
height; anything left sets `overset`. The cut follows the source's `break-*`, `orphans` and
`widows` rules and `@page` margins, read by `break_rules.rs` because the layout engine does not
compute them ([ADR 412](adr/412-a-frame-is-a-page-box.md)). Each frame's display list is lowered on its own and
the bundle submits one layer per frame. See [ADR 404](adr/404-fragmentation-by-relayout.md)
and [ADR 020](adr/020-paged-web-native-engine-defer-frame-threading.md); the as-built detail
is in [`design/flow-fragmentation.md`](design/flow-fragmentation.md).

## Flatten to native page items

Two things in the code are called "bake". `bake.ts` and `bakeWebFrame` are the render to a
scene layer described above. The command "Bake web frame to document"
(`media.paged.web.command.bakeWebFrame`, `bake-to-document.ts`) is the flatten.

The flatten renders the frame, or each frame of its primary flow chain, without submitting
a layer. `sceneLayerToBakePlan` (`bake-plan.ts`, pure) turns a layer into a plan:
deduplicated RGB swatches named `Color/wb-RRGGBB`, rectangles, single-subpath paths and
text runs. Every other item kind is counted in `deferred`. `materializePlan` then issues
ordinary document mutations at the frame's page position: `createSwatch`; `insertFrame` or
`insertPath` plus a fill colour; and per text run `insertTextFrame`, `insertText`, a size
and a colour.

This is the only export path the plugin itself provides. The manifest contributes no
exporter, and the plugin stores no rendered output in the document. The host can include a
scene layer submitted in the current session in its own export
([ADR 407](adr/407-baking-flattens-to-native-items.md)); that does not survive a reload and
does not reach an IDML export. The frame itself is declared to
fall back to a plain rectangle (`bakedFallback: "rectangle"`), so a file opened without the
plugin carries web content only as the native items a flatten created. See
[ADR 407](adr/407-baking-flattens-to-native-items.md).

## Where the source is stored

A web frame is an ordinary rectangle. What makes it one is a versioned envelope in its
plugin metadata label, key `x-paged:media.paged.web`, which undo and redo restore:

- a source that fits is the label itself:
  `{ v: 1, data: { html, css, options, vars?, flow? }, engine: {...} }`;
- a larger one (the engine caps a label at 64 KiB) is written to a content-addressed
  container part, `sources/<hash>.json`, never overwritten, and the label holds a pointer
  `{ v: 1, data: { ref: { hash, bytes } }, engine }`.

`loadWebSource` and `writeWebSource` in `source-part.ts` are the only reader and writer; the
object type recognises either label shape (`edit-context.ts`). Inserting a frame puts the
label in the batch that creates the rectangle, so one undo removes both. Older documents may
also carry a `<frame id>/source.json` part, read only when the label cannot hold its content.
See [ADR 409](adr/409-label-is-the-truth-large-sources-by-pointer.md).

## Host doors

| Door | What the plugin uses it for |
|---|---|
| `contributePanel`, `host.contribute.command`, `host.contribute.menu` | the "Web frame" panel, seven commands, seven menu entries |
| `contributeObjectType`, `contributeEditContext` | the `webFrame` type and its double-click edit context, which declares no canvas tools |
| `host.contribute.importer` | `.html` and `.htm` files become the source of a new web frame |
| `host.contribute.sceneLayer()` | submit one layer per frame |
| `host.document.mutate` | insert a frame with its metadata in one batch; every flatten operation |
| `host.document.getMetadata` / `setMetadata`, `host.parts.read` / `write` | the source label, and the content-addressed part of a large source |
| `host.document.elementGeometry`, `meta`, `collection(...)` | frame bounds and page; active page for insert; new story of a flattened text frame; registered font families |
| `host.document.onDidChange`, `host.selection.get` / `set` / `onDidChange` | the panel follows the selection and re-reads after undo or redo; commands act on the selection |
| `host.diagnostics.set` | lint, render and flow findings |
| `host.assets.getFontFace` | font bytes for the panel preview |
| edit context `onContentPointerDown`, `onContentKey`, `isDirty`, `onCommit`, `onCancel`, `onUndo`/`onRedo` | in-frame text editing (`in-frame-edit.ts`) |
| `host.overlay.layer` (`overlay.layers@1`), else `host.overlay.setToolPreviews` | the in-frame caret and the outline highlight, each on its own layer (`overlay-channel.ts`) |
| edit context `onEnter` with `contentPoint` (`editContext.enterPoint@1`) | the entering double-click places the caret |
| `host.document.onDidOpen` (`document.onDidOpen@1`), else the editor client's `documentLoaded` | re-render and re-mark source parts when another document opens (`document-opened.ts`) |
| `host.dataProviders.discover` / `get` / `onDidChange`, `host.document.meta` | bound data for templates (`bindings.ts`) |
| `host.clipboard.read` | paste HTML into the panel, sanitised first |
| `host.widgets.CodeEditor` | the HTML and CSS editors, with a plain textarea as fallback |
| `host.text.measureString` | size the text frames of a flatten; estimated when absent |
| `host.storage` | one-time migration of sources saved by early versions |
| `host.shell.openPanel`, `host.log`, `host.supports` | open the panel after insert; logging; probing optional doors |

The manifest declares the matching capabilities: `document` (read `broad`, write `scoped`),
`rendering` (`sceneLayer`, `overlay`), `dataProviders` (consume `dataset`), `editContext` (`webFrame`), `assets` (`fonts`), `clipboard`
(`full`), `network: false`, and one wasm module (`blitz`, at most 64 MiB).

## Build and test

- `bash scripts/build-wasm.sh --engine` builds the crate for `wasm32-unknown-unknown` with
  the `blitz` feature, runs `wasm-bindgen --target web` and, if installed, `wasm-opt -Oz`,
  and writes `packages/web-bundle/bin/` (gitignored). It fails if the wasm exceeds 64 MiB.
  Without `--engine` the crate is built without the engine and has neither export.
  `pnpm -r build` then runs tsup; `.github/workflows/publish.yml` does both in that order
  and publishes `@paged-media/web` under the `canary` tag.
- TypeScript lane: `pnpm test` runs the import lint, then vitest in both packages. The
  engine tests in `web-bundle` replay a captured engine output through a stub loader and,
  when `bin/` is built, also load the real wasm in Node. With `REQUIRE_REAL_ENGINE=1`, set
  by `.github/workflows/vitest.yml` after it builds the wasm, a missing artefact fails
  instead of skipping. `test/conformance/` runs the bundle against `createHeadlessHost`.
- Rust lane: `cargo test` in `packages/web-render` covers `lower` and `wire` without the
  engine; `cargo test --features blitz` adds `capture`, `flow` and `fonts`. No workflow in
  this repo runs it.
