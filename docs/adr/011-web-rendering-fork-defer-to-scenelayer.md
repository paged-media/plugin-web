# ADR 011 — paged.web rendering: freeze the source lane for v1, lower via SceneLayer when rendering lands

**2026-06-12 · decision record · status: RATIFIED 2026-06-12 (the
web-rendering fork).
Direction confirmed: source lane frozen for v1; the Blitz lane lands
post-freeze through the plugin `sceneLayer`, never a
core paint hook.**

**Sources:** the original design spec for paged.web, §4 (Rendering
Architecture — O1/O2/O3, "one engine, one place"), §4.1 (Blitz =
blitz-dom/Stylo/Taffy/Parley + blitz-paint → Vello), §4.2 (alpha caveats,
contract is engine-agnostic: "HTML/CSS in, scene layer out"), §10 Q1 (the
WASM-feasibility spike = primary technical risk); `BREAKAGE_LOG.md`
**W-01** (W0 spike DONE/GO 2026-06-06: the Blitz stack `=0.3.0-alpha.4` +
Stylo 0.17 compiles AND paints on wasm32; `anyrender_vello 0.11` pins
vello ^0.9 + wgpu ^29 = **exactly core's versions**, so the engine paints
into the shared instance; brotli'd 2.20 MB; re-layout+repaint 58 µs/frame;
**REMAINING: a real `anyrender_vello`-backed webFrame paint hook in the
canvas**); `README.md` (v0 = the source lane; the panel preview
is the O1 stopgap); the internal gap register, **C-1** (in-frame
`sceneLayer` — VECTOR DONE v0.39.0, TEXT v0.40.0: a plugin submits
filled/stroked paths + single-line text runs, core composes them inside the
frame under `ItemTransform` + content-box clip; raw-GPUTexture/GPUDevice
stages remain).

## The decision

**For v1, freeze plugin-web at its honest source lane — HTML/CSS authoring +
the sandboxed O1 preview + diagnostics — and do NOT build the on-canvas web
renderer. When rendering is built (post-freeze), lower Blitz's paint output
to the plugin `sceneLayer` (C-1) from the bundle side, not to a bespoke
`anyrender_vello` paint hook embedded in core.** The design spec's "O3 is the
architecture" verdict stands as the *end-state*; this ADR ratifies the
*path and the timing*: defer, then prefer the platform seam over the core
hook.

## The fork (three options)

The W0 spike (W-01) settled *feasibility* — the Blitz/Stylo stack runs on
wasm and paints in core's exact vello/wgpu versions. What it left open is
*where the paint output lands*. Three options:

| Option | Mechanism | Core footprint | Ship date | Fidelity ceiling |
|---|---|---|---|---|
| **A — bespoke paint hook** | A `webFrame` paint hook in core's canvas: Blitz paints directly into the shared `anyrender_vello` scene (design spec §4.1 end-state, W-01 "REMAINING"). | **High** — Blitz becomes a core dependency (the whole Stylo/Taffy/Parley stack + a new object type in the compose pipeline); core carries an alpha engine. | Latest — a new core paint path + publish cycle + a new mutatable/serializable object type. | **Highest** — full Vello scene, every Blitz primitive (gradients, blend, sub-pixel text) paints natively; nothing is flattened through a wire. |
| **B — SceneLayer lowering** | The bundle runs Blitz in its own wasm, captures the display list, and lowers it to the existing in-frame `sceneLayer` (C-1: paths/fills + text runs); core composes it unchanged. | **Low** — zero new core code; C-1 already ships (v0.40.0). Blitz lives entirely in the *plugin*, behind the platform boundary, where the isolation contract wants it. | Earliest of the rendering options — gated only on the bundle work + the C-1 gaps it exposes (filed as BREAKAGE_LOG, not core forks). | **Bounded by C-1** — vector + single-line text compose today; gradients/blend/multi-run text/rasters are C-1's open stages (GPU-texture, per-run faces). Faithful-enough for v1.x; the gaps are *platform RFCs*, not dead ends. |
| **C — hybrid** | SceneLayer for the vector/text majority; a raster (or future GPU-texture C-1 stage) escape hatch for primitives the wire can't yet express. | **Low-to-medium** — B's footprint plus whatever the escape hatch costs (the C-1 texture stage is already on the platform roadmap for image). | Between A and B — B's lane first, the escape hatch as C-1 texture matures. | **Approaches A** as C-1's texture/blend stages land, without ever taking Blitz into core. |

