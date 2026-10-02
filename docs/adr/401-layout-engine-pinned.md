# ADR 401 — The layout engine is pinned exactly and used for style, layout and paint capture only

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-render` (feature `blitz`), `packages/web-model/src/engine.ts`,
  the `capabilities.wasm` entry of `packages/web-bundle/manifest.json`

## Context

The plugin needs a CSS engine that compiles to WebAssembly. Which engine, and that its
output goes to the host as a scene layer rather than through a paint hook in the host
engine, is [ADR 011](011-web-rendering-fork-defer-to-scenelayer.md). The crate header repeats
it: the paint output is lowered to the plugin scene layer, "NOT a bespoke core paint hook;
the engine lives entirely in the plugin" (`packages/web-render/src/lib.rs:21-25`).

The capture code grew out of a feasibility spike (`core: spikes/blitz-wasm`) whose paint
sink only counted commands; here the sink records them
(`packages/web-render/src/capture.rs:23-25`).

The reason for an exact pin is stated in `packages/web-model/src/engine.ts:19-22`: a
rendered frame is reproducible only if the engine stack that painted it is recorded, so
that "re-rendering the same source under the same pins must yield the same scene".

## Decision

The crate depends on Blitz at exactly `0.3.0-alpha.4` (`blitz-dom`, `blitz-html`,
`blitz-paint`, `blitz-traits`) and uses it for parsing, style, layout and the paint
traversal. It links no rasteriser.

- The lockfile resolves Stylo 0.17.0 (CSS), Taffy 0.11.0-experimental-cache-fix.3 (box
  layout) and Parley 0.9.0 (text) under those pins.
- `CapturingScene` implements anyrender's `PaintScene` trait and is handed to
  `blitz_paint::paint_scene`. Fills, strokes, glyph runs, images, gradients and shadows
  become records in a `WebDisplayList`; no pixel is produced.
- `render_html` is `HtmlDocument::from_html`, `set_viewport`, `resolve`, then the capture.
- The lockfile contains no `vello` and no `wgpu` package.
- The pin is repeated in TypeScript as `ENGINE_PIN` and written into the `engine` field of
  every saved source envelope.

## Evidence

- `packages/web-render/Cargo.toml:59-68` — the pins (`=0.3.0-alpha.4`, `anyrender 0.10`,
  `kurbo 0.13`, `parley 0.9`, `peniko 0.6`)
- `packages/web-render/Cargo.lock:27-28`, `:1172-1173`, `:1677-1678`, `:1856-1857` —
  anyrender 0.10.0, parley 0.9.0, stylo 0.17.0, taffy 0.11.0-experimental-cache-fix.3
- `packages/web-render/src/capture.rs:455` — `impl PaintScene for CapturingScene`
- `packages/web-render/src/capture.rs:798-825` — `render_html` and `capture_resolved`, which
  calls `paint_scene` with the recording sink
- `packages/web-model/src/engine.ts:51-55` — `ENGINE_PIN`
- `packages/web-model/src/source.ts:213-219` — `envelopeFor` stamps `engine`
- `packages/web-render/src/lower.rs:68-83` — which lanes this Blitz version never reaches
- `packages/web-bundle/manifest.json:21-28` — the wasm is declared with purpose `engine`

## Alternatives considered

None recorded in the repository. The choice of engine is argued in ADR 011, not here.

## Consequences

What a web frame can show on the canvas is bounded by what Blitz 0.3.0-alpha.4 paints.
Gradient strokes and fills under a non-normal blend mode are implemented and unit-tested in
the lowering, but this Blitz version never emits them for real HTML. Two tests assert that
it does not, so that an upgrade which starts emitting them fails a test
(`packages/web-render/src/capture.rs:1751`, `:1918`).

The capture is written against this version's `PaintScene` calls, and the flow code
([ADR 404](404-fragmentation-by-relayout.md)) against this version's document mutation API.
Moving the pin means revisiting both.

The stamp is written but not read. `pinFromStamp` and `pinMatches` exist
(`packages/web-model/src/engine.ts:72-85`) and nothing under `packages/*/src` calls them, so
no code detects that a document was last saved under another engine version.

The TypeScript pin and its comments do not match the crate. `ENGINE_PIN.anyrender` is
`"0.11.0"` and is described as the `anyrender_vello` version (`engine.ts:44-45`, `:54`); the
crate depends on the `anyrender` trait crate, resolved at 0.10.0. `engine.ts:22-31` and
`:48-50` say the engine is not built yet. `Cargo.toml:17-19` and `:41-42` describe the stack
as matching the host engine's vello and wgpu versions, although neither is linked.

The artifact is large. Commit `6fdb2c6` raised the manifest ceiling from 4 MiB to 64 MiB
because the built wasm was 8.83 MB.

## Related

- [ADR 011](011-web-rendering-fork-defer-to-scenelayer.md) — the engine choice and the scene-layer route
- [ADR 020](020-paged-web-native-engine-defer-frame-threading.md) — no forked engine
- [ADR 400](400-pure-lowering-and-capture-layer.md) — the feature gate that isolates this stack
- [ADR 402](402-text-crosses-as-strings.md) — what the capture does with glyph runs
- [ADR 308](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/308-plugin-wasm.md) — plugin wasm as a declared capability
