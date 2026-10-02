# paged.web — HTML/CSS as a First-Class Content Type

June 2026. Concept paper. Sections describe intent; where the implementation differs, `status.md` and the ADRs in `adr/` are authoritative.

---

## 1. One-liner

> **paged.web puts live HTML/CSS on the printed page.** A new document object type — the `webFrame` — renders web content vector-true through Paged's own Vello pipeline, edits via double-click like any other content, and serializes honestly into IDML. It occupies the intersection of DTP and CSS Paged Media that no existing tool does.

---

## 2. What it is — and what it deliberately is not

**paged.web is an edit context for a foreign content model.** A `webFrame` is a frame whose content is authored as HTML/CSS and rendered live on the page canvas. Double-clicking it enters the web edit context — code editor panels plus the rendered frame *in place* — exactly as double-clicking a vector graphic enters paged.draw. On exit, the frame is an ordinary page object: transformable, layerable, exportable.

Two adjacent products hide in the phrase "HTML/CSS plugin" and are explicitly **out of scope**:

1. **A conversion bridge** (HTML→IDML import with semantic mapping to styles/stories, IDML→HTML export). Valuable, but a pipeline feature, not an edit context — a worthwhile follow-on project.
2. **CSS-driven layout for whole documents** (authoring a document *as* HTML/CSS with Paged Media rules and having Paged typeset it). The most radical interpretation — and one that would compete with Paged's own IDML-native layout engine rather than extend it.

paged.web is strictly interpretation-pure: web content *inside* a page-layout document, under the document's rules.

---

## 3. Why paged.web

### 3.1 Positioning

The domain is literally **paged.media**. CSS Paged Media — `@page` rules, margin boxes, running headers, fragmentation — is the W3C spec family for paged output from HTML/CSS. A DTP editor that treats HTML/CSS as a first-class content type sits exactly where those two worlds — page layout and CSS Paged Media — fail to meet today.

### 3.2 Platform proof

In the plugin platform strategy, paged.draw proves the platform can host a **tool**. paged.web proves it can host a **foreign document model**. These are the two existential questions for the plugin API; both should be answered with first-party scar tissue before the API v1 freeze.

### 3.3 Real workflows

1. **Web-maintained content blocks in print.** A product spec table or price list lives as HTML in a CMS, maintained by a non-DTP team; the catalog page embeds it as a `webFrame`. Content changes reflow; output stays print-resolution.
2. **Design-system-faithful artwork.** Marketing pages and print collateral share the same CSS tokens; the `webFrame` renders the *actual* component, not a redrawn imitation that drifts.
3. **Code-as-artwork.** Syntax-highlighted snippets, HTML-rendered charts and tables, web-native typographic experiments placed as page elements.
4. **Proofing web content for print.** Paste a URL or HTML fragment and see precisely how it renders and fragments on the page.
5. **Single-sourcing.** Documentation, terms, datasheets that exist once as HTML and publish to web and print without a manual conversion step.

---

## 4. Rendering Architecture

The decisive technical question is how HTML/CSS gets rendered. Three options, in ascending order of ambition:

| Option | Mechanism | Verdict |
|---|---|---|
| **O1 — Browser iframe + rasterize** | Render in a sandboxed iframe, snapshot to bitmap, place as image | Works tomorrow; print-hostile (resolution-dependent), non-deterministic ("whatever Chrome does this month"), no vector output. Acceptable only as a stopgap preview path. |
| **O2 — Server-side render** | A server renders HTML→PDF/SVG via a headless engine | **Rejected.** Breaks the local-first editing loop, couples editing and export to infrastructure, and sends document content to a server merely to draw it. Not a fallback, not an export path — rendering is a client concern, full stop. |
| **O3 — Embedded Rust engine (Blitz as client-side WASM)** | HTML/CSS engine compiled to WASM, running in the client, painting into the existing Vello pipeline | **The architecture.** |

**Principle: one engine, one place.** The Blitz/WASM engine in the client is the *single* rendering authority for `webFrame` content — canvas preview, baking, and export all run through the same engine instance on the same machine. This guarantees preview-equals-output by construction (no client/server engine drift to reconcile), keeps documents renderable fully offline, and means document content never leaves the client for rendering. A server plays no rendering role of any kind.

### 4.1 Blitz as client-side WASM

