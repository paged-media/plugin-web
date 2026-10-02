# ADR 020 — paged-web native engine: defer the fork; extend the SceneLayer lane for frame threading

**2026-07-18 · decision record · status: ACCEPTED (ratified 2026-07-18).** A
forward-looking ADR-as-memo (cf. [011](011-web-rendering-fork-defer-to-scenelayer.md)/[012](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/012-k1-modal-session-undo-coalescing.md)): it
keeps the ADR format but argues a recommendation, paired with the reasoning memo
[`../design/native-engine-evaluation.md`](../design/native-engine-evaluation.md). Records the disposition of
an internal proposal for a native HTML/CSS engine in the core (the proposed native forked
`paged-web` engine; "the spec" below)
against the shipped web-rendering direction.

**Sources:** an internal proposal for a native HTML/CSS engine in the core (the subject; esp. §5.5/§13/§14.4
fragmentation, §17.2 typography convergence, §20 paint, §38 ADR list); **[ADR-011](011-web-rendering-fork-defer-to-scenelayer.md)**
(defer + SceneLayer, "Option A is the fallback… revisit only on that evidence", do-NOT-fork-Blitz
addendum); **[ADR-013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md)** (C-1 in-frame SceneLayer);
**[ADR-018](https://github.com/paged-media/core/blob/main/docs/adr/018-stage-b-gpu-texture-defer-record-only.md)** (GPU-texture escape hatch,
record-only); `packages/web-render/src/lib.rs` (Option B lib doc + the single-frame
`render_web_frame` signature + the "CSS fragmentation across linked frames" deferral);
`packages/web-model/src/engine.ts` (`ENGINE_PIN`; `anyrender_vello 0.11` = core's
`vello ^0.9`/`wgpu ^29`); `core: crates/paged-compose/src/scene_layer.rs` (the C-1 seam paints
through core's Vello + tiny-skia lanes, colour-managed/print-correct/CPU-testable);
`core: crates/paged-canvas/src/channel.rs:336` (`PROTOCOL_VERSION = 51`); the internal gap
register, §6 W-01. Full reasoning: [`../design/native-engine-evaluation.md`](../design/native-engine-evaluation.md).

## The decision

**Do not build the native forked `paged-web` engine now, and do not supersede ADR-011.**
Keep the shipped **SceneLayer lowering** lane (Blitz in the plugin → C-1 `SceneLayer` → core
composes in-frame) as the paint path. Adopt the spec's one genuinely-new capability —
**CSS-Regions fragmentation of a single HTML flow across multiple publication frames** — as a
**scoped extension of that lane**, not a new core-sibling engine, and **gate it on a
timeboxed W-frag feasibility spike**. Escalate to the spec's forked engine **only** if that
spike shows resumable per-fragmentainer layout is infeasible without owning the box/layout
trees — which is exactly ADR-011's pre-written *"revisit only on that evidence"* trigger.

The spec conflates two separable questions. The **paint target** (core `DisplayList` vs
plugin `SceneLayer`) is settled by ADR-011/013 and shipped; the spec reopens it without
new evidence. **Fragmentation** (thread one flow across N frames) is genuinely open — and is
the shipped lane's own next deferred item, not a reason to fork an engine.

## Options weighed

| Option | Mechanism | Core footprint | Ship | Capability + fidelity | Risk |
|---|---|---|---|---|---|
| **X — native forked engine** (the spec) | Fork Blitz/Stylo/Taffy/Parley into 14 `paged`-owned crates; three-tree; paint direct to `DisplayList`; replace AnyRender + Vello backends. | **Highest** — an alpha engine + a 2nd font/shaping stack (Parley+swash vs core rustybuzz) + edition-2024 skew, all in core. | Latest — ten build stages in the spec. | Unlocks fragmentation *and* full-fidelity paint; but paint-fidelity is already met by the SceneLayer lane. | Owning a pre-alpha fork; the trap ADR-011 §4 names. |
| **Y — extend the shipped lane** *(recommended)* | Keep Blitz-in-plugin → SceneLayer. Add per-frame flow fragmentation (`render_web_flow(html, [frames]) -> [SceneLayer]`) + a renderer-neutral `FlowId`/region model shared with IDML stories. | **Low** — additive; a `FlowId` seam in core (or a new `paged-publication` crate) only if the spike passes. | Earliest — a spike, then bundle + a narrow core seam. | Unlocks fragmentation on the existing print-correct lane; paint fidelity unchanged (already broad). | The spike may find Blitz can't resume layout per-frame → escalate to X (authorized). |
| **Z — status quo** | Ship only single-frame web rendering; no fragmentation. | None new. | Now. | No multi-frame HTML. | Leaves the IDML↔web convergence thesis unrealized. |

## Why Y (defer-then-extend), on the evidence

1. **The paint-target case is settled and the spec adds no new evidence.** ADR-011's Option
   B is shipped and *"stays honest"* (`CLAUDE.md`); the C-1 seam already renders
   *"through the same Vello (GPU) and tiny-skia (CPU) lanes as native content — colour-managed,
   print-correct, and unit-testable on the CPU lane"* (`scene_layer.rs`). The spec's direct-
   `DisplayList` path re-earns properties that already exist across the boundary.
2. **"Replace Vello with paged-gpu" is a non-need.** The Blitz stack's `anyrender_vello 0.11`
   pins core's *exact* `vello ^0.9`/`wgpu ^29` (`engine.ts`) — a shared instance is already
   available; the replacement is cost without gain.
3. **The net-new capability is the lane's own tracked deferral.** `packages/web-render/src/lib.rs`
   lists, under "Deferred… never faked", *"CSS fragmentation across linked frames."* The
   spec's headline is the next item on the existing lane's list — argues for widening the
   lane, not forking an engine.
4. **Isolation.** A `blitz 0.3.0-alpha.4` engine belongs behind the plugin boundary
   (ADR-011 §4; ADR-018 pushes the trust line away from core paint hooks), not welded into
   core where its bugs and version become core's.
5. **Continuity with ADR-011.** ADR-011 already kept Option A (a heavier reach into core) as
   *"the fallback if C-1 lowering proves infeasible."* This ADR does the same one axis out:
   the forked engine is the fallback if *fragmentation* lowering proves infeasible. The
   escalation is pre-authorized; it needs spike evidence, not a fresh mandate.

The case against Y is honest: correct CSS Regions cannot be clip-slicing a tall layout
(spec §5.5/§14.4) — it needs resumable per-fragmentainer layout, an interception point Blitz
may not expose. That is precisely what the W-frag spike exists to settle before any
engine-scale commitment.

## Consequences

- **No change to the shipped paint path.** ADR-011/013 stand; plugin-web keeps rendering via
  SceneLayer. `PROTOCOL_VERSION` unaffected by this decision.
- **Next action is a W-frag spike**, not engine work: can Blitz's layout be resumed per-frame
  to emit one `SceneLayer` per frame without a deep fork? Scoped in
  an internal spike brief + filed in the internal gap register as **W-frag**. Post-reconnaissance refinement:
  the escalation is **graduated, not binary** — Parley 0.9 already ships a resumable,
  variable-width, height-aware breaker (`break_lines`/`MaxHeightExceeded`) below the
  `BaseDocument` API, so a **medium rung** (own the block-flow over Parley + Blitz boxes, *no*
  Blitz/Taffy source fork) sits between the scoped extension and this ADR's rung-4 forked
  engine. The spike decides how far up the ladder the real use cases require.
- **One core-resident question, only if the spike passes:** a renderer-neutral `FlowId` +
  region-chain + overset model shared with IDML stories (spec **Q#6** — `paged-canvas` vs a new
  `paged-publication` crate vs `paged-scene`). That becomes its own global ADR when decided.
- **The spec is retained as the north-star reference** for the escalation case (three-tree
  model, `paged-font`/`paged-shape` convergence, WPT harness). Its **§38 `ADR-001…015` block
  is not adopted**: it collides with the global ADR sequence and mostly proposes
  future design (which the ADR rule forbids). Those become *individual global ADRs (021+) as
  each is actually decided*, per the disposition table in the eval memo — not a pre-allocated
  block.
- **Stale trackers refreshed on ratification of this ADR:** the internal gap register's **W-01** updated to
  DONE-for-paint + a new **W-frag** item added for the fragmentation spike; the ADR
  index rows for **011/012** flipped PROPOSED → RATIFIED (both files were already RATIFIED
  2026-06-12).
- **WICG `html-in-canvas`** is tracked as a possible future **preview-surface** upgrade
  (screen-only; fails determinism/headless/print/vector/fragmentation) — orthogonal to this
  decision, never the render/export path (eval memo §9).

## 2026-07-18 addendum — the W-frag spike was executed; rungs 1 & 2 are proven, no fork

The spike this ADR gated on is DONE (native, offline; spike brief §7). The Blitz stack builds + runs
natively; the code is `packages/web-render/src/flow.rs` (feature `blitz`, ~460 LOC
incl. tests) + one behaviour-preserving `capture.rs` refactor (`capture_resolved`). **Zero
impact on the shipped/bundle build** (default lane green, 63 tests; the module is
`#[cfg(feature = "blitz")]`).

- **Rung 1 (equal-width) — WORKS**, no new Blitz API (display-list slicing).
- **Rung 2 (variable-width, block-granular) — WORKS** through the pinned `BaseDocument` +
  `DocumentMutator` API (remove consumed prefix → re-`resolve` at the new width → remainder
  re-line-breaks). **No engine fork.** Honest limits: block granularity (no mid-block split
  yet) + O(frames) re-resolves. Both rungs' `flow::` tests pass deterministically.
- **Rung 3 (line-granular, own-the-flow-over-Parley)** — design-validated (Parley 0.9
  `break_lines`/`MaxHeightExceeded` present + used by blitz internally), NOT executed.

**Consequence:** the escalation ladder is now empirical. The scoped extension this ADR
recommends is buildable *today* on the shipped lane (rungs 1–2). The forked engine (rung 4, the
spec) is confirmed the last resort — gated on a validated need that rungs 1–3 can't meet, not on
feasibility doubt. This ADR's decision stands, now on measured evidence.

## Amendment — 2026-10-02

Checked against the code at `40792fa`. The decision stands: the SceneLayer lane is the paint
path and there is no engine fork; Blitz is consumed unmodified at `=0.3.0-alpha.4` from
crates.io (`packages/web-render/Cargo.toml:60-63`, `packages/web-render/Cargo.lock:106-108`).
Fragmentation has since moved from spike to product, and the text above no longer matches the
code in four places.

**1. `flow.rs` ships.** It is the implementation behind a wasm export that the bundle calls.

- `packages/web-render/src/lib.rs:116-122` — `render_web_flow` is a `#[wasm_bindgen]` export
  that calls `flow::render_web_flow_json`.
- `packages/web-render/src/lib.rs:82-83` — the module is still behind `feature = "blitz"`, but
  the published artifact is built with that feature: `scripts/build-wasm.sh:36-38` (`--engine`
  sets `--features blitz`), `.github/workflows/publish.yml:45-46`.
- `packages/web-bundle/src/engine-loader.ts:183-190` — the bundle calls
  `glue.render_web_flow(...)`. `packages/web-bundle/src/bake.ts:391`, `:522` reach it through
  `engine.renderFlow`, behind the command `media.paged.web.command.renderWebFlow`
  (`packages/web-bundle/manifest.json:39`).
- `packages/web-render/src/flow.rs` is 1505 lines.

This supersedes, in the addendum, "Zero impact on the shipped/bundle build" and "~460 LOC incl.
tests". Three comments in the code still describe the earlier state and are stale:
`packages/web-render/src/lib.rs:53-58` (lists "CSS fragmentation across linked frames" as
deferred; reason 3 quotes it), `lib.rs:80-81` ("feasibility PoC, not shipped") and
`packages/web-render/src/flow.rs:19-20` ("FEASIBILITY PROTOTYPE, not shipped product").

**2. Splitting inside a block ships, by a different mechanism than "rung 3".** The code does
not drive Parley's breaker and does not own the block flow. It reads the line boxes Blitz has
already computed, edits the DOM, and lays out the remainder again
([ADR 404](404-fragmentation-by-relayout.md)).

- `packages/web-render/src/flow.rs:595-681` — `try_split` finds the last line of the straddling
  paragraph that fits the frame (`:602-612`), maps that offset to DOM text nodes by
  non-whitespace character count (`:619-626`) and returns per-node text edits.
- `packages/web-render/src/flow.rs:239-247` — the frame loop removes the consumed blocks
  (`remove_node`) and applies the edits (`set_node_text`); the next iteration's `resolve`
  (`:190-191`) lays out the remainder at the next frame's width.
- `packages/web-render/src/flow.rs:404-419`, `:436-486` — a container with element children and
  no inline content of its own is descended into and cut between its children.
- `packages/web-render/src/flow.rs:386-403`, `:497-580` — a table is cut between body rows. Rows
  inside `<thead>` are never deleted, so the header is laid out again at the top of each
  continuation frame.
- Tests: `packages/web-render/src/flow.rs:1095` (paragraph), `:1165` (nested containers),
  `:1200` (table rows with a repeated header), `:1306` (paragraph with inline elements).

Limits stated in the code: a table row is atomic (`flow.rs:493-496`); a straddling block that
cannot be split moves whole to the next frame (`:354-356`, `:420`); the paragraph split is
abandoned when the offset cannot be mapped to the DOM (`:627-629`, `:653`). One `resolve` per
frame still holds (`:189-191`).

This supersedes, in the addendum, "Honest limits: block granularity (no mid-block split yet)",
"Rung 3 … NOT executed" and "(rungs 1–2)". The "medium rung" named in Consequences (own the
block flow over Parley) was not built. The doc comment at `flow.rs:732-735` still calls the
entry point "the rung-2 (block-granular) implementation" and is stale.

**3. The flow chain is plugin data.** It is an ordered list of recipient frames stored with the
source of the first frame, not a core flow id or a core region chain
([ADR 405](405-flow-chain-is-plugin-data.md)).

- `packages/web-model/src/source.ts:101-103`, `:161` — `WebFlowChain { recipients }` is the
  optional `flow` field of `WebFrameSource`; the source frame is implicit position 0.
- `packages/web-model/src/source.ts:213-219`, `:248-251` — the field is serialised inside the
  source envelope's `data` and sanitised on read.
- `packages/web-bundle/src/render-flow-command.ts:166-219` — "Thread web flow into frames" edits
  the list and persists it (`:214`); `:74-90` resolves the chain from the persisted source at
  render time.
- `packages/web-bundle/src/source-part.ts:69-76` — the envelope is written to the frame's
  metadata and, where the host has a container writer, to a container part; reads prefer the
  part (`:80-97`). See [ADR 406](406-web-frame-and-source-storage.md).
- `packages/web-model/src/render.ts:212-216` — `FlowId` in this repository is a plugin-local
  `string`, the source frame's element id.
- `packages/web-render/src/flow.rs:228-231`, `packages/web-bundle/src/bake.ts:428-435` — overset
  is computed by the plugin's engine and reported as a warning diagnostic.

For what ships in this repository this supersedes, in the options table, option Y's "a
renderer-neutral `FlowId`/region model shared with IDML stories" and "a `FlowId` seam in core",
and the Consequences bullet "One core-resident question, only if the spike passes". The core has
since gained a content-agnostic
`paged-flow` crate with `FlowId` and `RegionChain` (`core: crates/paged-flow/src/lib.rs:49`,
`:175`, core at `9f933f1`); nothing in this repository uses it. The repository does not record
why the chain was kept in the plugin.

**4. The shipped engine links no Vello and no wgpu.** Reason 2 and the Sources entry for
`engine.ts` argue from `anyrender_vello 0.11` matching the core's `vello`/`wgpu` versions ("a
shared instance is already available"). The shipped crate depends on the `anyrender` 0.10 trait
crate only and records paint instead of rasterising it. The evidence is in the amendment to
[ADR 011](011-web-rendering-fork-defer-to-scenelayer.md); see also
[ADR 401](401-layout-engine-pinned.md).