## Why B (defer-then-lower), on the evidence

1. **Rendering is not on the v1 critical path.** What v0 ships is honest and
   self-contained: insert-frame, the HTML/CSS editors, the sandboxed preview,
   font-parity diagnostics, the metadata SHAPE (README; W-01 follow-up). The
   freeze candidate needs the *five plugins live* and K-1
   complete — not web *rendering*. Deferring rendering costs the freeze
   nothing; building it costs the freeze a core paint path during the exact
   weeks the platform is consolidating. The internal plan's lean is explicit
   ("freeze plugin-web's source lane only and defer rendering"); this ADR
   supplies the argument, not just the assertion.

2. **The contract was built to make this swap cheap.** Design spec §4.2 froze
   the `webFrame` contract as **engine-agnostic — "HTML/CSS in, scene layer
   out."** That phrasing is not incidental: it already names `sceneLayer` as
   the output seam. Option B is the contract's own intended shape; Option A
   is the *implementation convenience* of painting in-process, which the
   contract was deliberately written to not require.

3. **C-1 changed the economics after the design spec was written.** §4.1's
   "paint hook into the shared instance" was the only known path when the
   design spec was authored. Since then C-1 shipped (v0.39/v0.40): core now
   *already* composes plugin-submitted scene content inside a frame, under
   the frame's `ItemTransform` + content-box clip — exactly what a rendered
   web frame needs. The lower-core-footprint path the design spec couldn't
   assume now exists and is proven by a second consumer (sheets' in-frame
   grid). Building the bespoke hook would duplicate, in core, a composition
   path the platform already offers across the boundary.

4. **The isolation contract wants Blitz in the plugin.** An alpha engine
   (design spec §4.2: "alpha/pre-alpha … bugs and missing features") is
   precisely what should live *behind* the plugin boundary, swappable per the
   engine-agnostic contract, not welded into the core render pipeline where
   its bugs become core's bugs and its version becomes core's version. A
   raw-GPU paint hook is also the heaviest possible reach across the trust
   line (cf. [ADR 010](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/010-raw-mutate-gate-capability-enforcement.md) — the real trust boundary is the isolate; a core paint
   hook for plugin content runs counter to that direction).

5. **Fidelity loss is bounded and recoverable.** B's ceiling is C-1's current
   stages (vector + single-line text). The gaps — gradients, blend, multi-run
   text, rasters — are already C-1's roadmap (the GPU-texture stage is queued
   for image, per the internal gap register). So Option C (hybrid) is B with no architectural
   change: the same SceneLayer lane, widened as C-1 matures. A is the only
   option that forecloses nothing on fidelity *today*, but it pays for that
   with the highest core footprint and the latest ship date — a bad trade for
   a v1 that isn't shipping web rendering at all.

The case against B is honest: until C-1's texture/blend stages land, a
rendered web frame cannot be pixel-faithful for gradient/blend-heavy content.
That is acceptable because (a) v1 ships *no* web rendering, so the ceiling is
a v1.x concern, and (b) the gap is a platform RFC with a known owner (C-1),
not a fork in the road.

## Consequences

- **v1 scope is the source lane, stated honestly.** plugin-web's UI already
  says rendering is deferred (README; the manifest reserves the `webFrame`
  object type with `bakedFallback: "rectangle"`). No new honesty debt.
