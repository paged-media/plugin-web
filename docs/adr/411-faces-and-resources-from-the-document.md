# ADR 411 — A render takes its faces and resources from the document, never the network

- **Status:** Accepted, 2026-10-05.
- **Scope:** `packages/web-render/src/fonts.rs`, `resources.rs`, `boundary.rs` (the
  `register_font`, `register_resource`, `has_resource`, `take_resource_misses` and
  `take_text_advances` exports), `packages/web-bundle/src/engine-inputs.ts`,
  `source-part.ts` (resource parts), `bake-plan.ts`

## Context

The engine shaped every run with one bundled face, so bold and italic text was laid out in
the regular face, and a family nobody had registered shaped to nothing: the text vanished.
Images, linked stylesheets and `@font-face` sources never loaded, because the engine had no
network provider. The scene text item carried a family hint that the host ignored, and the
bake set no face at all.

A web frame is document content. It must render the same offline, on another machine and in
a year; a URL that answers today is not a resource of the document.

## Decision

- **Faces.** The host registers faces with the engine through `register_font(bytes, family)`:
  the document fonts the asset store serves for the families the CSS names, in the styles the
  source uses. A face is registered once into the engine's font context, which every render
  clones, so registering costs no context rebuild. The bundled face is the fallback for every
  script it covers, as a browser falls back to its default face.
- **Resources.** A source's relative URLs resolve against a fixed base that cannot reach a
  network. The host reads each URL the source writes (`<img src>`, `<link rel=stylesheet>`,
  CSS `url()` and `@import`, recursively through stylesheets it loaded) from the container
  part `resources/<path>`, or a `paged-image:<element id>` URL from the asset store's placed
  images, and registers the bytes once per engine. `data:` URIs decode in the engine. Every
  other request is a miss, reported after the render as a problem.
- **Faces on the wire.** Each text run names the family of the face it was shaped with, and
  its weight and italic when not regular (the scene text fields of protocol 68). A host that
  draws faces reports the ones it drew in its default font; those become problems, except the
  bundled face, which the plugin has no door to register with the host.
- **Faces in the bake.** A baked run sets its character font family and, when not regular,
  its style, and its frame is sized to the advance the engine shaped
  (`take_text_advances`, outside the render's own output).

## Evidence

- `packages/web-render/tests/faces_resources.rs`: bold and italic runs carry their face and a
  bold run shapes wider; an unregistered family falls back instead of vanishing; a registered
  face shapes under the family the source names; `<img>`, `data:`, CSS backgrounds, linked
  stylesheets, `@font-face` sources and `paged-image:` URLs load; misses are reported.
- `packages/web-render/tests/perf_budgets.rs` (`resources_and_faces`): an `<img>` loads in the
  one resolve every render does, a CSS background costs exactly one more, a face registered
  twice is registered once and builds no font context.
- `packages/web-bundle/test/conformance/bake.spec.ts`: against the real engine, a bake with
  faces, a gradient, opacity, a drop shadow and an image applies as one batch.
- `packages/web-conformance/indesign/answers/`: InDesign opens bold runs as Inter Bold and keeps
  the shadow, gradient, opacity, subpaths and image.

## Alternatives considered

- **Fetch URLs from the network in the host.** Renders would depend on what a server answers
  today, and a document would differ between machines; the plugin declares no network access.
- **Inline every resource into the HTML as `data:` URIs before each render.** The bytes would
  cross the wasm boundary on every render and every flow frame instead of once per engine.
- **Rebuild the font context per render with the source's faces.** Correct, but it repeats the
  most expensive set-up work the engine has on every render.
- **Put each run's shaped advance on the scene item.** The renderer has no use for it, and every
  render would pay the bytes; the bake reads it from a separate export instead.

## Consequences

- Line breaks are computed in the face the run is drawn in, wherever the host has the face.
- A resource the document does not hold is never shown and is always named. Bringing files
  into the container is a separate step (the importer does not do it yet).
- Registered faces and resources live as long as the engine instance; a part changed under
  the same path is not re-read until the engine restarts.
- Regular runs cross the wire byte-for-byte as before; the face fields of other runs and the
  face ops of a bake have budgets of their own.

## Related

- [ADR 402](402-text-crosses-as-strings.md) — text crosses as strings; the face now crosses
  with it.
- [ADR 403](403-json-wasm-boundary.md) — the boundary gains byte-taking exports.
- [ADR 407](407-baking-flattens-to-native-items.md) — the bake this widens.
- [ADR 408](408-no-page-javascript.md) — nothing in a source executes; nothing in it fetches.

## Amendment 2026-10-06

The faces a source's own `@font-face` rules load (a container part `resources/<path>` or a
`data:` URI) now reach the canvas as well. The engine names a run shaped with such a face by
the face's own `name` table family, not the family the CSS declares, so the host side
(`packages/web-bundle/src/engine-inputs.ts`, rule scanner in `css-faces.ts`) hands the bytes to
the scene-layer face table under both names, in the rule's weight and style, once per host,
family, style and bytes. Each render records which frame used which face; after each
auto-render pass the faces no live web frame used are given back. A face held only as WOFF or
WOFF2 (the canvas reads TrueType and OpenType) or over the per-face asset budget is reported
as a problem instead. Evidence: `packages/web-bundle/test/engine-inputs.spec.ts` ("@font-face
faces reach the canvas") and `test/conformance/scene-faces.spec.ts` (real host and engine: no
fallback for the family, the document's Fonts collection unchanged, fallback again once given
back).
