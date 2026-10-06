# ADR 413 — Web frames, bound values and CSS variables are objects; document values live in the document label

- **Status:** Accepted 2026-10-06 (on the `om/object-model` branch, with the SDK contract
  0.2.43). Implements ADR 323 (the plugin object-model contract) for paged.web.
- **Scope:** `packages/web-bundle/src/object-model.ts`, `source-part.ts` (planned writes,
  document values), `bindings.ts` (`resolveDocumentVars`), `manifest.json`
  (`contributes.objectModel`), `packages/web-model/src/css-vars.ts`

## Context

ADR 323 gives every plugin one way to make its state addressable: object kinds with typed
property schemas, served through `host.objects` to scripts, the Node CLI, data bindings and
schema-driven panel fields. Before it, a web frame's source was reachable only through this
plugin's panel and its seven selection-driven commands, and the document's own template values
(`{{doc.<key>}}`) lived in a container part, `web/document-values.json`, which takes no part
in undo and which InDesign drops.

## Decision

1. **Three kinds**, declared once in the manifest and read from it at registration:
   - `webFrame` (`plugin:media.paged.web/webFrame/<frame id>`): `html`, `css`, `media`,
     `overflow`, `vars`, `flow` (writable); `viewportWidth`, `frame`, `storage`,
     `boundNames`, `cssVars` (read-only). Its content is the HTML lane.
   - `templateVar` (`…/templateVar/doc.<key>` and `…/templateVar/data.<field>`): the bound
     values a template names. `doc.<key>` is writable; `doc.title`, `doc.pages` and `data.*`
     are read from the document and the dataset provider and refuse writes with a reason.
   - `cssVar` (`…/cssVar/<frame id>/--<name>`): a CSS custom property, a view over the css
     lane (there is no CSS-variable model; the source text stays the truth). A write splices
     the first declaration's value and leaves every other byte as written; a value that would
     end the declaration or the block is refused.
2. **A write is the label-hash pattern.** The kind plans the new source, and the registry
   commits the frame's label (inline, or a pointer to a content-addressed part written first)
   in one engine batch with everything else the batch carries: one undo step, and undo
   restores the label, which names the previous source (ADR 409). Parts planned this way are
   recorded as written this session, so the collector (ADR 410) keeps them.
3. **Document values move to the document label** (`x-paged:media.paged.web` on the
   designmap, `{ v: 1, data: { values } }`), written with `setDocumentMetadata`: undoable,
   one batch with the rest, and preserved by InDesign. The legacy part is still read when the
   document carries no label map, so older documents keep their values until the next write.
4. **The seven commands are typed** (same ids): they take addresses instead of the selection,
   answer a typed result, and run headless. Thread and unthread write `webFrame.flow` through
   `host.objects`, so each is one undo step. The untyped commands stay for the menu and the
   palette.

## Consequences

- A data binding, a script or the CLI can set any web frame property, any document value and
  any CSS variable, and read back what the template pass and the bound values resolve to.
- Template bindings keep working as they do: the auto-renderer resolves `{{doc.*}}`,
  `{{frame.*}}` and `{{data.*}}` at render time. When the universal binding (ADR 558) lands,
  a `Binding::Property` targets `templateVar/doc.<key>.value` or `webFrame.vars` and lowers
  to one `host.objects.batch`; the private first-record read of a provider in `bindings.ts`
  then becomes a binding the data plugin applies, and `data.*` stays a read-only view of
  what the provider holds.
- Writes are planned by one plugin-level planner (the contribution's `batch`), so a batch
  that writes a frame through two kinds (`webFrame.css` and a `cssVar` of the same frame)
  composes both from one state.