- **The rendering milestone, when it comes, is bundle-side work + C-1 RFCs**,
  not a core paint-pipeline change. Its blockers land in
  `BREAKAGE_LOG.md` (W-series) and surface as C-1 stage requests,
  consistent with the isolation contract ("SDK gaps become BREAKAGE_LOG
  entries / plugin-platform RFCs — never core modifications").
- **Option A is not deleted — it is the fallback if C-1 lowering proves
  infeasible** for the web display list (e.g. a primitive the SceneLayer wire
  fundamentally cannot carry and the texture stage can't cover). Revisit only
  on that evidence; the W0 spike's `anyrender_vello`-into-shared-instance
  result keeps A buildable if ever needed.
- **The W0 spike artifact (`core: spikes/blitz-wasm`) stays as the feasibility
  record**, not as the start of the core hook. It proved the bet; it does not
  obligate the path.
- **Baking (design spec §5, B2 vector+text IDML) is unaffected** — it lowers the
  rendered scene to IDML constructs and is downstream of whichever paint path
  produces the scene. Deferring the paint path defers baking with it; both
  ride the same SceneLayer output when built.

## 2026-06-13 addendum — the SceneLayer lane shipped; the blend/gradient-stroke family is built-but-DORMANT on a Blitz feature gap (accept-dormant)

Option B is now real. The Blitz wasm engine ships (`packages/web-render`,
`packages/web-bundle/bin/blitz_web*.wasm`), and the C-1 SceneLayer IR grew through
**five protocol bumps (v43→v48)** to carry a broad CSS surface — each additive,
each wiring to render support core already had, each CPU-rasterise-tested:

- **v45** linear/radial gradient fill (`FillPathGradient`).
- **v46** conic gradient (`SceneGradient::Sweep` + a new display-list sweep
  pool, both backends), per-fill blend (`FillPathBlend` + the 15 CSS modes),
  drop shadow (`DropShadow`).
- **v47** inset shadow (`InnerShadow`). Outset `spread` needs no wire — blitz
  inflates the border box before painting, so the lowering carries it.
- **v48** gradient stroke (`StrokePathGradient`), gradient-under-blend
  (`FillPathGradientBlend`).

**End-to-end + visible** against real Blitz HTML: rects, strokes,
transform-correct multi-run text, images, linear/radial/**conic** gradients,
**drop + inset** shadows, spread.

**Built, contract-correct, unit-tested — but DORMANT for real HTML:** per-fill
**blend modes**, **gradient strokes**, **gradient-under-blend** (and
**clip-in-blend**, not built for the same reason). Each has a reachability test
that *fires the day Blitz emits the primitive*.

**Why dormant — a Blitz feature gap, NOT a stale pin (verified 2026-06-13):**
`0.3.0-alpha.4` is the latest *published* Blitz, and Blitz **`main`** still does
not implement these CSS features — checked in `blitz-paint/src/render.rs@main`:
every layer push (`layer_manager.maybe_with_layer`, itself an API rename from
the `push_layer` we integrated against) passes `None` for blend mode (only
Normal/clip/opacity compositing), and all strokes/fills use solid `Color` (no
gradient-brush stroke; `border-image`/gradient borders unrendered). So **no pin
bump lights these up** — a newer pin adds no feature, breaks our capture
integration (the API rename), and risks a vello/wgpu line diverging from core's
pinned v0.9.0/wgpu-29 (this ADR's constraint).

**Decision: ACCEPT the dormant-and-ready state.** Do NOT fork Blitz or carry a
patched pin to force `mix-blend-mode`/gradient borders — that is an open-ended
ownership cost against a third-party pre-alpha engine, exactly the "alpha
engine's bugs become our bugs" trap §4 warns about. The capability is shipped
behind the boundary; it activates automatically when Blitz implements the
features upstream (the reachability tests convert to live tests then). The
alternative — contributing `mix-blend-mode` + gradient borders to Blitz
upstream — is recorded as a possible future investment, scoped as a real
external project, not a pin bump.

**Net:** paged.web lowers a broad, *visible* CSS surface to the in-frame
SceneLayer today, with the blend/gradient-stroke family shipped-and-waiting —
no honesty debt (the dormancy is tested + documented here and in the
design spec), no Blitz fork.

## Amendment — 2026-10-02

Checked against the code at `40792fa`. The decision stands and is what ships:
Blitz runs in the plugin and its paint is lowered to the scene layer; there is
no core paint hook. Two statements above no longer describe the code.

**1. The shipped engine links no Vello and no wgpu.** The capture layer depends
on the `anyrender` trait crate only and records paint instead of rasterising it
([ADR 401](401-layout-engine-pinned.md)).

- `packages/web-render/Cargo.toml:59` — `anyrender = "0.10"`, optional. The
  `blitz` feature (`:43-52`) names no `anyrender_vello`, `vello` or `wgpu`.
- `packages/web-render/Cargo.lock:27-28` — `anyrender` resolves to 0.10.0. The
  lockfile contains no package named `anyrender_vello`, `vello` or `wgpu`. The
  only 0.11 crate of that family is `anyrender_svg` (`:38-39`), a dependency of
  `blitz-paint`.
- `packages/web-render/src/capture.rs:43`, `:455`, `:817-819` — `CapturingScene`
  implements `anyrender::PaintScene` and is passed to `blitz_paint::paint_scene`;
  each paint call becomes a record in a `WebDisplayList`.
- `packages/web-model/src/engine.ts:44`, `:51-55` — `ENGINE_PIN.anyrender` is
  `"0.11.0"` and is documented as the `anyrender_vello` version. No crate in the
  lockfile has that name, and `anyrender` itself is at 0.10.0. The value is
  stamped into every saved source envelope
  (`packages/web-model/src/source.ts:213-219`). The same file still says the
  engine is not built (`engine.ts:22-31`, `:48-50`).
- `core: spikes/blitz-wasm/Cargo.toml:5-8`, `:35` — the feasibility spike also
  depends on `anyrender` 0.10 and paints into a counting `PaintScene`, "NOT a
  Vello scene". The version agreement is a note in
  `core: spikes/blitz-wasm/README.md:27-34` about what `anyrender_vello 0.11`
  requires; neither crate is built against it.

For the shipped build this supersedes: in Sources, "`anyrender_vello 0.11` pins
vello ^0.9 + wgpu ^29 = exactly core's versions, so the engine paints into the
shared instance"; under "The fork", "paints in core's exact vello/wgpu
versions"; in Consequences, "the W0 spike's `anyrender_vello`-into-shared-instance
result"; and in the 2026-06-13 addendum, "risks a vello/wgpu line diverging from
core's pinned v0.9.0/wgpu-29 (this ADR's constraint)". Under Option B as shipped,
nothing in this repository depends on that version agreement.

**2. Baking creates native page items; it writes no IDML.** The shipped flatten
(command "Bake web frame to document") turns a rendered scene layer into
ordinary host document mutations. The plugin contributes no exporter; export is
whatever the host's exporters do with the resulting native items
([ADR 407](407-baking-flattens-to-native-items.md)).

- `packages/web-bundle/src/bake-plan.ts:161-244` — `sceneLayerToBakePlan`, a
  pure `SceneLayer → BakePlan` (swatches, rectangles, single-subpath paths, text
  runs). Images and every other item kind are counted in `deferred` and not
  baked (`:223-233`).
- `packages/web-bundle/src/bake-to-document.ts:202-324` — `materializePlan`
  executes the plan through `host.document.mutate`: `createSwatch` (`:214-230`),
  `insertFrame` + `frameFillColor` (`:237-255`), `insertPath` (`:268-283`),
  `insertTextFrame` + `insertText` + size and colour (`:300-319`).
- `packages/web-bundle/src/bake-plan.ts:19-22` — the stated purpose: a flowed web
  document "exports to IDML/PDF through core's own native export".
- `packages/web-bundle/manifest.json:32-68` — `contributes` holds panels,
  commands, edit contexts, object types, part types and importers; there is no
  exporter entry. The command is `media.paged.web.command.bakeWebFrame` (`:43`),
  registered at `packages/web-bundle/src/activate.ts:122-127`.

This supersedes, in the last Consequences bullet, "it lowers the rendered scene
to IDML constructs". The rest of that bullet holds: baking is downstream of the
scene layer. The comment at `packages/web-bundle/src/bake.ts:33-36` still calls
this step "not implemented" and is stale.

**Also:** `BREAKAGE_LOG.md`, cited in Sources and Consequences, was removed from
this repository in commit `1151df7` (2026-06-12). The references to it are
historical.
