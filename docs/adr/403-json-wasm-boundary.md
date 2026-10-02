# ADR 403 — The Rust/JS boundary is two string-in, JSON-out functions

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-render/src/lib.rs` and `wire.rs`, `packages/web-model/src/render.ts`,
  `packages/web-bundle/src/engine-loader.ts` and `bake.ts`, `scripts/build-wasm.sh`

## Context

The TypeScript bundle has to call the Rust renderer and pass the result to the host's
scene-layer door, which takes a `{ items }` object and composes it inside a frame
(`packages/web-render/src/wire.rs:19-27`). Both functions take and return strings, and the
results are JSON. The repository does not record why.

The editor's bundler pre-bundles the plugin. A loader that located the wasm glue with
`new URL(..., import.meta.url)` returned 404 there, because `import.meta.url` moves when the
bundle is pre-bundled (`packages/web-bundle/src/engine-loader.ts:42-51`).

The loader states one rule about failure: it "never fakes a render". When the artifact
cannot be loaded the result is `null` and the caller reports it (`engine-loader.ts:25-31`).

## Decision

The wasm exports exactly two functions, and the engine artifact ships inside the one
published package and is loaded on first use.

- `render_web_frame(html, width_px, height_px) -> String` returns `{ items: [...] }`.
  `render_web_flow(html, frames_json, flow_root) -> String` returns
  `{ frames: [{ layer, emitted }], overset }`. There is no version number and no handshake:
  the glue surface the bundle declares is the init function and these two.
- Sizes cross in CSS px. The bundle multiplies frame points by 96/72 and rounds; the capture
  multiplies by 72/96 and folds every transform in, so results are in frame-content points.
- The scene-layer type is twinned by hand: `wire.rs` mirrors the host's
  `paged_compose::scene_layer`, and `web-model/src/render.ts` holds a third, narrower copy so
  that `web-model` stays free of dependencies. The Rust copy is kept equal to the host's by
  serde attributes and 21 serialisation tests in two files, not by code generation.
- `scripts/build-wasm.sh --engine` builds for `wasm32-unknown-unknown`, runs
  `wasm-bindgen --target web` and `wasm-opt -Oz` when they are installed, writes
  `packages/web-bundle/bin/` (gitignored) and fails above 64 MiB. The package ships `bin`,
  `dist` and `manifest.json`.
- The bundle imports the glue with a relative dynamic `import()` and the wasm through a
  bundler `?url` import, on the first render, and keeps one engine per process.
- `loadWebEngine` never throws. A failed load, or a render call that throws, yields `null`;
  the command publishes a fixed "not loaded" diagnostic and submits nothing. Malformed JSON
  parses as an empty layer.

## Evidence

- `packages/web-render/src/lib.rs:104-122` — the two `#[wasm_bindgen]` exports
- `packages/web-render/src/wire.rs:19-45`, `:390-740` — the twin, the serde attributes that
  must match the host, and nine key-shape tests
- `packages/web-render/src/lower.rs:1811-2209` — twelve more key-shape tests, the only ones
  that pin the path, text and image item shapes
- `packages/web-model/src/render.ts:48-51`, `:118-123` — the TypeScript copy and its three kinds
- `packages/web-bundle/src/engine-loader.ts:61-75`, `:129-142`, `:155-208`, `:219-264` — the
  glue surface, the two imports, the memoised loader, the defensive parsers
- `packages/web-bundle/src/bake.ts:73`, `:196-203`, `:251-252` and
  `packages/web-render/src/capture.rs:63` — unit conversion and the not-rendered outcome
- `scripts/build-wasm.sh:58`, `:65-67`, `:76-92` — bindgen target, size pass, budget gate
- `packages/web-bundle/package.json:34-38`, `packages/web-bundle/tsup.config.ts:7-11`,
  `packages/web-bundle/manifest.json:21-28` — shipped files; `?url` left external; the wasm entry

## Alternatives considered

Commit `96306c7` shipped a `new URL("../bin/blitz_web.js", import.meta.url)` loader; commit
`fdbe007` replaced it for the reason given in Context. None is recorded for the encoding.

## Consequences

A change to the host's scene-layer JSON must be copied by hand into `wire.rs`. A mismatch is
not an error: the host drops the item when it deserialises (`wire.rs:195-199`, `:392-396`).
The TypeScript copy names three item kinds; the Rust type has ten. The bundle passes the
parsed object through with a cast (`bake.ts:219`), and the flatten counts kinds it does not
know as not baked (`packages/web-bundle/src/bake-plan.ts:227-232`).

Raster images cross as JSON arrays of byte values (`wire.rs:83-91`, `render.ts:109`). The
lowering's coverage report does not cross at all (`lib.rs:107-108`). The publish workflow
must build the wasm before packing, with a `wasm-bindgen` CLI of the version in the crate's
lockfile (`.github/workflows/publish.yml:32-46`), and the host's bundler must resolve the
`?url` import.

Leftovers contradict the code. `render.ts:182-193` and `:273-288` still export
`renderWebFrame` and `renderWebFlow`, which always return the not-loaded result; `bake.ts`
calls the first only when no engine is passed (`bake.ts:181-190`). Comments at
`render.ts:174-178` and `lib.rs:95-103` say the artifact is not built, and
`build-wasm.sh:24` names the output `blitz_web.wasm` (the manifest says `blitz_web_bg.wasm`).

## Related

- [ADR 400](400-pure-lowering-and-capture-layer.md), [ADR 401](401-layout-engine-pinned.md), [ADR 011](011-web-rendering-fork-defer-to-scenelayer.md) — what is behind the two functions
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) — the scene layer
- [ADR 308](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/308-plugin-wasm.md) — plugin wasm as a declared capability under a size budget
- [ADR 307](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/307-contract-as-peer-dependency.md), [ADR 309](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/309-conformance-against-real-engine.md), [ADR 314](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/314-plugin-shape.md) — packaging and test rules shared by the plugin family
