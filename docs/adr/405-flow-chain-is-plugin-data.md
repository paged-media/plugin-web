# ADR 405 — The frame chain of a web flow is plugin data on the source frame

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-model/src/source.ts` and `css-flow.ts`,
  `packages/web-bundle/src/render-flow-command.ts` and the flow functions in `bake.ts`

## Context

Fragmenting a document across frames ([ADR 404](404-fragmentation-by-relayout.md)) needs an
ordered list of frames. The first form took that list from the current selection only and
stored nothing. The header of the flow commands calls the stored chain
"the fix for the earlier ephemeral, selection-only chain"; it rides the source envelope
"so it survives reopen" (`packages/web-bundle/src/render-flow-command.ts:22-26`).

The chain is kept as the plugin's own data. It is not a host text thread and not a host
region chain. The repository does not record why.

The source's CSS may name what flows with CSS Regions syntax (`flow-into`, `flow-from`).
Stylo and Blitz "do not implement these (deprecated) properties, so the plugin parses them
itself" (`packages/web-model/src/css-flow.ts:19-21`).

## Decision

A web flow's chain is an ordered `recipients` list stored in the `flow` field of the source
frame's own envelope ([ADR 406](406-web-frame-and-source-storage.md)). The source frame is
the implicit first frame and is not listed.

- A recipient is `{ kind, id, flow? }`: a host element id plus an optional flow name. On
  read the list is de-duplicated by id, and a malformed chain reads as "not threaded".
- The chain is edited by three commands (thread, unthread, thread into the named flow) and
  by a picker in the source panel. Each edit is saved through `persistSource`.
- "Render web flow" renders the stored chain when there is one. Without one, a selection of
  two or more frames is used once and not saved.
- `flow-into` rules are found by a regular-expression scanner in `web-model`. The first
  rule's selector is the root of the primary flow; a later name is a secondary flow, and a
  recipient tagged with that name belongs to it. Each flow group is rendered in its own
  engine pass over its own frames, with its selector passed as the flow root.
- `flow-from` is not used. Recipients are always frames on the page; a `flow-from` rule only
  produces an info diagnostic.
- Content left after the last frame is reported as a warning diagnostic.

## Evidence

- `packages/web-model/src/source.ts:85-103`, `:117-146`, `:156-161` — `WebFlowRecipient`,
  `WebFlowChain`, the normaliser, the `flow` field
- `packages/web-model/src/source.ts:259-283` — `flowChainOf` (primary chain) and `flowGroups`
- `packages/web-bundle/src/render-flow-command.ts:74-90` — the stored chain wins; the
  selection is the fallback
- `packages/web-bundle/src/render-flow-command.ts:166-219`, `:229-253`, `:261-305` — the
  three editing commands
- `packages/web-model/src/css-flow.ts:39-51`, `:104-118`, `:148-154` — the scanner, the
  selector per flow name, the `flow-from` note
- `packages/web-bundle/src/bake.ts:507-537` — one `engine.renderFlow` call per flow group
- `packages/web-bundle/src/bake.ts:428-435`, `:539-546` — the overset warning

## Alternatives considered

The selection-only chain was the earlier form and remains as the fallback
(`render-flow-command.ts:89`, `:115-124`). No alternative for where the chain lives is
recorded.

## Consequences

No mutation issued by the bundle links frames in the host document; the chain exists only
in the envelope and changes only through the commands and the picker above. Nothing in this
repository updates the chain when a recipient frame is deleted.

Nothing re-flows by itself. The flow is rendered when a render command runs, no frame or
page is added when content does not fit, and overset is only reported.

Each named flow is a separate full run of the engine over the same composed document.

The scanner matches flat `selector { … }` blocks and ignores at-rules and nesting
(`css-flow.ts:35-38`).

`packages/web-model/src/render.ts:212-288` still carries a host-independent flow request shape with a
`FlowId` type and a `renderWebFlow` function that always returns the not-loaded result. The
real path does not use it (`packages/web-bundle/src/bake.ts:358-361`).

The flatten to native items ([ADR 407](407-baking-flattens-to-native-items.md)) follows the
primary chain only: it resolves the chain with `flowChainOf`, which leaves out recipients
tagged with a flow name (`render-flow-command.ts:83-87`, `source.ts:259-265`).

## Related

- [ADR 020](020-paged-web-native-engine-defer-frame-threading.md) — frame threading for web content
- [ADR 404](404-fragmentation-by-relayout.md) — how the engine fragments over the chain
- [ADR 406](406-web-frame-and-source-storage.md) — the envelope that holds the chain
- [ADR 026](https://github.com/paged-media/core/blob/main/docs/adr/026-auto-growing-region-chains.md) — region chains in the host engine, which this chain does not use
