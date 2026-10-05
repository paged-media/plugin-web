# paged-media/plugin-web

**paged.web** — HTML/CSS as a first-class content type for the Paged editor.
Concept: [`docs/concept.md`](./docs/concept.md) ("InDesign can't speak
web. Webflow can't speak print."). Where paged.draw proves the platform hosts
a *tool*, paged.web proves it hosts a *foreign document model* — the second
half of the plugin platform's existential test.

## Documentation

Everything about how the plugin is designed and built is in [`docs/`](./docs/README.md):

- [`docs/concept.md`](./docs/concept.md): why the plugin exists and what it is for.
- [`docs/architecture.md`](./docs/architecture.md): packages, the render path, host doors.
- [`docs/status.md`](./docs/status.md): what ships today and what does not.
- [`docs/adr/`](./docs/adr/README.md): the architecture decisions, one per file.

`docs/status.md` is the current record of what ships; the latest full analysis
(gaps against Chrome and InDesign, tests, performance) is
[`docs/design/analysis-2026-10-05.md`](./docs/design/analysis-2026-10-05.md).

## What it does

- **Web frames.** "Insert web frame" (or importing a `.html` file) places a frame
  whose content is an HTML/CSS source. The "Web frame" panel edits it: HTML and
  CSS editors, a sandboxed live preview (`sandbox=""` — page JavaScript never
  executes), diagnostics, templates and template variables, and an explicit
  "Save to document".
- **Rendering on the canvas.** The Blitz engine (Stylo, Taffy, Parley), compiled
  to wasm, lays the source out at the frame's size and the bundle submits the
  result as a scene layer that the editor draws inside the frame — on command
  ("Render web frame to canvas").
- **Flow across frames.** A web frame can be threaded into further frames; the
  flow render lays the content out again at each frame's width and splits it
  between blocks, lines, container children and table rows. CSS `flow-into`
  names several flows.
- **Bake to document.** "Bake web frame to document" turns a rendered frame or
  flow into native swatches, rectangles, paths and text frames, so IDML/PDF
  export and other applications see the content.
- **Persistence.** The source is stored in the document: in the frame's metadata
  label when it fits (undoable, carried through IDML), otherwise in a
  content-addressed container part that the label points to.

## Packages

| Package | Contents |
|---|---|
| `@paged-media/web-model` | pure TS, zero deps: the `WebFrameSource` model and its storage envelope, the HTML linter, font parity, the sanitiser, the template pass, CSS `flow-into` parsing |
| `@paged-media/web` (`packages/web-bundle`) | manifest (id `media.paged.web`) + `activate(host)`: commands, the panel, the importer, the engine loader, render, flow and bake — built from host surfaces + React only |
| `packages/web-render` | Rust: the Blitz capture, the lowering to scene layers and the flow fragmentation, compiled to the bundle's `bin/blitz_web*.wasm` |

## Setup

`@paged-media/plugin-api` and `@paged-media/plugin-sdk` come from npm (exact pins);
no sibling checkout is needed.

```bash
pnpm install
bash scripts/build-wasm.sh --engine   # the engine wasm the tests boot (needs the
                                      # wasm-bindgen-cli version in web-render's Cargo.lock)
pnpm -r typecheck && REQUIRE_REAL_ENGINE=1 pnpm -r test
(cd packages/web-render && cargo test --features blitz)
```

`web-bundle/test/conformance/` runs the bundle against the real engine through
the plugin SDK's headless host (`createHeadlessHost`).

## License

Dual-licensed **AGPL-3.0 OR the Paged Media Enterprise License (PMEL)** —
the same as the paged editor (a plugin is part of the editor app). The engine
(`paged-media/core`) and the plugin SDK (`paged-media/plugin-sdk`) it builds on
are MPL-2.0 OR PMEL. See [`LICENSE.md`](./LICENSE.md), [`LICENSE`](./LICENSE),
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`
