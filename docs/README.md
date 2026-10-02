# Documentation

What this folder holds.

- [`concept.md`](concept.md): why the plugin exists, what it is for, and what it will never do.
- [`architecture.md`](architecture.md): how it is built. The three packages, the path of one
  render, the flow and flatten paths, where the source is stored, the host doors used, and
  how it is built and tested.
- [`status.md`](status.md): what ships today, the limits of what ships, and what is not built.
- [`adr/`](adr/README.md): the decision records of this repository, 011, 020 and 400–408.
- [`design/flow-fragmentation.md`](design/flow-fragmentation.md): the flow lane as built,
  in detail: how one source is laid out across a chain of frames.
- [`design/native-engine-evaluation.md`](design/native-engine-evaluation.md): the evaluation
  of a native layout engine for web content, the background to
  [ADR 020](adr/020-paged-web-native-engine-defer-frame-threading.md).

## Decisions in other repositories that bind this one

These records live in other public paged-media repositories. The code here rests on each of
them. The last column says what the decision means for this plugin.

| ADR | Repository | Decision | What it means here |
|---|---|---|---|
| [010](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/010-raw-mutate-gate-capability-enforcement.md) | plugin-sdk | The raw-mutate gate and the capability enforcement line | The plugin writes with raw `document.mutate` operations under `document.write: "scoped"`. Its metadata writes must use its own key, `x-paged:media.paged.web`; the host rejects any other (`packages/web-bundle/src/insert.ts`). |
| [017](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/017-importer-exporter-door-shape.md) | plugin-sdk | Importer and exporter door shape | `.html` and `.htm` files are routed to this plugin's importer by extension or MIME type. It receives the file's bytes and inserts a web frame (`packages/web-bundle/src/activate.ts`). The exporter half is not used. |
| [305](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/305-doors-always-present.md) | plugin-sdk | Every door is always present; `supports()` reports a missing backend | Each optional door is probed with `host.supports(...)` and has a fallback: a textarea for the code editor, a substitution note for font bytes, a paste box for the clipboard, the metadata copy alone for container parts, a render that is not submitted for the scene layer, no importer. |
| [307](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/307-contract-as-peer-dependency.md) | plugin-sdk | Bundles take the contract packages as peer dependencies | `@paged-media/plugin-api` and `@paged-media/plugin-sdk` are peer dependencies of `@paged-media/web` (`packages/web-bundle/package.json`). |
| [308](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/308-plugin-wasm.md) | plugin-sdk | Plugin wasm is a declared capability, loaded by the bundle, under one size budget | The manifest declares one wasm module, `bin/blitz_web_bg.wasm`, with a 64 MiB ceiling. `packages/web-bundle/src/engine-loader.ts` loads it on first render, and `scripts/build-wasm.sh` fails above the same ceiling. |
| [309](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/309-conformance-against-real-engine.md) | plugin-sdk | Conformance runs against the real published engine | `packages/web-bundle/test/conformance/` drives the bundle through `createHeadlessHost` from `@paged-media/plugin-sdk`. |
| [310](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/310-one-write-door.md) | plugin-sdk | One write door: `document.mutate`, engine-owned history, failures as outcomes | Insert and flatten go through `host.document.mutate`, a save through `setMetadata`. The code tests `outcome.applied` and leaves undo to the host: an insert is one batch, so one undo step. |
| [311](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/311-plugin-state-under-own-id.md) | plugin-sdk | Plugin state lives only under the plugin's own id | The source is kept under the metadata key `x-paged:media.paged.web` and in the plugin's own container-part namespace. |
| [314](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/314-plugin-shape.md) | plugin-sdk | The plugin shape: semantics in Rust behind one wasm module, a logic-free shim, one published package | Here there is one wasm module (`web-render`) and one published package (`@paged-media/web`). The TypeScript side is not logic-free: `packages/web-model` holds the source model, the linter, the sanitiser and the template pass. |
| [315](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/315-isolation-contract.md) | plugin-sdk | The isolation contract: a plugin depends only on the published contract | `scripts/check-contract-imports.mjs` runs before the tests and rejects any import other than the two contract packages, this repository's own packages and `react`. |
| [316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md) | plugin-sdk | Plugin content is stored as valid native document content; baking is the fallback | A web frame is a native rectangle with metadata, declared with `bakedFallback: "rectangle"`. "Bake web frame to document" is this plugin's baking; see [ADR 406](adr/406-web-frame-and-source-storage.md) and [ADR 407](adr/407-baking-flattens-to-native-items.md). |
| [013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) | core | In-frame plugin rendering via `SceneLayer` | This is the whole canvas path: the layout engine's paint is lowered to scene-layer items and submitted per frame. `packages/web-render/src/wire.rs` and `packages/web-model/src/render.ts` copy the item shapes by hand from `core: crates/paged-compose/src/scene_layer.rs`, so a change there has to be repeated here. |
| [118](https://github.com/paged-media/core/blob/main/docs/adr/118-paged-file-is-a-valid-idml-package.md) | core | A `.paged` file is a ZIP that stays a valid IDML package | The source envelope is written as a part inside the `.paged` container (`packages/web-bundle/src/source-part.ts`). The frame stays an ordinary rectangle that carries a metadata copy. |
| [024](https://github.com/paged-media/editor/blob/main/docs/adr/024-context-sensitivity-is-a-core-concept.md) | editor | Context-sensitivity is a core concept | The `webFrame` edit context declares an empty tool set and one panel (`packages/web-bundle/src/edit-context.ts`): no canvas tool edits a web frame. |
