# paged.web flow fragmentation — implementation status (as-built)

**2026-07-18 · canonical status of the ADR-020 "scoped extension" (web-frame flow across
frames).** This is the forward reference for what the flow lane *is now*; the pass-by-pass
history lives in the internal spike log. Decision:
[ADR-020](../adr/020-paged-web-native-engine-defer-frame-threading.md). Spec: an internal
proposal for a native HTML/CSS engine in the core (unpublished; "the spec" below). Eval:
[native-engine-evaluation.md](native-engine-evaluation.md).

## What it is

One HTML/CSS **web source** (authored on a frame) threaded across an **ordered chain of
publication frames**, re-line-broken at each frame's width, with overset reporting — the
CSS-Regions/IDML-story *behavior*, bound by a **host chain**, NOT by CSS
`flow-into`/`flow-from`. Built as the ADR-020 scoped extension on the
shipped Blitz-in-plugin → C-1 `SceneLayer` lane
([ADR-011](../adr/011-web-rendering-fork-defer-to-scenelayer.md) Option B); **no engine fork**.

## Ladder position (from the evaluation memo / the internal spike log)

| Rung | What | Status |
|---|---|---|
| 1 — equal-width slice | layout once, slice the display list per frame | **built + verified** |
| 2 — variable-width re-resolve | delete consumed prefix (`DocumentMutator`), re-resolve remainder at next width | **built + verified** |
| 3 — mid-block line split | split a straddling paragraph at a line boundary | **built + verified** (plain text AND inline elements) |
| 3b — nested block fragmentation | descend a straddling CONTAINER (`<div>`/`<ul>`/…) and cut between its children, recursively | **built + verified**; replaced/atomic elements (`<img>`/`<svg>`/…) move whole |
| 3c — table row fragmentation | split a `<table>` between body rows, repeating the `<thead>` | **built + verified**; cell-derived row bands (Taffy lays out no `<tr>` box); rows atomic, columns re-resolve per frame |
| 4 — full three-tree engine (the spec) | native forked engine | **not built** (last resort per ADR-020) |

## What's built, per package

### Engine — `packages/web-render` (Rust, feature `blitz`)

