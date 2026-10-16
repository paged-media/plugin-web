# ADR 414 — The faces a bake gives the document are kept with it and given back on open

- **Status:** Accepted, 2026-10-15.
- **Scope:** `packages/web-bundle/src/document-faces.ts` (`keepDocumentFaces`,
  `giveBackDocumentFaces`, `startDocumentFaces`), `source-part.ts` (the `faces/` parts),
  `parts-gc.ts` (their collection), `bake-to-document.ts`, `activate.ts`. Amends
  [ADR 411](411-faces-and-resources-from-the-document.md) (its amendments of 2026-10-12 and
  2026-10-14).

## Context

A bake gives the document the faces its runs were shaped in and the document holds none for:
the bundled Inter, or a face a source's `@font-face` rule loads (ADR 411). It gives them through
the plugin API's document-face door, and a face given that way is never saved with the document.
A document names its fonts and carries no face bytes. The baked text that names the face is
saved, though.

How long the face lived used to hide this. The engine kept a face for the session, so a document
reopened in the same session still had it, and the gap showed only in a new session. Since plugin
SDK ADR 330 (`assets.documentFont@2`) a face lives as long as the document it was given to. Every
reopen, the same session included, now shows the baked text as missing and draws it in a
substitute. paged.web gave its faces only when it baked, never when a document opened.

Two ways to give them back:

- **Work them out again from what the document keeps.** The bundled face is in the engine; an
  `@font-face` face is in a source's rule, behind a container part or a `data:` URI. This fails
  in two cases. Without a record, the plugin cannot tell its baked text from any other text
  naming the same family, so it would give the bundled Inter to a document whose own Inter is
  missing (the rule plugin SDK DESIGN.md §13.6 exists for). And once the web frame is deleted
  after the bake, a common way to flatten, the source and its rules are gone. A `data:` face is
  then gone with them, and the source part is dropped on the next save (ADR 410). It also loads
  the engine (about 10 MB of wasm) on every open of a document that only holds baked text.
- **Keep a record of each face the bake gave.** This is correct in every case above: it survives
  deleting the frame, it names exactly the faces the bake gave, and giving them back needs no
  engine. It costs the face bytes in the document.

## Decision

- **The bake keeps each face it gave**, once the bake has applied, in a content-addressed
  container part `faces/<hash>.json`: `{ v: 1, family, style, face: <base64 bytes> }`, where
  `<hash>` is the content hash of that text, as for sources. A part is never overwritten; one
  already kept is not written again. A face the door refused is not kept. A face that could not
  be kept is reported as a problem.
- **Each time a document opens**, and for the document open when the bundle activates, the bundle
  lists the `faces/` parts. If there are any, it reads the Fonts collection. A kept face whose
  family the document's text names and lacks is given back through the same door. Nothing is
  read when the document carries no kept face or misses no family. A face the document refuses
  is a problem under `media.paged.web#faces`.
- **A record no text names is dropped on save.** The collector (ADR 410) marks a `faces/` part
  at open when no row of the Fonts collection names its family, and deletes it on save if that
  is still true and the session did not write it. That happens after an undone bake, or once the
  baked text is deleted.
- **Base64 in JSON, one part per face.** One self-describing part keeps the reader, the
  collector and the content addressing the same as for sources. The cost is a third more bytes
  before the container's compression. A face is kept once per document whatever the number of
  bakes; the bundled Inter is about 0.9 MB.

## Consequences

- A document with baked text reopens with its faces, in a new session as in the same one, with
  or without the web frame it was baked from, and on a host that scopes faces to the document as
  on one that keeps them for the session (where giving one back answers `held`).
- A document that bakes carries the faces it baked with. The bundled face is OFL. An
  `@font-face` face was already in the document, as a container part or inside the source.
- The bundle reads the Fonts collection on each open of a document that keeps faces.
- Plugin SDK ADR 330 says the faces must be given after the document opens. The open pass runs
  from `document.onDidOpen`, which fires after the engine holds the document.

## Related

- [ADR 411](411-faces-and-resources-from-the-document.md): the faces a bake gives.
- [ADR 410](410-unreachable-source-parts-dropped-on-save.md): the collector this widens.
- [ADR 409](409-label-is-the-truth-large-sources-by-pointer.md): the content-addressed parts it
  follows.
- Plugin SDK ADR 330: a document face lives as long as its document.
