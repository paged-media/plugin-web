# paged-web engine spec — evaluation & reconciliation

**2026-07-18 · evaluation memo · feeds [ADR-020](../adr/020-paged-web-native-engine-defer-frame-threading.md)**

Evaluates an internal proposal for a native HTML/CSS engine in the core (dated 2026-07-18,
unpublished; "the spec" below) against the
web-rendering direction the project **already ratified and shipped**. The spec is a
strong, standards-serious design — but it re-opens a settled decision without citing it,
and conflates two independent questions. This memo separates them, weighs each on the
evidence, and recommends. Code facts (versions, protocol numbers, dependencies) are as of
the memo's date; what was built afterwards is recorded in
[flow-fragmentation.md](flow-fragmentation.md).

**Bottom line:** keep the shipped SceneLayer lowering lane (ADR-011); do **not** build the
native forked engine now. The spec's one genuinely-new idea — CSS-Regions fragmentation of
one HTML flow across multiple frames — is real and worth pursuing, but it belongs as a
*scoped extension of the existing lane*, gated on a feasibility spike, not as a new
core-sibling engine. Escalate to the forked engine only on spike evidence — which is
exactly ADR-011's own escape clause.

---

## 1. What the spec proposes

A new **native forked HTML/CSS engine**, `paged-web`, as a **core sibling** (`paged-media/
web`, 14 crates): selectively **fork Blitz** (Stylo/Taffy/Parley + box/anonymous-box/table
code) into `paged`-owned crates behind adapters; a **three-tree architecture** (semantic /
box / **fragment**); **CSS Regions** + frame threading as the pagination primitive; paint
**directly to `paged-compose::DisplayList`**, **replacing AnyRender** and **replacing the
Vello/wgpu backends with `paged-gpu`**. Thesis: *"a publication renderer that happens
to understand HTML and CSS, not a browser engine embedded in an editor,"* converging IDML
threaded frames and CSS Regions on one shared flow concept.

## 2. What is already decided and shipped

The spec does not mention any of this. It is the load-bearing context.

- **[ADR-011](../adr/011-web-rendering-fork-defer-to-scenelayer.md) (ratified
  2026-06-12)** chose the opposite of a core engine: run Blitz as a **plugin-side WASM
  engine**, capture its display list, and **lower it to core's C-1 `SceneLayer`** — *"NOT a
  bespoke core paint hook; the engine lives entirely in the plugin, behind the platform
  boundary"* (`packages/web-render/src/lib.rs`). It explicitly weighed and
  **rejected Option A** (a core paint hook), keeping it only as *"the fallback if C-1
  lowering proves infeasible… revisit only on that evidence."* Its addendum explicitly says
  **do NOT fork Blitz** to force features ("the alpha engine's bugs become our bugs").
