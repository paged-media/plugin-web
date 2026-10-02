# ADR 407 — Baking flattens a web frame into native page items; the plugin contributes no exporter

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-bundle/src/bake-plan.ts`, `bake-to-document.ts`, the command
  `media.paged.web.command.bakeWebFrame`, and the `contributes` section of the manifest

## Context

The code uses "bake" for two different things.

1. **Render to a scene layer.** `bake.ts` (`bakeWebFrame`, `bakeWebFlow`, `bakeWebFlows`),
   behind the commands "Render web frame to canvas" and "Render web flow across frames",
   submits a scene layer to a host surface that is created once per host and never disposed
   (`packages/web-bundle/src/bake.ts:75-101`). The layer is paint held for the session.
2. **Flatten to native page items.** `bake-plan.ts` and `bake-to-document.ts`, behind the
   command "Bake web frame to document" (`bakeSelectedWebFrame`), create ordinary
   rectangles, paths and text frames in the document.

This ADR is about the second meaning; "bake" and "flatten" below mean that. The planner's
header gives the reason: flattening exists so that a web document "exports to
IDML/PDF through core's own native export and a foreign open sees real content (no plugin
engine needed)" (`packages/web-bundle/src/bake-plan.ts:19-22`). The design follows the sheet
plugin's lowering: a pure plan, and an impure executor that resolves created ids between
phases (`bake-plan.ts:22-27`, `packages/web-bundle/src/bake-to-document.ts:26-31`).

## Decision

The flatten is the only way this plugin puts web content into the document itself. The
plugin contributes no exporter and writes no export format; export is left to the host,
which writes what the document contains.

- `sceneLayerToBakePlan` is a pure function from a scene layer to a plan. A text item
  becomes a text entry. A solid fill that is an axis-aligned rectangle becomes a rectangle;
  any other solid fill with a single subpath becomes a path. Colours are de-duplicated into
  RGB swatches named `Color/wb-RRGGBB`. Every other item (image, multi-subpath fill, stroke,
  gradient, shadow) is counted in `deferred`.
- `materializePlan` executes the plan as document mutations at the frame's page origin: one
  batch of `createSwatch`; per rectangle `insertFrame` plus `frameFillColor`; per path
  `insertPath` plus `frameFillColor`; per text run `insertTextFrame`, `insertText`,
  `characterFontSize` and `characterFillColor`.
- A threaded flow is flattened frame by frame: the chain is rendered with the scene-layer
  submit switched off and each frame's layer is materialised in that frame.
- `deferred` counts become a warning diagnostic. Without a loaded engine nothing is created.
- The manifest's `contributes` section lists no exporter.

## Evidence

- `packages/web-bundle/src/bake-plan.ts:19-34`, `:161-244` — purpose and scope; the plan
  (text, rectangle, path, swatches, `deferred`)
- `packages/web-bundle/src/bake-to-document.ts:202-324`, `:348-377`, `:387-440` —
  `materializePlan`; the command handler; the flow variant
- `packages/web-bundle/src/bake.ts:313-322`, `packages/web-bundle/src/activate.ts:77-82`,
  `:122-127` — the `submit` option; the render command and the bake command are different
- `packages/web-bundle/manifest.json:32-68` — `contributes` has no exporter

## Alternatives considered

None recorded in the repository.

## Consequences

Export fidelity is the flatten's coverage. Strokes, gradients, shadows, images and
multi-subpath fills that the canvas shows are not in the flattened document. Text is one
frame per run with a size and a colour, in the document's default face
(`bake-to-document.ts:33-37`); see [ADR 402](402-text-crosses-as-strings.md). For a flow,
only the primary chain is flattened ([ADR 405](405-flow-chain-is-plugin-data.md)).

The flatten is not the only way web content can reach an export. The host engine builds
its export from the same options as the live canvas, and those include the scene layers
submitted in the session (`core: crates/paged-canvas/src/model.rs:8559`, in
`pipeline_options`). A PDF exported in a session where a render command has run can
therefore include the scene layer without a flatten. An IDML export, and anything done after a reload, cannot: the
layer is not document content. This repository does not test that path.

The flatten adds items. It does not remove the web frame, its source or a submitted scene
layer, and it writes no marker, so the bundle cannot tell a flattened frame from one that
is not. It adds `Color/wb-…` swatches to the document's swatch list.

It is not one undo step: each rectangle and each path is a batch, and each text run is four
separate mutations (`bake-to-document.ts:299-319`). A text frame whose new story cannot be
identified by comparing the story list before and after is left empty and not counted
(`bake-to-document.ts:85-92`, `:304-306`). The header of `bake.ts` (`:33-36`) still says the
flatten is "not implemented"; it shipped in commit `fdbe007`.

## Related

- [ADR 011](011-web-rendering-fork-defer-to-scenelayer.md), [ADR 020](020-paged-web-native-engine-defer-frame-threading.md) — rendering and flow for web content
- [ADR 402](402-text-crosses-as-strings.md), [ADR 405](405-flow-chain-is-plugin-data.md), [ADR 406](406-web-frame-and-source-storage.md) — the limits the flatten inherits
- [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md), [ADR 310](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/310-one-write-door.md), [ADR 017](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/017-importer-exporter-door-shape.md) — baking as the fallback for plugin content; the write door; the exporter door this plugin does not use
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md), [ADR 505](https://github.com/paged-media/plugin-sheets/blob/main/docs/adr/505-native-table-and-edit-grid.md) — the scene layer; the sheet plugin's lowering to native content