Blitz (DioxusLabs) is a modular HTML/CSS engine whose architecture reads like it was designed for Paged: **blitz-dom** handles style resolution, layout, and events using **Stylo** (Servo's CSS engine), **Taffy** (box-level flexbox/grid layout), and **Parley** (text layout); **blitz-html** adds HTML parsing via html5ever; and **blitz-paint** translates the DOM tree into draw commands for a rendering abstraction whose reference backend is **Vello**. Compiled to WASM and running entirely in the client, it is an HTML engine that already paints through our renderer's language, in Rust, without embedding a browser — and without a server in the loop.

Consequences:

- **Vector-true web frames.** HTML content enters the page as retained vector content in the Vello scene — resolution-independent, zoomable, print-grade. No other design tool renders embedded HTML this way; option O1 delivers pixels.
- **One paint pipeline.** The `webFrame` is just another scene-layer producer. Compositing, z-order, transforms, and export fall out of the existing architecture.
- **Deterministic, versionable rendering.** The engine version is pinned per document, so a file renders identically in five years — a property browsers structurally cannot offer and print workflows structurally require.

### 4.2 The honest caveats

Blitz is currently **alpha/pre-alpha**: a capable renderer, but with bugs and missing features, not yet recommended for production — and the project deliberately targets a constrained scope (HTML-and-CSS-only rendering, deferring JavaScript execution, browser-grade networking, and process isolation), aiming for production readiness during 2026. Both caveats cut in our favor more than against:

- The **CSS subset** Blitz targets (modern layout: flexbox, grid, block/inline flow — not the full historical web platform) matches what a *placed content frame* needs. Full web-platform compatibility is explicitly a non-goal: deterministic rendering of a defined, documented subset beats bug-compatible rendering of everything.
- The **no-JavaScript** stance aligns with our own v1 policy (§6): a `webFrame` is static content on a page, not an application.
- **Maturity risk is contained by contract design:** the `webFrame` contract is engine-agnostic (HTML/CSS in, scene layer out), so the engine can be swapped or upgraded behind it. WASM compilation of the Stylo-based stack needs an early feasibility spike — this is the project's primary technical risk (§10, Q1).

### 4.3 The lowering lane — status (ADR-011 Option B)

*Status note (2026-10-02): this section predates the implementation; see [ADR 403](adr/403-json-wasm-boundary.md) for the Rust/JS boundary of the engine artifact, which now ships in the bundle, and [ADR 404](adr/404-fragmentation-by-relayout.md) with [design/flow-fragmentation.md](design/flow-fragmentation.md) for fragmentation across linked frames, which is built.*

[ADR 011](adr/011-web-rendering-fork-defer-to-scenelayer.md) settled *where the paint output lands*: **lower Blitz's display list to the plugin `sceneLayer` IR (C-1), never a bespoke core paint hook.** The engine lives entirely in the plugin; core composes the submitted vector layer inside the frame under `ItemTransform` + content-box clip (already shipped, canvas-wasm v0.40+). The lowering lane that realises this contract now exists, in the plugin:

- **`packages/web-render` (Rust crate) — landed, tested.** Three pure layers + one engine-coupled layer:
  - `wire` — the C-1 `SceneLayer` IR (a faithful Rust twin of `paged_compose::scene_layer` and of `web-model`'s TS twin); its serde shape is the exact JSON the bundle submits and core deserializes (asserted by wire-JSON tests).
  - `display_list::WebDisplayList` — the captured paint, in content points, as plain data (no Blitz dep) — the boundary type.
  - `lower()` — **the deliverable**: `WebDisplayList → SceneLayer` + a coverage report, a pure total function unit-tested on hand-built display lists (no live Blitz needed to prove the mapping).
  - `capture` *(feature `blitz`)* — a `PaintScene` sink recording real Blitz paint into a `WebDisplayList`, plus `render_html` driving parse→style→layout→paint exactly like the W0 spike. End-to-end tests take the spike's flexbox-card fragment through real Blitz → capture → lower and assert the card/badge/body backgrounds emerge as C-1 `fillPath`s; a `linear-gradient` background div emerges as a C-1 `fillPathGradient`; a `conic-gradient` div emerges as a `fillPathGradient` *sweep*; an outset `box-shadow` div emerges as a C-1 `dropShadow` (and a `box-shadow` *with spread* emerges with a path strictly larger than the border box — spread is geometry blitz already inflated); and an `inset` `box-shadow` div emerges as a C-1 `innerShadow`. (The sink also maintains a blend-mode stack so a solid fill under a non-`Normal` `mix-blend-mode` layer lowers to a `fillPathBlend`, and a *gradient* fill under one lowers to a `fillPathGradientBlend` (C-1.8, v48) — both unit-tested via the `PaintScene` contract, since blitz-paint `0.3.0-alpha.4` itself only emits `Mix::Normal` *mix* layers; the same stack detects the `Compose::DestOut` layer blitz wraps an inset shadow in, recovering the inset's real colour from the padding-box fill underneath the white punch-out mask. The `stroke` sink likewise lowers a *gradient*-brushed stroke to a `strokePathGradient` (C-1.7, v48) — unit-tested via the trait + an asserted reachability test, since blitz-paint `0.3.0-alpha.4` never strokes with a gradient brush: borders are painted as *fills* with solid colours (`render.rs::draw_border`), and every `scene.stroke` site passes a solid `Color`.)
- **Bundle wiring — already in place** (`packages/web-bundle/src/bake.ts`, `packages/web-bundle/src/render-command.ts`): "Render to frame" reads the selected frame's source + geometry, calls the render contract, and — when a real layer is produced — submits it via `host.contribute.sceneLayer().submit(frameId, { items })`, gated on `host.supports("rendering.sceneLayer@1")`. Today the TS render contract (`packages/web-model/src/render.ts`) returns the honest *not-loaded* path, so nothing is faked; the seam is wired for the engine to drop in behind it.

**Covered by the lowering ("B2 vector + text + raster + gradient + blend + shadow + inset-shadow + gradient-stroke + gradient-blend"):** solid-fill rectangles (backgrounds, borders-as-rects) → `fillPath`; arbitrary solid-fill bezier paths (border-radius, non-rect boxes) → `fillPath`; solid strokes → `strokePath`; **multi-run text** — one `text` item *per* parley run (font/style/bidi-split runs each carry their own recovered string + baseline), preserving painter order; **axis-aligned raster images** → the Stage-A C-1 `image` item (straight RGBA8 + dest box, decoded by Blitz at paint; canvas-wasm v0.41+) — **no core change**; **linear & radial gradient fills** → the C-1.3 `fillPathGradient` item (canvas-wasm v0.45 / protocol v45) — endpoints resolved into content points via the effective brush transform (peniko's `transform ∘ brush_transform`), sRGB stops passed 1:1 (core linearises + offset-sorts), <2-stop / non-positive-radius gradients skipped to match core; **sweep / conic gradient fills** → the C-1.3 `fillPathGradient` *sweep* variant (canvas-wasm v0.46 / protocol v46) — centre mapped to content points, peniko's `start_angle` carried as-is (same y-down clockwise convention as core), the partial-arc `end_angle` dropped to the full-turn ramp core carries; **`mix-blend-mode` solid fills** → the C-1.4 `fillPathBlend` item (v46) — a stateful blend-mode stack mirrors blitz-paint's `push_layer`/`pop_layer`, and a solid fill under a non-`Normal` top-of-stack blend emits a blended fill with the 1:1-mapped mode (the 15 CSS modes); **outset `box-shadow`** → the C-1.5 `dropShadow` item (v46) — the rounded-rect stamp is built from the shadow rect + averaged border-radius with the offset *baked into the path* (so the item offset is 0), the Gaussian `std_dev` carried as the blur (px→pt), the colour's alpha riding as the shadow opacity; **outset `box-shadow` `spread` — already covered** (no separate wire field needed): blitz-paint inflates the border box by `spread` *before* `draw_box_shadow` (`box_shadow.rs`: `border_box.inflate(spread, spread)`), so the captured/lowered `dropShadow` path is the spread-inflated rect — spread is geometry blitz already applied, passed through faithfully (pinned by a test asserting the spread path is strictly larger than the border box); **inset `box-shadow`** → the C-1.6 `innerShadow` item (canvas-wasm v0.47 / protocol v47, core commit `dbf68d3`) — blitz paints an inset shadow as a padding-box *fill* (the shadow colour) then a `Compose::DestOut` `draw_box_shadow` with a *white* punch-out mask; the capture detects the DestOut compose, recovers the real colour from the padding-box fill (consuming it so no stray full-box fill remains), and emits one `innerShadow` with the offset *baked into the path* (item offset 0) and `choke` 0 (blitz does **not** inflate the inset rect by CSS `spread`), the colour's alpha riding as opacity, composited Normal for CSS fidelity; **gradient strokes** → the C-1.7 `strokePathGradient` item (canvas-wasm v0.48 / protocol v48, core commit `529767d`) — the gradient resolution of `fillPathGradient` on the stroke lane (linear/radial/sweep endpoints resolved into content points via the effective brush transform, the stroke width carried px→pt), <2-stop / non-positive-radius / non-positive-width strokes skipped to match core — **ready but DORMANT** for real HTML (see below: blitz-paint never strokes with a gradient brush on this alpha); **gradient `mix-blend-mode` fills** → the C-1.8 `fillPathGradientBlend` item (v48) — a gradient fill under a non-`Normal` top-of-stack blend emits the gradient + the 1:1-mapped mode (the same blend stack the solid `fillPathBlend` uses), **ready but DORMANT** like the solid blend (blitz emits only `Mix::Normal` layers). Quads are elevated to cubics; CSS px → points at capture; painter's order preserved (= core's compose order).

**Text is transform-correct.** A CSS `transform` on the inline root (translate/scale/rotate/skew — single-level, which is all blitz-paint applies today) is *folded into the painted run baseline* by the capture, so it crosses the wire correctly. The DOM run-text recovery then correlates on a **transform-invariant key** — the run's first-glyph point in the inline root's *untransformed* content-local space (the parley `offset`/`baseline` before the transform multiply) — so a transformed run's text still attaches without any transform reconstruction. The honest remaining slice: several *simultaneously*-transformed inline roots that collide on one local key (rare) — the loser stays empty (skipped), never faked or misattached.

**Deliberately deferred — the honest ceiling (C-1's open stages / Tier-B), every dropped primitive *counted and reported* by the lowering, never faked:**
- **gradient *strokes* are now *covered*** (→ C-1.7 `strokePathGradient`, v48) but **DORMANT** for real HTML — the lowering is contract-correct + unit-tested, yet blitz-paint `0.3.0-alpha.4` never calls `PaintScene::stroke` with a gradient brush: CSS borders are painted as *fills* (`render.rs::draw_border` → `scene.fill` with a solid colour; `border-image` gradient borders aren't implemented), and every other `scene.stroke` site (text underline/strikethrough, form-control frames, devtools overlay) passes a solid `Color`. So a gradient-stroke lane lights up the day a gradient-stroke *producer* (or a Blitz that emits gradient borders) appears (pinned by a reachability test that asserts the current zero-capture reality);
- rotated / sheared *image* dests (the Stage-A `image` item carries an axis-aligned box only — no per-image transform on the wire yet — so a transformed image dest is counted as an unsupported paint, not faked);
- gradient `transform`/spread-mode edge cases beyond the endpoint/centre mapping (anisotropic-ellipse radials collapse to a single radius — the honest C-1.3 single-radius shape; a conic's partial-arc `end_angle` and `repeat`/`reflect` spread aren't carried — the sweep collapses to a full-turn ramp);
- **inset `box-shadow` CSS `spread` *beyond* the offset** (inset shadows themselves are now **covered** → C-1.6 `innerShadow`, v47): blitz-paint bakes the inset *offset* into the rect but does **not** inflate it by `spread` (`box_shadow.rs::draw_inset_box_shadow` passes `border_box` un-inflated), so an inset shadow renders at its offset while its spread is the honest follow-on — the lowering passes `choke: 0` rather than fake a spread blitz didn't apply (the `choke`-vs-baked-rect distinction is core's inset-spread control, available the day a spread is baked in). *Outset* spread, by contrast, **is** covered (blitz inflates the rect — see the covered list);
- **gradient *fills* inside a `mix-blend-mode` layer are now *covered*** (→ C-1.8 `fillPathGradientBlend`, v48) but **DORMANT** for real HTML on the same engine gap as the solid blend (below); **image fills / glyph runs inside a blend layer stay deferred** (the C-1 wire has no blended-image/text lane — such a primitive stays its plain item, with the blend the honest follow-on);
- **engine-side capture gap for `mix-blend-mode`:** blitz-paint `0.3.0-alpha.4` only ever pushes `Mix::Normal` layers (opacity/clip) — it has *no* `mix-blend-mode` → non-`Normal` `push_layer` path — so a real-HTML `mix-blend-mode` does not yet *reach* the (contract-correct, unit-tested) blend captures — **neither the solid `fillPathBlend` nor the v48 gradient `fillPathGradientBlend`**; both light up the moment blitz-paint emits non-Normal *mix* layers (pinned by a test that asserts the current reality). Conic gradients, outset `box-shadow` (including with `spread`), and **inset `box-shadow`** **do** reach the capture from real Blitz HTML today — end-to-end native tests prove each (the inset test asserts the div lowers to `innerShadow`; the spread test asserts the shadow path is larger than the border box). Gradient *strokes* (v48) are the same shape of dormancy on a *different* gap — blitz never strokes with a gradient brush (above);
- CSS fragmentation across linked frames (§9 Tier B — the killer feature, its own phase).

**The named next slice — the Blitz wasm artifact.** The lowering + capture compile + run today on **native** (the spike already proved the same stack compiles + paints on wasm32), with multi-run transform-correct text recovery and raster-image capture already wired (the capture has the geometry *and* the recovered characters). What remains is the bundle **wasm artifact**: build `web-render --features blitz` to `wasm32-unknown-unknown` + `wasm-bindgen` into the manifest's `bin/blitz_web.wasm` (the `scripts/build-wasm.sh --engine` mode), and register pinned faces so text shapes on wasm (the spike's 22-vs-19 glyph-run delta / W1 font-parity task). Integration point: `capture::render_html` → `lower::lower`, exposed to JS as `render_web_frame(html, w, h) → JSON`. Until that artifact ships, the bundle stays on the not-loaded path — the source-lane preview remains the only preview, stated honestly in the UI.

---

## 5. Document Model & Baking

*Status note (2026-10-02): this section predates the implementation; see [ADR 406](adr/406-web-frame-and-source-storage.md) (how the source is stored) and [ADR 407](adr/407-baking-flattens-to-native-items.md) (how baking was built).*

paged.web follows the platform's fidelity doctrine: **source of truth in namespaced metadata, baked IDML fallback always present.** Documents must never become unreadable without their plugins; the boundary between native and extended content is always visible to the user.

```
<Rectangle>                          (the frame — ordinary IDML)
  x-paged-web:source   = HTML + CSS, or transform script + data bindings (+ asset manifest)
  x-paged-web:engine   = blitz@<pinned>, boa@<pinned>, viewport, base font size
  x-paged-web:options  = overflow policy, media (print/screen), DPI for raster fallbacks
  [baked content]      = rendered scene exported as IDML constructs
</Rectangle>
```

### 5.1 Baking level decision

What does InDesign see when it opens the file? Three candidate levels:

| Level | Baked form | Assessment |
|---|---|---|
| **B1 — Raster** | High-res image of the rendered frame | Safe, dumb, print-fragile. Fallback of last resort only (e.g. for raster images embedded inside the HTML). |
| **B2 — Vector + text frames** | Rendered scene converted to IDML: text runs as text frames (or outlines where fonts are unavailable), boxes/borders/backgrounds as rectangles and paths, images as placed images | **Chosen default.** Faithful at the rendered size, and it degrades into something an InDesign user can still touch and correct manually. |
| **B3 — Semantic mapping** | HTML elements mapped to IDML stories, paragraph/character styles, tables | That is the conversion-bridge product (§2), not a baking strategy — lossy in both directions, separate project. |

B2 keeps the promise: re-opening in Paged restores the live HTML/CSS construct; opening anywhere else yields editable, faithful IDML.

---

## 6. JavaScript: Generation Yes, Page Scripts No

The JavaScript question splits into two roles with opposite answers.

### 6.1 Page JavaScript — never

Rendered `webFrame` content does not execute scripts. No event handlers, no animation, no interactivity. This is a product stance, not merely an engine limitation: pages don't run scripts, print is the target medium, and determinism is the selling point.

### 6.2 Generation JavaScript — first-class, powered by core Boa

*Status note (2026-10-02): this section predates the implementation; see [ADR 408](adr/408-no-page-javascript.md) (what ships is a closed template pass, not a script transform).*

Paged's core already embeds **Boa**, the Rust JavaScript engine, in its WASM layer. This changes the economics of content generation entirely: HTML doesn't have to be hand-authored — it can be *produced* by a transform script running in the core's Boa engine before rendering.

```
(template script, bound data) ──Boa──▶ document tree ──Blitz──▶ layout ──Vello──▶ page
        │                                  ▲
        └── document variables, datasets ──┘        all inside one client-side WASM lane
```

Why the Boa + Blitz pairing is unusually strong:

- **One binary, no boundary.** Both engines are pure Rust in the same WASM module. A transform can construct the content tree directly against blitz-dom rather than emitting HTML strings for re-parsing — script → DOM → layout → paint without leaving the lane.
- **Subtractive sandbox.** Boa's core implements the ECMAScript language only; runtime capabilities (fetch, timers) are opt-in registrations that we simply don't make. No ambient I/O exists to escape through.
- **Pinned determinism.** `boa@x.y` is pinned in frame metadata alongside `blitz@x.y`. With no I/O, frozen/seeded clock and randomness, a transform is a **pure function of (template, data, engine versions)** — the render stays reproducible across machines and years.

### 6.3 Reactive web frames

Because the transform is pure, a `webFrame` becomes a *derived computation* in the editor's salsa-based incremental pipeline. Bound document variables and datasets are tracked dependencies: when `{{price}}` changes, the frame invalidates, the transform re-runs, Blitz re-renders, the page updates. Data-driven publishing — the EasyCatalog-shaped use case of generated price tables, spec sheets, and per-record content blocks — falls out of existing incremental architecture rather than requiring special machinery. Combined with fragmentation across linked frames (§9, Tier B), this is the foundation of catalog automation.

### 6.4 Data binding surface

The host exposes a read-only binding context into the Boa transform: document variables, named datasets (inline JSON; external sources fetched at edit time and embedded per §7), frame geometry (for width-aware generation), and document metadata. Templates can be plain template-literal JS, or authors can bundle a JS template engine of their choice — it's a conformant ES engine, so Handlebars-class libraries run as ordinary scripts.

---

## 7. Assets, Fonts, Network

- **Fonts:** resolve against the host's font system first — one font pipeline for the entire document, the same argument that keeps typography out of paged.draw. `@font-face` sources are fetched once at edit time, then embedded into the document's asset store. No render-time network dependency.
- **Images and resources:** same policy — fetch at import/edit time, embed, render offline thereafter. **A document must render with zero network access.**
- **Network capability:** fetching external URLs requires the manifest-declared `network` capability with install-time user consent. Paste-a-URL workflows surface this explicitly.

---

## 8. Edit Context UX

Entering a `webFrame` swaps the shell into a split working set — all declared via the platform's declarative panel schema, rendered by the host from the editor's UI kit:

- **`codeEditor` panels** for HTML and CSS — a new first-class host widget (§9.1) with syntax highlighting themed from the styleguide, line numbers, folding, and a diagnostics channel (parse errors, unsupported-property warnings from the engine's compatibility table).
- **Live canvas preview** — the frame itself re-renders on a debounced edit loop. This *is* the page canvas, not a detached preview: the content is seen in its final context, at its final size, beside its final neighbors.
- **Inspector panel** — click-to-inspect: selecting a rendered element highlights its source range and shows the computed box. (The host hit-testing service operating on a foreign content tree — a deliberate stress test.)
- **Frame options panel** — viewport strategy (fixed width / track frame width), media type (`print`/`screen`), overflow policy (clip / grow frame / paginate-later), pinned engine version.
- **Standard context mechanics** — double-click entry, `Esc`/breadcrumb exit, write access scoped to the frame, edits in the single shared undo history — inherited from the platform's edit-context model unchanged.

---

## 9. Capability Specification

*Status note (2026-10-02): this section predates the implementation; see [ADR 404](adr/404-fragmentation-by-relayout.md) and [design/flow-fragmentation.md](design/flow-fragmentation.md) (fragmentation across frames, listed below as Tier B, is built) and [ADR 408](adr/408-no-page-javascript.md) (pre-render templating).*

Tiers follow the platform convention: **A** = v1, rendered live and baked to B2 IDML · **B** = later phase · **D** = deliberately excluded.

| Capability | Tier | Notes |
|---|---|---|
| HTML5 document fragments (semantic elements, lists, tables, images) | **A** | Core v1. |
| CSS: block/inline flow, flexbox, grid, positioning, borders, backgrounds | **A** | The Blitz/Stylo/Taffy subset; a **published compatibility table** is part of the docs deliverable and the diagnostics source. |
| Web fonts via host font pipeline + embedded `@font-face` | **A** | |
| Raster images (embedded), SVG images (rendered as vectors) | **A** | SVG-in-HTML routes through the same vector path — no rasterization. |
| Gradients, 2D transforms, opacity, blend modes, shadows | **A/B** | Per-property mapping to the C-1 scene layer; compatibility table governs. **Linear, radial & sweep/conic gradient fills are A** (lowered to the C-1.3 `fillPathGradient` — linear/radial canvas-wasm v0.45, sweep v0.46/protocol v46); **`mix-blend-mode` solid fills are A** (C-1.4 `fillPathBlend`, v46); **outset `box-shadow` is A** (C-1.5 `dropShadow`, v46) — **including `spread`** (blitz inflates the rect; passed through faithfully); **inset `box-shadow` is A** (C-1.6 `innerShadow`, v47); **gradient *strokes* are A on the wire** (C-1.7 `strokePathGradient`, v48) and **gradient `mix-blend-mode` fills are A on the wire** (C-1.8 `fillPathGradientBlend`, v48) — both lowerings are contract-correct + unit-tested but **DORMANT** for real HTML (see below). Inset CSS `spread` *beyond* the baked offset, and *image* fills / *glyph runs* *inside* a blend layer, stay B (no C-1 equivalent / not baked by blitz — reported, not faked). Engine caveat: blitz-paint `0.3.0-alpha.4` doesn't yet emit `mix-blend-mode` as a non-`Normal` *mix* layer (so the `fillPathBlend` *and* `fillPathGradientBlend` captures are unit-tested via the `PaintScene` contract until the alpha gains the path), and never strokes with a gradient brush (borders are fills, decorations/outlines solid — so the gradient-stroke capture is likewise trait-tested + reachability-pinned); outset/inset shadows and gradient/solid *fills* reach the capture from real HTML today. |
| CSS variables / design tokens | **A** | Essential for the design-system use case (§3.3, case 2). |
| `@media print` and `print`/`screen` switching | **A** | DTP-native requirement. |
| **Fragmentation across frames** — one HTML flow threading through multiple linked frames with CSS Paged Media semantics | **B** | The killer feature and the hardest one: requires engine-level fragmentation hooks. Phase 2, explicitly — this is what makes paged.web a publishing tool rather than an embed widget. |
| **Boa pre-render transforms** — templating and data binding via the core JS engine (§6.2) | **A/B** | Promoted: the engine ships in core regardless, so marginal cost collapsed. v1 ships static + variable-bound frames; full dataset-driven generation and reactive invalidation (§6.3) complete in phase 2. |
| URL import (fetch page → editable local snapshot) | **B** | Network capability + readability-style extraction policy. |
| Live URL embedding (renders remote content at document-open time) | **D** | Violates determinism and offline rendering. Snapshot-on-import only. |
| Page JavaScript execution, animation, interactivity | **D** | Product stance (§6.1). |
| Full web-platform compatibility (legacy CSS, quirks modes) | **D** | The deterministic subset *is* the feature. |

---

## 9.1 What paged.web Forces on the Plugin Platform

Each item is API surface that paged.draw alone would not have proven — the second half of the platform's existential test:

1. **`codeEditor` host widget.** First-class, host-rendered, styleguide-themed, with declared language and a diagnostics binding. Without it, the first scripting-adjacent third-party plugin hacks around the panel schema's `customCanvas` escape hatch.
2. **Plugin-defined object types, formalized.** paged.draw edits constructs IDML already has; paged.web *registers a new content type* (`webFrame`) under the metadata-plus-baked-fallback contract. The registration API (`contributes.objectTypes`) moves from concept to specification.
3. **A plugin WASM lane.** An HTML engine is orders of magnitude more code than panel logic. The packaging model must support a WASM module alongside the JS control-plane entry point (run on the host's **Boa** engine — see §7 open question on one-engine-or-two) — plugin = manifest + JS (control plane) + optional WASM (data plane) — with the platform's per-plugin frame-budget rules applying to both.
4. **Diagnostics channel.** Errors and warnings flowing from plugin to host UI (editor gutter, problems list) — a generic facility every serious plugin will want.
5. **Asset store access.** A capability-gated API for plugins to embed fetched resources (fonts, images) into the document's asset store.
6. **Hit-testing on foreign trees.** Click-to-inspect requires plugins to register their own hit-test geometry for content the host didn't lay out.

---

## 10. Roadmap & Open Questions

*Status note (2026-10-02): this section predates the implementation; see [ADR 401](adr/401-layout-engine-pinned.md) (engine pin), [ADR 403](adr/403-json-wasm-boundary.md) (the engine's WASM boundary), [ADR 407](adr/407-baking-flattens-to-native-items.md) (baking), [ADR 408](adr/408-no-page-javascript.md) (templating), and [ADR 404](adr/404-fragmentation-by-relayout.md) with [design/flow-fragmentation.md](design/flow-fragmentation.md) (fragmentation across linked frames).*

### Phasing

| Phase | Milestone | Exit criterion |
|---|---|---|
| **W0** *(early, parallel to platform work)* | **Blitz/WASM feasibility spike** — compile the Stylo/Taffy/Parley stack to WASM; paint a static HTML fragment through Vello inside the editor | Go/no-go on the embedded-engine bet; if no-go, fallback decision (O1 iframe stopgap vs. wait for engine maturity — server rendering is not an option) documented with binary-size and performance numbers |
| **W1** | `webFrame` object type + code-editor context + frame options; A-tier CSS subset; compatibility table published | A web frame is created, edited, transformed, and exported like any page object |
| **W2** | B2 baking pipeline | Web frame survives full IDML round-trip; InDesign opens the baked form correctly (text frames editable, geometry faithful) |
| **W3** | Fonts/assets embedding; offline-render guarantee; URL import behind network capability; **variable-bound transforms** (document variables → Boa → frame, with salsa-tracked invalidation) | Document renders with network disabled; changing a bound variable updates the frame incrementally |
| **W4** | Fragmentation across linked frames; full dataset-driven generation | One HTML flow threads across pages with CSS Paged Media semantics; a record set generates a paginated, data-driven section |

### Open questions

1. **Blitz/WASM feasibility** — can the Stylo-based stack compile to WASM at acceptable binary size and performance? Primary technical risk; W0 exists to answer it before anything else is committed.
2. **API freeze sequencing** — the platform requirements in §9.1 argue for landing paged.web's API surface *before* the plugin API v1 freeze, but paged.web v1 ships after it. Decide: freeze includes the surface proven by the W0 spike, or the freeze waits for W1.
3. **Engine version pinning policy** — per-document pinned `blitz@x.y` + `boa@x.y` implies shipping multiple engine versions over time. Bundle strategy (lazy-loaded WASM per version?) and a deprecation horizon need definition.
4. **Frame-width coupling** — when a `webFrame` tracks its frame width, resizing re-runs layout (and width-aware transforms, §6.4). Interaction cost during drag-resize: live reflow as a Gesture vs. commit-on-release.
5. **Compatibility-table governance** — the supported CSS subset will grow with the engine. Per-document behavior when a file uses properties its pinned engine lacks: hard error, warning + best-effort, or forced engine upgrade prompt?
6. **Baked-text font policy** — B2 bakes text as text frames where fonts resolve, outlines where they don't. Define the threshold and make the choice visible in the UI.
7. **One JS engine or two** — with Boa in core, does the plugin control plane (historically QuickJS) unify onto Boa? Two ES engines in one binary is hard to justify long-term; unification would mean one sandbox model, one binding layer, and one engine to pin — but the plugin runtime's isolation and budget mechanics must carry over intact. Decide before the plugin API v1 freeze, since it shapes the manifest's runtime contract.
8. **Transform resource limits** — a transform is pure but can still loop forever or allocate unboundedly. Define instruction/time and memory budgets for Boa transform runs, and the UX when a frame's transform is killed (error placeholder + diagnostics, never a hung editor).

---

## 11. Summary

*Status note (2026-10-02): this section predates the implementation; see [design/flow-fragmentation.md](design/flow-fragmentation.md) (fragmentation across linked frames, described below as deferred, is built).*

paged.web turns a slogan — "the web on the printed page" — into a contract: HTML/CSS authored or *generated* in place, rendered as resolution-independent vectors through the same Vello pipeline as everything else, pinned to deterministic engine versions (Blitz for rendering, core Boa for generation), and serialized into IDML that any InDesign user can open and touch. Generation is a pure function of template and data, which makes web frames reactive derived values in the editor's incremental pipeline — data-driven publishing as a property of the architecture, not a bolted-on feature. It deliberately renders a documented subset instead of chasing browser parity, deliberately excludes page scripting while embracing generation scripting, and deliberately defers its hardest rendering feature — CSS Paged Media fragmentation across linked frames — to a phase of its own. And as the second first-party plugin, it completes the platform's existential test: where paged.draw proved Paged can host a tool, paged.web proves it can host a foreign document model.

**paged.web speaks both web and print — and writes its own pages from data.**