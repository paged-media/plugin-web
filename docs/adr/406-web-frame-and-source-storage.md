# ADR 406 — A web frame is an ordinary rectangle claimed by metadata; its source lives in a container part

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-bundle/src/insert.ts`, `source-part.ts`, `edit-context.ts`,
  `activate.ts` (the importer), `packages/web-model/src/source.ts` and `import-html.ts`,
  the `objectTypes`, `partTypes` and `importers` entries of `packages/web-bundle/manifest.json`

## Context

HTML/CSS is a content type this plugin adds to the editor (`README.md:3`). The frame that
holds it "is an ordinary rectangle"; what makes it a web frame "is the metadata attached to
it" (`packages/web-bundle/src/insert.ts:23-25`). A rectangle is also what the frame
"degrades to without the plugin" (`packages/web-bundle/src/edit-context.ts:62-64`), and the
manifest declares that fallback (`packages/web-bundle/manifest.json:51-56`).

The source has had three homes. It started in plugin storage (`host.storage`). Commit
`3741e2e` moved it into document metadata, written in the same undoable batch as the frame,
so that one undo removes both (`insert.ts:19-25`). Commit `49df10b` added a container part,
for the reason given in `packages/web-bundle/src/source-part.ts:21-28`: the metadata label
"is capped at 64 KiB", "too small for real pages", while a part is "uncapped,
binary-friendly, and it travels WITH the file".

## Decision

A web frame is a plain rectangle that carries this plugin's metadata. Its HTML and CSS are
stored twice: in the metadata label, which marks the frame, and in a `.paged` container
part, which is read first.

- Insert is one batch: `insertFrame`, then `setPluginMetadata` on the rectangle just
  created, under the key `x-paged:media.paged.web`.
- The value is an envelope `{ v: 1, data: { html, css, options, vars?, flow? }, engine }`.
  An unknown version reads as "not a web frame". New fields are optional members of
  version 1, and each is sanitised on read.
- The object type `webFrame` matches exactly when the envelope loads, so "is a webFrame"
  and "has a loadable source" are one predicate (`edit-context.ts:34-38`).
- Saving from the panel (`persistDraft`) and from the flow commands (`persistSource`) writes
  the label and the part `paged/media.paged.web/<frame id>/source.json`. On a host without
  `storage.parts@1` the part write does nothing. Reads try the part, then the label.
- An `.html` or `.htm` file opens as the source of a new web frame. The importer moves
  `<style>` bodies into the CSS, keeps the inner content of `<body>` as the HTML, sanitises
  it ([ADR 408](408-no-page-javascript.md)) and calls the same insert. The file is not
  converted to native stories or styles.

## Evidence

- `packages/web-bundle/src/insert.ts:41`, `:66-84` — the key and the two-operation batch
- `packages/web-model/src/source.ts:198-219`, `:224-253` — envelope version 1, `envelopeFor`,
  `sourceFromEnvelope`
- `packages/web-bundle/src/edit-context.ts:53-65`, `packages/web-bundle/manifest.json:51-67`
  — the matcher; `objectTypes`, `partTypes` (`webSource`, role `spec`, `json`), `importers`
- `packages/web-bundle/src/source-part.ts:47-50`, `:54-63`, `:69-76`, `:80-97` — the part
  path, the gated write, both homes, the read
- `packages/web-bundle/src/panels/web-source-panel.tsx:291-302`, `:489-507` — `persistDraft`;
  read order and the one-time migration from plugin storage
- `packages/web-bundle/src/activate.ts:138-155`, `packages/web-model/src/import-html.ts:42-55`
  — the importer and the file splitter

## Alternatives considered

Plugin storage, and then the label alone, were the earlier homes (see Context). Plugin
storage is still read once to migrate old documents (`web-source-panel.tsx:496-505`).

## Consequences

The bundle stores only the source: its one `host.parts.write` call is `source-part.ts:62`.
A submitted scene layer is render-time content that the host does not keep across a reload
(`core: crates/paged-canvas/src/model.rs`, field `scene_layers`), and rendering runs only
from commands (`activate.ts:77-92`). A web frame therefore shows content on the canvas only
after a render command in the current session.

The two copies can differ. Insert (`insert.ts:66-84`), the panel's convert action
(`web-source-panel.tsx:574-577`) and the storage migration write the label only; the
part first appears on the next save. An imported `.html` file therefore enters through the
label, the home that `source-part.ts:22-23` describes as capped.

A conformance test pins that a label authored inside an IDML package is not returned by
`getMetadata` in the headless host
(`packages/web-bundle/test/conformance/source-roundtrip.spec.ts:136`); `README.md:55-60`
says the same. This repository does not prove the label's read path across a reload.

The part path contains the frame's element id. The importer reads the bytes of one file;
linked stylesheets, images and fonts are not ingested (`manifest.json:29`: `network: false`).

## Related

- [ADR 405](405-flow-chain-is-plugin-data.md), [ADR 407](407-baking-flattens-to-native-items.md), [ADR 408](408-no-page-javascript.md) — what else the envelope and the importer feed
- [ADR 010](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/010-raw-mutate-gate-capability-enforcement.md), [ADR 311](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/311-plugin-state-under-own-id.md) — the gate that checks the metadata key
- [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md), [ADR 017](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/017-importer-exporter-door-shape.md) — plugin content as valid native content; the importer door
- [ADR 118](https://github.com/paged-media/core/blob/main/docs/adr/118-paged-file-is-a-valid-idml-package.md), [ADR 021](https://github.com/paged-media/core/blob/main/docs/adr/021-paged-native-document-model-idml-as-format.md) — the container
- [ADR 506](https://github.com/paged-media/plugin-sheets/blob/main/docs/adr/506-workbook-in-a-container-part.md) — the same pattern in the sheet plugin