- `src/flow.rs` — the flow lane (feasibility PoC → product entry):
  - `render_web_flow(html, &[(w,h)]) -> FlowWire` — thread + lower one C-1 `SceneLayer` per
    frame; `FlowWire { frames: [{ layer, emitted }], overset }`.
  - `render_web_flow_json(html, frames_json, flow_root) -> String` — native-testable JSON in/out; the wasm
    export wraps it.
  - `render_web_flow_variable` — the rung-2/3 core (re-resolve remainder + mid-block split);
    `render_web_flow_equalwidth` — rung 1 (display-list slice).
  - `flow_blocks` (flow root's element children = flow blocks, any tag); `plan_frame_cut` →
    `plan_blocks_cut` (**recursive**): consumes fitting blocks, then handles a straddler by
    (a) `try_split` (mid-block line split of a paragraph via Parley `LineMetrics::block_max_coord` +
    `Line::text_range()` → `DocumentMutator::set_node_text`); (b) a **table** (`table_body_rows` +
    `plan_table_rows_cut` + `row_band` — cut between body `<tr>`s using CELL geometry since Taffy
    lays out no `<tr>` box; the `<thead>` is never consumed → repeats each frame); or (c) a
    **container** (`splittable_container_children` — element children, no inline text, not
    table-family/replaced) → DESCEND and cut between its children (the container element stays; an
    emptied one self-cleans). `Node::absolute_position` is document-absolute at every depth, so a
    child block's top/bottom compares to the frame limit with no coordinate translation.
- `src/capture.rs` — `capture_resolved(doc, w, h)` (factored from `render_html` so a frame is
  captured after its own resolve/mutate cycle).
- `src/lib.rs` — wasm exports `render_web_frame` and `render_web_flow(html, framesJson, flowRoot)`.
- **Artifact:** `bash scripts/build-wasm.sh --engine` → `packages/web-bundle/bin/blitz_web_bg.wasm`
  (**9.15 MiB raw / 2.43 MiB brotli**, < 64 MiB budget), carrying both entry points.

### Contract — `packages/web-model` (pure TS)

- `src/render.ts` — `FlowId`, `WebFlowFrame` (frame + chain `order` + content pts),
  `WebRenderFlowRequest` / `WebRenderFlowResult` (per-frame layer + `overset`), `renderWebFlow`
  (honest not-loaded stub), `isFlowRendered`.
- `src/source.ts` — `WebFlowChain { recipients: FrameTarget[] }` as an **additive-optional**
  field on `WebFrameSource` (round-trips at envelope **v1, no version bump**); helpers
  `flowChainOf` / `withRecipient` / `withoutRecipient` / `normalizeFlowChain`. This is the
  **persisted region chain** — a flow survives reopen.

### Bundle — `packages/web-bundle`

- `src/bake.ts` — `bakeWebFlow(host, chain, engine) -> FlowBakeOutcome` (reads source, gathers
  per-frame geometry, composes once, submits one `SceneLayer` per frame via
  `host.contribute.sceneLayer().submit`, surfaces **overset** as a warning diagnostic).
- `src/engine-loader.ts` — `WebEngine.renderFlow` + `parseFlowResult` (defensive JSON → layers).
- `src/render-flow-command.ts` — `renderSelectedWebFlow`, `threadSelectedIntoFlow`,
  `threadSelectedIntoNamedFlow`, `unthreadSelectedFromFlow`, and `resolveFlowChain` (the
  **persisted chain wins**; a ≥2-frame selection is the ephemeral fallback).
- **CSS Regions `flow-into`** (syntax MVP): `packages/web-model/src/css-flow.ts` (`flowRootSelector`,
  `flowSelectorFor`, `parseFlowInto`/`parseFlowFrom`, `namedFlowDiagnostics`); engine
  `render_web_flow_rooted` + `flow_blocks(flow_root)` + a **recursive non-flow prune**
  (`collect_non_flow` — keeps only the flow-root subtree + its ancestor path, at ANY nesting
  depth); `bakeWebFlow`/`bakeWebFlows` wire it from the source CSS.
- `src/source-part.ts` — `persistSource` (metadata label + container part).
- `src/activate.ts` + `manifest.json` — **7 commands**: `insertWebFrame`, `renderWebFrame`,
  `renderWebFlow`, `threadWebFlow`, `unthreadWebFlow`, `threadWebFlowNamed` (route the selection
  into the source's SECONDARY named `flow-into` — the article+sidebar case, picker-free), and
  `bakeWebFrame` (flatten to native content; dispatches single-frame or whole-flow).
- **Bake to NATIVE content** (`src/bake-plan.ts` + `src/bake-to-document.ts`): flatten a
  rendered web frame into real Paged page items so it exports to IDML/PDF and a foreign open sees
  content with no plugin engine. `bake-plan.ts` (PURE, like
  `plugin-sheets: packages/sheet-host-model/src/lower-to-table.ts`):
  `sceneLayerToBakePlan(layer) → BakePlan` — text runs + solid axis-aligned fill rects become
  native, every other SceneItem kind counted in `deferred` (never faked). `bake-to-document.ts`
  (impure orchestrator, like `plugin-sheets: packages/sheet-bundle/src/lower.ts`): `materializePlan`
  creates a swatch per colour
  (deterministic `Color/wb-…` self-id → `colorRef`), a rectangle per fill, and a text frame per run
  (measure → insert → resolve the minted story via a stories-diff → pour → size + colour);
  `bakeWebFrameToDocument` (one frame) + `bakeWebFlowToDocument` (each recipient frame, reusing
  `bakeWebFlow` with the ephemeral submit OFF).

**Author flow:** insert a web frame → author HTML/CSS → *thread* it into target frames (persisted)
→ *render* the flow (one layer per frame, overset warned) → *unthread* to unbind → *bake* to native
content for IDML/PDF export.

## Verification

Counts are as recorded on the dates given (2026-07-18/19); the suites have grown since.

- **Native (Rust):** `web-render` — **115 passed** (`flow::` = 16: equal-width threading +
  overset; variable-width no-loss; reflow-by-width; end-to-end re-wrap; mixed-tag block content;
  **mid-block paragraph split**; **nested flow-root prune**; **tall-list split + nested
  recursive container fragmentation + table row split w/ header repeat**; product entry lowers
  per-frame + JSON round-trip). clippy-clean, parallel-deterministic (`SHAPE_LOCK`).
- **Contract (TS):** `web-model` — **173 passed** (9 files; incl. flow-chain round-trip + helpers,
  `css-flow` named-flow parsing + `flowSelectorFor` + **`flowThreadOptions` (the source-panel picker
  model)**, `render` flow not-loaded). Typecheck clean.
- **Bundle (TS):** `web-bundle` — **130 passed** (15 files: `bake` incl. `bakeWebFlow`/`bakeWebFlows`
  submit+overset, `flow-command` incl. resolve + thread + **threadWebFlowNamed** + unthread,
  `activate` 7-command registration, `engine`, **`bake-plan` (12 — the pure `SceneLayer → BakePlan`
  translator)**) — **incl. real-wasm smokes** that load the built artifact and prove
  `render_web_frame`, a mixed-tag flow across 3 frames, a **mid-block paragraph split**, a **tall
  `<ul>` fragmenting between its `<li>`s**, AND a **`<table>` splitting between rows with the
  `<thead>` repeating** all produce real C-1 layers. Typecheck + contract-import lint clean.
- **Bake-to-native — VERIFIED through the real host + real Blitz (2026-07-18/19).**
  `packages/web-bundle/test/conformance/bake.spec.ts` (3, gated on the built artifact) loads the ACTUAL Blitz wasm in
  Node + the real `createHeadlessHost`/canvas-wasm engine: a web frame with a solid fill + text
  BAKES into native content — `baked:true`, native page items created, the stories collection grows,
  AND a `Color/wb-…` swatch really lands in the document (the `colorRef`s resolve, not dangling); a
  bogus non-web selection bakes nothing (honest, no crash); a content-heavy source threaded across
  two frames bakes >10 native runs ACROSS both frames (stories grow by exactly the created count).
  So the whole chain — real render → real bake plan → real host mutations → real native content —
  is proven, not mocked.
- **The EXPORT capstone — BROWSER-VERIFIED (2026-07-19).** The whole point of baking is that
  the native content EXPORTS to IDML/PDF; a browser journey (swapped-in local build, Chromium+WebGPU)
  proves it end-to-end: author a `<p>Bakeproof</p>` web frame → `bakeWebFrame` (engine loads, renders,
  materialises 1 native text frame — its story is 9 chars, "Bakeproof"; the frame's 3 non-rect fill
  paths honestly deferred) → the editor's `client.exportIdml()` produces a **3,776-byte IDML that
  re-parses** (`loadDocument`, pageCount ≥ 1) → the re-imported document still has **9 story chars**.
  So the baked text reaches a real, re-loadable IDML file through core's OWN export — the bake lane's
  premise ("exports to IDML/PDF") is now proven, not asserted. (PDF export rides the same native
  content through core's PDF path; not separately driven here.)
- **Editor-HOST round-trip — VERIFIED (2026-07-18).** With `@paged-media/canvas-wasm` linked
  (see below), the full `web-bundle` suite is **104/104** — including `packages/web-bundle/test/conformance/*` (17,
  against the REAL `createHeadlessHost` + real canvas-wasm engine) and a new
  `packages/web-bundle/test/conformance/flow.spec.ts` (4) that drives the **flow lifecycle through the real host**:
  insert a source + a recipient web frame, `threadWebFlow` (the persisted chain resolves back
  through the host), `renderWebFlow` (runs cleanly — the Blitz engine isn't fetch-loadable in
  Node, so the honest not-loaded path), `unthreadWebFlow` (chain removed). So the plugin +
  the flow commands integrate end-to-end with the actual editor host machinery, not mocks.
  - **Setup:** the harness needs `@paged-media/canvas-wasm` resolvable: link a local build to
    `node_modules/@paged-media/canvas-wasm`, or add it as a `web-bundle` devDependency (the
    plugin-sdk message says so).
- **Browser flow AUTHORING round-trip — VERIFIED (2026-07-18).** A LOCAL flow build (dist + `bin/`
  + the 6-command manifest) was substituted for the published `@paged-media/web@0.1.0-canary.1` in
  an editor checkout and driven through the editor's real Playwright journey harness
  (Chromium + WebGPU + vite). A flow journey inserts a source web frame, draws a
  recipient frame, runs **Thread web flow into frames**, **Render web flow across frames**, then
  **Unthread** — and asserts the OBSERVABLE: the source frame's PERSISTED plugin metadata (read
  back the exact way the SDK host reads it — `requestElementProperties` → the `pluginMetadata`
  entry keyed `x-paged:media.paged.web` → the parsed envelope's `data.flow.recipients`). The chain
  **lands in the source envelope on thread, survives the render pass, and clears on unthread** —
  all in the real browser editor against the real host. (The source-lane journey spec,
  `editor: apps/canvas/tests/journey/plugins/web.journey.spec.ts`, also passes with the local
  build: insert, edit, sandboxed preview, persist-across-reopen.) The flow journey was a one-off
  local verification and is not committed to either repository.
- **On-canvas Blitz render in the browser — NOW LOADS (2026-07-18).** The engine
  previously fell back to `renderWebFlow: engine not loaded` because the glue was imported as
  `new URL("../bin/blitz_web.js", import.meta.url)` + `@vite-ignore` — a computed URL that 404s
  the moment Vite pre-bundles the bundle into `node_modules/.vite/deps` (`import.meta.url` moves,
  so `../bin` → `.vite/bin/…`, absent). **Fix (in this repo, mirroring
  `plugin-sheets: packages/sheet-bundle/src/engine.ts`, NO editor changes):** `engine-loader.ts` now `import("../bin/blitz_web.js")`
  (a relative specifier — tsup bundles the glue as a sibling **dist chunk** whose `import.meta.url`
  survives relocation) and hands the wasm in via the bundler's `?url` asset import
  (`import("../bin/blitz_web_bg.wasm?url")` → `glue.default({ module_or_path })`); `tsup.config.ts`
  adds `external: [/\?url$/]` so Vite resolves + serves the `_bg.wasm` relative to the served dist.
  A Node guard keeps the headless/conformance path on the honest not-loaded fallback (unchanged).
  **Verified in the real browser editor** (swapped-in local build; Chromium+WebGPU), two ways:
  (1) the flow journey logs `renderWebFlow: threaded 2 frame(s) (overset …)` — two real C-1
  SceneLayers submitted, no main-thread wasm 404, no "engine not loaded"; (2) a **pixel-diff**
  journey (a web frame with a solid-fill source → `renderWebFrame` → the deterministic CPU
  `requestSnapshot`, which composites plugin sceneLayers) shows the page **visibly changes by
  13,888 px** — the sceneLayer actually PAINTS, not just submits. That **resolves an earlier
  finding that the web render was BLANK in the editor** (submits-but-0px was a protocol-50-era compositing gap,
  since closed by the C-1 VECTOR+TEXT lanes at v0.39/v0.40). The same loader fix lights up single-
  frame `renderWebFrame` AND the flow lane. web-bundle stays 107/107 (typecheck + engine.spec
  real-wasm + conformance not-loaded all green). Fix lives in this repo's source — ships on the next
  publish; the editor consumes it with zero editor-repo change.

## Honest limitations & follow-ons

- **Mid-block split — plain text AND inline elements (2026-07-18).** A straddling paragraph
  splits at a line boundary, including paragraphs with inline elements (`text <b>bold</b> more`).
  The key: blitz collapses whitespace at inline boundaries (`</b> w` → `w`), so an offset↔DOM
  mapping by *byte* fails — but whitespace collapsing never touches non-whitespace chars, so
  `try_split` maps the split by **non-whitespace character count** (invariant across the collapse)
  to a `(text node, local offset)`, emits per-node `set_node_text` edits that empty the consumed
  prefix + truncate the straddling node, and leaves later nodes (and their `<b>`/`<span>`
  wrappers) — so the remainder keeps its inline formatting. Verified natively (a `<b>`-straddling
  paragraph splits head→A / tail→B, no loss).
- **Nested block fragmentation (2026-07-18).** A straddling CONTAINER (a `<div>`/`<ul>`/
  `<section>` with element children and no inline text of its own) no longer moves whole — it
  fragments BETWEEN its children: `plan_frame_cut` → `plan_blocks_cut` recurses (consume the fitting
  children, recurse into the straddler), so a tall list splits between `<li>`s and a nested
  `<section><ul>…</ul></section>` cuts two levels down. The container element stays put (holds the
  remainder); an emptied container self-cleans the next frame. Verified natively (a 10-item `<ul>`
  splits ~3 in A / rest in B, no loss/dup; a nested section fragments recursively) AND at the wasm
  boundary (a real-wasm `<ul>` splits between items). **Atomic by design:** replaced/atomic elements
  (`<img>`/`<svg>`/`<canvas>`/`<video>`, form controls) are excluded from recursion and move whole.
  Cosmetic caveat: a fragmented container's own box decoration (border/background/padding) is not
  yet split per-fragment — its top edge can re-render at the top of the continuation frame; content
  correctness (no loss/dup) is unaffected.
- **Table row fragmentation (2026-07-18).** A `<table>` taller than a frame splits
  BETWEEN its body `<tr>`s, and the `<thead>` REPEATS at the top of each continuation frame — for
  free from the re-resolve model: `table_body_rows` collects every `<tr>` NOT under `<thead>`, the
  cut deletes only those (the header is never consumed, so it re-renders next frame), and a straddling
  row moves whole (rows are atomic — no mid-cell split in v0). **Engine constraint worked around:**
  Taffy 0.11-exp lays out no `<tr>` box (`final_layout` is 0), so a row's band is derived from its
  CELLS' geometry (`row_band` = min cell-top … max cell-bottom); the table node + `<td>`/`<th>`
  cells ARE laid out. Verified native (a 10-row table splits between rows, HEADER on both frames,
  no loss) + wasm boundary. **Caveats:** columns re-resolve per frame, so a non-`table-layout:fixed`
  table may shift columns between fragments (content is loss-free); `<tfoot>` rows flow as body rows
  (no bottom-repeat); a row taller than a frame moves whole.
- **Fragmentation rules (2026-10-05).** `break-before`, `break-after`, `break-inside`,
  `orphans`, `widows` and `@page` margins are honoured by the cut planner: the pinned style
  engine does not compute them, so `break_rules.rs` reads them from the source CSS. A forced
  break ends the frame (inside a block that fits too, and in the last frame as overset), an
  avoid box moves whole unless it is the first thing in the frame, `break-after: avoid` pulls
  the block above along, and a line split keeps `orphans` lines behind and `widows` lines
  ahead (initial 2). A frame is a page box ([ADR 412](../adr/412-a-frame-is-a-page-box.md)).
  Three Chrome fixtures check it (`flow-break-forced`, `flow-break-avoid`,
  `flow-orphans-widows-rules`).
- **Test determinism note:** the parley/fontique shaping stack shares process state, so cargo's
  parallel test runner made the flow tests' tight geometric assertions flaky; a `#[cfg(test)]`
  `SHAPE_LOCK` serializes shaping at `render_html` + the flow render (production unaffected).
  Web-render suite is now 115/115 deterministic in parallel.
- **`flow_blocks` = the flow root's element children** (body when un-rooted), not the
  fully-general "walk by computed `display`" (fine for web-frame content). The non-flow **prune is
  now recursive** (`collect_non_flow` + `node_contains`): a `flow-into` root nested at any depth is
  kept along with its ancestor path, and everything outside that subtree is removed — no longer
  limited to a direct-`<body>`-child root.
- **CSS Regions *syntax* — `flow-into`, including MULTIPLE named flows.**
  `packages/web-model/src/css-flow.ts` parses `flow-into`/`flow-from` (Stylo ignores them); `flowSelectorFor`
  maps a flow NAME → its selector; the engine flows a named root across its frames
  (`render_web_flow_rooted` + a body prune). Recipients carry an optional `flow` name
  (`WebFlowRecipient`); `flowGroups` splits them into the primary flow (source + untagged) + each
  named flow. `bakeWebFlows` renders EVERY group — each with its own `flow-into` selector — and
  the render command uses it for any persisted flow. Verified native + real-wasm (single flow:
  `#story{flow-into:main}` excludes a sibling `<nav>`) and mock-host multi-flow (`#story`→primary,
  `#notes`→"side" group, each rendered with its own selector, all frames submitted). **Authoring:**
  `threadWebFlow` routes into the primary flow; **`threadWebFlowNamed`** routes the selection into
  the source's SECONDARY named `flow-into`; and **the source PANEL flow picker** makes an
  ARBITRARY named flow (the 3rd, 4th, …) reachable. When a web source frame + target frames are
  multi-selected, the panel's empty branch shows one button per DISTINCT declared `flow-into` name
  (`flowThreadOptions(css)` — pure, `web-model`: primary → untagged `flowName:undefined`, each
  secondary → its name), clicking threads the other selected frames into that flow via
  `threadSelectedIntoFlow(host, flowName, selection)`, plus an "Unthread selected". The stale
  "only the first named flow renders" diagnostic is corrected (all render; each is threadable).
  DOM `flow-from` regions stay unused (recipients are host frames — noted as a diagnostic).
  **BROWSER-VERIFIED (Chromium+WebGPU, swapped-in local build):** a source authored with 3 named
  flows, multi-selected with 2 targets, renders the picker with all three buttons; clicking `promo`
  (the 3rd, command-unreachable) threads both targets into it (`flow:"promo"` persisted). **Fix
  found by that journey:** clicking a panel button collapses the canvas selection, so the picker
  now acts on the selection it was RENDERED for (`selectionOverride`), not the live `host.selection`
  at click time (unit-locked: override wins over an empty live selection).
- **B2 bake to native content ([concept §5.1](../concept.md)) — BUILT.** A rendered frame (or a whole flow) flattens into
  native Paged page items (swatches + rectangles + text frames), so it exports to IDML/PDF through
  core's own export and a foreign open sees real content. **Honest v0 scope:** text runs (position +
  size + fill colour, in the document DEFAULT face — `SceneTextItem.family` is a hint core renders
  in the default font), solid axis-aligned fill rectangles, AND non-rectangular
  SINGLE-subpath fills → native paths (`insertPath`, `pathToAnchors` ScenePathSeg→PathAnchorSpec
  bezier mapping — rounded rects, decorative shapes; verified on real-Blitz border-radius output).
  Deferred (COUNTED in the plan's `deferred`, reported as a warning diagnostic, never faked):
  MULTI-subpath fills, images, strokes, gradients, shadows. Other v0 caveats: vertical text
  placement is baseline-exact when
  `host.text.measureString` is available, else estimated; a bake is multiple undo steps (the
  per-text story-resolution can't ride one batch); box decoration of a container is not re-created
  (only the solid fill rects are). The `ObjectTypeBaker.bake()` host-loop hook stays reserved — the
  bake is driven by the `bakeWebFrame` command for now.
- The engine code is a `blitz`-feature PoC lane; **zero impact on the default/bundle build**.

## Mapping to the spec & ADR-020

- **The spec** (unpublished) laid out its engine as a ten-phase roadmap; three of the phases map
  onto this lane. **Host-provided region chains** (the host, not the document's CSS, supplies the
  ordered frames) — realized (`render_web_flow` + the persisted chain). **A fragment tree with
  break tokens** — bypassed via re-resolve-remainder + a line-split, not a resumable fragment
  tree. **CSS Regions syntax** — `flow-into` built incl. MULTIPLE named flows (each rendered to
  its own frames with its own selector), plus the `threadWebFlowNamed` command for the
  secondary-flow (article+sidebar) authoring case, plus the source-panel picker for arbitrary
  named flows (>2); remaining: DOM `flow-from` regions (N/A for host frames).
- **ADR-020** — the scoped extension it recommended is built; the forked engine (rung 4) remains
  the last resort, gated on a validated need rungs 1–3 can't meet. ADR-020's 2026-07-18 addendum
  records the spike; this doc records the productization.
