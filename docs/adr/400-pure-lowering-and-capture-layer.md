# ADR 400 — The renderer splits a pure lowering from an opt-in capture layer

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-render` (the Rust crate) and `scripts/build-wasm.sh`

## Context

`web-render` turns HTML and CSS into the scene-layer items that the host composes inside a
frame ([ADR 011](011-web-rendering-fork-defer-to-scenelayer.md)). The layout work is done by
the Blitz stack, which the crate pins at an alpha version
([ADR 401](401-layout-engine-pinned.md)).

The crate manifest states two pressures. The mapping from painted output to scene-layer
items had to be testable "WITHOUT the alpha Blitz stack"
(`packages/web-render/Cargo.toml:9-10`). And the Blitz dependency tree "pins its own
kurbo/peniko/stylo and must stay out of any engine lock"
(`packages/web-render/Cargo.toml:21-23`). The commit that created the crate, `2c78c6a`,
gives the same two reasons.

## Decision

The crate was cut into modules that are always built and modules that are compiled only
with the Cargo feature `blitz`, with one plain-data type between the two halves.

- Always built: `wire` (the scene-layer types), `display_list` (`WebDisplayList`, a recorded
  paint list in content points with every transform already folded into the geometry, using
  no Blitz, anyrender or kurbo type), and `lower` (`lower()`, a pure and total function from
  `WebDisplayList` to a `SceneLayer` plus a `LowerReport` of what was emitted and dropped).
- Behind `blitz`: `capture` (drives Blitz and fills a `WebDisplayList`), `fonts` and `flow`.
- The default feature set is empty. Every engine dependency is `optional` and is switched on
  only by `blitz`.
- The crate declares its own empty `[workspace]` table and keeps its own
  `packages/web-render/Cargo.lock`; the repository has no root Cargo workspace.
- The two wasm exports exist only when `blitz` is on and the target is `wasm32`.

## Evidence

- `packages/web-render/Cargo.toml:9-23` — the two layers, why they are split, why the crate
  is a standalone workspace
- `packages/web-render/Cargo.toml:40-52` — `default = []`; `blitz` lists every engine
  dependency
- `packages/web-render/Cargo.toml:73` — the empty `[workspace]` table
- `packages/web-render/src/lib.rs:70-83` — `display_list`, `lower`, `wire` unconditional;
  `capture`, `fonts`, `flow` behind `#[cfg(feature = "blitz")]`
- `packages/web-render/src/display_list.rs:27-36` — the boundary type is plain Rust so the
  lowering can be tested on hand-built lists
- `packages/web-render/src/lower.rs:189-193` — `lower()` is documented as pure and total
- `packages/web-render/src/display_list.rs:175-185` — dropped paint is recorded
  (`NonSolidPaint`, `BoxShadow`) so the lowering can count it
- `packages/web-render/src/lib.rs:104-122` — both exports are gated on `blitz` and `wasm32`

## Alternatives considered

None recorded in the repository.

## Consequences

`cargo test` with default features runs the 54 tests in `lower.rs` and the 9 in `wire.rs`
without compiling Blitz. The 34 tests in `capture.rs` and the 16 in `flow.rs` need
`--features blitz`.

A new kind of scene item is added in four places: the `wire` type, a `WebDrawCmd` variant,
a branch of `lower()`, and the capture sink. Paint that cannot be expressed must still be
recorded as a `WebDrawCmd`, or the report undercounts.

`lower()` returns a `LowerReport`, but the report does not leave the crate at this commit:
`render_web_frame` serialises only `lowered.layer` (`packages/web-render/src/lib.rs:107-108`)
and the flow result carries only an `emitted` count per frame
(`packages/web-render/src/flow.rs:715-720`). See [ADR 403](403-json-wasm-boundary.md).

`scripts/build-wasm.sh` still has a default mode that builds the crate without `blitz`
(`scripts/build-wasm.sh:33-39`). Because both exports are gated on the feature, that build
exposes no render function. The workflows build only with `--engine`
(`.github/workflows/vitest.yml:70`, `.github/workflows/publish.yml:46`).

No workflow under `.github/workflows` runs `cargo test` at this commit; the Rust tests run
locally only. The comment at `packages/web-render/src/lib.rs:80-81` calls `flow` "not
shipped", although `lib.rs:116-122` exports it.

## Related

- [ADR 011](011-web-rendering-fork-defer-to-scenelayer.md) — rendering goes through the scene layer
- [ADR 401](401-layout-engine-pinned.md) — what the `blitz` feature pulls in
- [ADR 403](403-json-wasm-boundary.md) — the exported functions
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) — the scene layer the `wire` module mirrors
- [ADR 314](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/314-plugin-shape.md) — the plugin shape shared by the plugin family
