# ADR 409 — The label names the live source; a large source is a content-addressed part behind a pointer

- **Status:** Accepted, 2026-10-05. Supersedes the storage half of
  [ADR 406](406-web-frame-and-source-storage.md) (a web frame is still an ordinary rectangle
  claimed by metadata).
- **Scope:** `packages/web-bundle/src/source-part.ts`, `insert.ts`,
  `panels/web-source-panel.tsx`, `edit-context.ts`; `packages/web-model/src/source.ts`

## Context

ADR 406 kept the source in two homes: the frame's metadata label and a container part at
`<frame id>/source.json`, and every reader preferred the part. The two homes follow
different rules. The label is written through the document's mutation door, so undo and redo
restore it; the engine caps one label at 64 KiB. A part is uncapped and travels with the
`.paged` file, but parts take no part in undo (plugin-api `PartsSurface`).

Two defects followed. Undo of "Save to document" restored the label while every reader kept
reading the part, so undo changed nothing visible and the homes diverged. And a source over
64 KiB could not be inserted or imported at all (the label inside the insert batch was
refused, failing the batch), while a large save wrote the part but not the label, leaving
the panel "unsaved" for good.

## Decision

The label is the truth, because it is what undo restores.

- A source whose envelope fits (60 KiB, below the engine's 64 KiB cap) is stored inline in
  the label and nowhere else.
- A larger source is written to a content-addressed part, `sources/<hash>.json` (a 64-bit
  content hash of the envelope text), and the label holds a pointer
  `{ v: 1, data: { ref: { hash, bytes } }, engine }`. A part is written once and never
  overwritten, so every version a label can name — including the ones undo returns to —
  still exists.
- One reader, `loadWebSource`, and one writer, `writeWebSource` (insert uses
  `prepareSourceLabel` to put the label in its batch), in `source-part.ts`. A part whose
  content does not hash to the pointer is not read. No label over the cap is ever sent; a
  source that cannot be stored (no container parts on the host) is refused with a
  diagnostic.
- Legacy documents: a `<frame id>/source.json` part is read only when the label has no
  source, or when the part is larger than a label can hold (so the label could never have
  mirrored it).

## Evidence

- `packages/web-model/src/source.ts:233` — the inline limit; `:292` `storeSource` decides
  inline vs part; `:307` `sourceRefOf` reads a pointer.
- `packages/web-bundle/src/source-part.ts:76` `loadWebSource`, `:125`
  `prepareSourceLabel`, `:149` `writeWebSource`.
- `packages/web-bundle/test/source-persistence.spec.ts` — undo of small, large and
  mixed-size saves; large save/insert/import; refusals as diagnostics; the guard that no
  other file reads metadata or parts.
- `packages/web-bundle/test/conformance/persistence.spec.ts` — the same against the real
  engine (its 64 KiB refusal, its undo, a large `.html` import through the bundle's
  importer). Against the previous reader and writer three of its four cases fail.

## Alternatives considered

- **Keep reading the part first, rewrite the part on undo.** The plugin is not told what an
  undo restored in time to rewrite parts consistently, and redo would need the same; the
  label already carries exactly that history.
- **Always write a part, label as pointer only.** Undo-correct too, but every small source
  would need container parts to be read at all, and the label would stop being readable
  through IDML for the common case.
- **Split a large source over several labels.** Each label is still capped, the batch grows
  with the source, and IDML gains many opaque key-value pairs; the container exists for this.

## Consequences

- Undo and redo of a save are correct for every reader (panel, render, flow, bake);
  specs pin it on a modelled host and against the real engine.
- Small sources stay portable through IDML in the label, as before; a large one needs the
  `.paged` container.
- Saved versions of large sources accumulate as parts. Removing those no label and no undo
  step can reach needs an answer from the host (undoable parts, or an atomic label-and-part
  write); until then nothing is deleted.
- The object type recognises a pointer label as a web frame (`isWebFrameEnvelope`).

## Related

- [ADR 406](406-web-frame-and-source-storage.md) — the earlier storage decision
- [ADR 405](405-flow-chain-is-plugin-data.md) — the flow chain rides the same envelope

## Amendment 2026-10-05

The accumulation in Consequences is answered by [ADR 410](410-unreachable-source-parts-dropped-on-save.md):
parts unreachable both when the document opened and at a save, and not written in that
session, are dropped on save.