- **[ADR-013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md)** shipped the C-1 seam: plugins render
  inside a frame by submitting a display-list subset core lowers at compose time (v0.39
  vector, v0.40 text). **[ADR-018](https://github.com/paged-media/core/blob/main/docs/adr/018-stage-b-gpu-texture-defer-record-only.md)**
  governs the raw-GPU-texture escape hatch (record-only until Vello has an external-texture
  path).
- **It is running.** `CLAUDE.md`: *"On-canvas rendering NOW SHIPS (ADR-011
  Option B), but stays honest."* `web-render` is a real Rust crate compiled to
  `bin/blitz_web*.wasm`; the bundle submits a real `SceneLayer` via
  `host.contribute.sceneLayer()`; when the engine can't load it falls back to the sandboxed
  source-lane preview — *"never a fake render."* The C-1 IR grew across **five protocol
  bumps (v43→v48)**; wire `PROTOCOL_VERSION = 51` at the time of writing
  (`core: crates/paged-canvas/src/channel.rs`). Visible today: rects, strokes,
  transform-correct multi-run text, images, linear/radial/**conic** gradients, drop+inset
  shadows. Blend/gradient-stroke family is built-but-dormant on a Blitz upstream gap
  (accept-dormant, ADR-011 addendum).

## 3. Two axes, not one

The spec bundles two separable decisions. Keeping them fused is the source of the conflict.

| Axis | Question | Status |
|---|---|---|
| **Paint target** | Where does Blitz's paint land — core `DisplayList` (spec) or plugin `SceneLayer` (shipped)? | **Settled** by ADR-011/013; shipped. |
| **Fragmentation** | Can one HTML flow be threaded across N frames with per-frame re-line-breaking (CSS Regions ↔ IDML stories)? | **Genuinely open**; no path exists. |

Capability × approach:

| Capability | Option B — shipped (SceneLayer) | Spec — native fork (DisplayList) |
|---|---|---|
| One HTML frame → on-canvas vectors | **Yes, today** | Yes (re-implements) |
| Colour-managed / print-correct / CPU-testable | **Yes** — lowers to the same `DisplayCommand`s, *"same Vello and tiny-skia lanes as native content"* (`core: crates/paged-compose/src/scene_layer.rs`) | Yes (by owning the pipeline) |
| Shares core's Vello/wgpu instance | **Yes** — `anyrender_vello 0.11` pins `vello ^0.9 + wgpu ^29` = *exactly core's versions* (`packages/web-model/src/engine.ts`) | Yes (replaces the backends) |
| Blitz isolated behind plugin boundary | **Yes** | **No** — welds an alpha engine into core |
| **Fragmentation across linked frames** | **No** — single viewport (§4/§5 below) | **Yes** — the three-tree design's reason to exist |

## 4. Where the spec re-litigates a settled question (paint target)

The spec's "paint to `DisplayList`, replace AnyRender + Vello backends" reopens ADR-011's
paint-target decision — and ADR-011's reasoning not only still holds, it has **strengthened**:

- **The claimed benefits already exist across the boundary.** The spec motivates the direct
  `DisplayList` path with print-fidelity, ICC, and headless-CPU testability.
  The C-1 lane already delivers all three: `core: crates/paged-compose/src/scene_layer.rs` lowers to ordinary
  `DisplayCommand`s and renders through *"the same Vello (GPU) and tiny-skia (CPU) lanes as
  native content — so it is colour-managed, print-correct, and unit-testable on the CPU lane
  without a GPU."* Replacing the backends buys nothing here.
- **"Replace Vello with paged-gpu" is a non-need.** The W0 spike (the engine feasibility
  spike, [concept §10](../concept.md)) measured that the Blitz
  stack's `anyrender_vello` pins core's exact `vello ^0.9 + wgpu ^29` (`packages/web-model/src/engine.ts`); a
  shared instance is already available. The replacement is cost without a corresponding gain.
- **Welding an alpha engine into core is the trap ADR-011 ("Why B" #4) names.** A pre-alpha
  (`blitz 0.3.0-alpha.4`) engine's *"bugs become core's bugs and its version becomes core's
  version."* The whole point of the engine-agnostic contract (*"HTML/CSS in, scene layer
  out"*) is to keep it swappable behind the plugin boundary. ADR-018 shows the trust line is
  being pushed *away* from core paint hooks, not toward them.

**Cost ledger of the fork, beyond re-litigation:**

- **A second font/shaping stack.** Core shapes with **rustybuzz + ttf-parser** (in
  `paged-text`/`paged-renderer`/`paged-canvas`); there is no shared `paged-font`/`paged-shape`
  foundation. A Blitz engine brings **Parley + swash/skrifa** — a parallel stack. The spec
  acknowledges this and defers convergence to **Phase 8** of its ten-phase roadmap, i.e. the duplication ships
  first and is paid down last.
- **Edition skew.** Core is `edition 2021` (`rust-version 1.80`, though the toolchain is
  pinned `1.94.1`, so MSRV is a non-issue); the Blitz/Stylo tree targets **edition 2024**.
  The `core: spikes/blitz-wasm` spike is deliberately kept *out* of the workspace `Cargo.lock`
  for exactly this skew. Bringing 14 crates in-workspace makes the skew a standing tax.
- **Footprint & ship date.** 14 new crates, Phases 0–9, forking a third-party pre-alpha —
  against a v1 that ships *no* web rendering as a hard requirement (ADR-011 §"Why B" #1).

## 5. What is genuinely net-new (fragmentation)

The spec is **not** redundant on one axis. Its three-tree model exists to do the thing
Option B cannot: **fragment one flow across many frames**.

- Option B is single-viewport by construction: `render_web_frame(html, width_px, height_px)
  -> SceneLayer` (`packages/web-render/src/lib.rs`). One HTML, one content box, one layer. No flow
  chain, no break tokens, no re-line-breaking at a second frame's width.
- The gap is **already tracked as the shipped lane's own honest ceiling.** `packages/web-render/src/lib.rs`,
  "Deferred… never faked": *"…and **CSS fragmentation across linked frames**."* The
  spec's headline capability is literally the next deferred item on the existing lane's list
  — not a new frontier that needs a new engine to reach.
- It aligns with the product thesis. IDML already threads a story through linked text frames
  (`paged-scene::frame_chain`); the spec's CSS Regions ↔ threaded-frame convergence
  is the "unify print + web publishing" goal expressed in the one place the two models
  genuinely rhyme. This is the part of the spec worth banking.

## 6. The feasibility risk (why a spike, not a leap)

The honest catch: fragmentation may not be cheaply bolt-on-able onto Blitz-as-a-black-box.

- The spec is right that it **cannot** be faked by clip-slicing a tall layout:
  variable-width frames must **re-line-break** per fragmentainer. That requires driving
  Blitz's **box/layout stage per fragmentainer and resuming it** with a break token — an
  interception point Blitz (which paints one fully-laid-out document) may not expose.
- So the decision splits on one unknown: **can Blitz's layout be resumed per-frame to emit
  one `SceneLayer` per frame without a deep fork?**
  - **If yes** → a *scoped extension* of the shipped lane: `render_web_frame` →
    `render_web_flow(html, [frame geometries]) -> [SceneLayer]`, plus a flow/region model.
    Small, additive, no core engine.
  - **If no** — if honest fragmentation demands owning the box/layout/fragment trees — then
    the spec's three-tree engine becomes the *justified* escalation, and this is precisely
    the *"C-1 lowering proves infeasible… revisit only on that evidence"* trigger ADR-011
    already wrote. The escalation is pre-authorized; it just needs the evidence.

**Recommendation: a timeboxed W-frag spike** (analogous to W0) that answers exactly that
question before any engine-scale commitment.

**Update (2026-07-18, post-reconnaissance — recorded in the internal spike log):** the
above binary is too coarse. Probing the pinned stack showed the answer is a **four-rung
ladder**, because **Parley 0.9 already ships a resumable, variable-width, height-aware line
breaker** (`break_lines()`/`BreakLines`/`MaxHeightExceeded`) that Blitz uses internally for
floats — it's just below the `BaseDocument`/`resolve` API. So between "scoped extension" and
"forked engine" sits a **medium rung: own the block-flow layer on top of Parley + Blitz's box
tree, with *no* Blitz/Taffy source fork** (≈ the spec's proposed `paged-web-fragment`/`-inline`
crates, reusing rather than forking). The spike's job is to find how far up the ladder the real use cases need
to go; the full three-tree engine is only rung 4. The ladder, with what was built on each rung,
is in [flow-fragmentation.md](flow-fragmentation.md).

**Update (2026-07-18, spike EXECUTED):** rungs 1 (equal-width) and 2 (variable-width,
block-granular) are **built + green** in `packages/web-render/src/flow.rs` (behind
`blitz`, zero impact on the shipped build) — variable-width threading works through the pinned
`BaseDocument`/`DocumentMutator` API with **no engine fork**. Rung 3 (line-granular) is
design-validated, not run. The forked engine (rung 4) is now empirically the last resort.

## 7. Answering the framing: "should be in core / implications for plugin-web"

The spec's premise — *a project that should be in `core/`* — is only partly right.

- **The engine does not belong in core.** ADR-011/013/018 place it behind the plugin
  boundary; §4 above is why that still holds. It stays in **plugin-web** (`packages/web-render`).
- **What belongs in core is only the shared seam.** Today that is the `SceneLayer` /
  `DisplayList` IR — already there. **If** fragmentation lands, one more thing becomes a core
  (or a new `paged-publication`) concept: a **renderer-neutral flow model** — `FlowId` +
  region-chain order + overset — because **IDML stories and HTML flows must share it**.
  That is one of the spec's own open questions (`FlowId` in `paged-canvas` vs a new
  `paged-publication` crate vs `paged-scene`), and it is the single genuinely core-resident
  question the spec raises. Everything else the spec puts "in core" (the 14 engine crates)
  should stay in the plugin.

## 8. Recommendation

1. **Keep Option B (SceneLayer lowering) as the paint path.** No change; ADR-011 stands.
2. **Adopt the net-new idea as a scoped extension of that lane**, not a new engine:
   per-frame flow fragmentation emitting one `SceneLayer` per frame, coordinated by a
   renderer-neutral `FlowId`/region model shared with IDML stories.
3. **Gate it on a W-frag feasibility spike.** Yes → scoped extension. No → the spec's
   forked engine is the authorized escalation (ADR-011's own trigger).
4. **Resolve `FlowId` placement (§7)** as the one core-resident decision, when (3)
   passes.
5. **Keep the full spec as the long-horizon north star.** Its three-tree model,
   `paged-font`/`paged-shape` convergence, and WPT harness are the reference design *for the
   escalation case*. Fold its open questions into the existing planning system rather
   than standing up a parallel one.

**Trigger to revisit the forked engine:** the W-frag spike shows resumable per-fragmentainer
layout is infeasible without owning the box/layout trees, **or** a validated user need for
fragmentation-heavy web content hits the C-1 lane's ceiling in a way the texture escape
hatch (ADR-018) can't cover. Absent that evidence, the fork is cost without a decided need.

This lands in [ADR-020](../adr/020-paged-web-native-engine-defer-frame-threading.md).

## 9. Future signal — WICG `html-in-canvas` (watch, don't act)

`https://github.com/WICG/html-in-canvas` (`layoutsubtree` + `drawElementImage()` / WebGPU
`copyElementImageToTexture()`) lets the **real browser engine** lay out + paint live HTML and
composite the result into a canvas (2D/WebGL/WebGPU/OffscreenCanvas). Tempting — best-possible
fidelity, no engine to maintain, WebGPU-native. But it is a **screen-preview-only** path and
changes nothing here:

- **Not deterministic / not headless / one-engine-behind-a-flag** — Chromium-only behind
  `chrome://flags/#canvas-draw-element`. Cannot run in `paged-run`, the CI fidelity gate, or
  headless PDF export — all hard `paged` requirements.
- **Raster, not vector** — yields a texture/ImageBitmap: exactly the *"rasterize HTML into a
  texture"* default that the spec and the concept paper's option **O1**
  ([concept §4](../concept.md)) reject as print-hostile. No
  display-list, no glyph runs for real-text PDF, no ICC/CMYK/spot/overprint.
- **No CSS Regions / fragmentation** — draws one element's border box (overflow clips).
  Nothing on the net-new axis.
- Security filtering strips subpixel AA / cross-origin / system colours (fidelity caveats).

**Verdict:** a candidate future replacement for the **O1 iframe *preview*** (higher fidelity,
WebGPU-native, same-origin) — **not** the render/export lane, and no substitute for either the
SceneLayer lane or the fragmentation work. Watch its standardization + multi-engine adoption.
