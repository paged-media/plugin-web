# ADR 410 — Source parts no label or undo step can reach are dropped on save

- **Status:** Accepted, 2026-10-05. Answers the open consequence of
  [ADR 409](409-label-is-the-truth-large-sources-by-pointer.md) ("saved versions of large
  sources accumulate as parts").
- **Scope:** `packages/web-bundle/src/parts-gc.ts`, `source-part.ts` (write record),
  `auto-render.ts` (`discoverWebFrames`)

## Context

ADR 409 writes a large source to a content-addressed part, `sources/<hash>.json`, never
overwritten, and points the undoable label at it. Container parts take no part in undo, so
a part that no label names today may still be named after an undo of this session; deleting
it when a label stops naming it would break that undo. Deleting a frame raises the same
question for its source part and for a legacy `<frame>/source.json`. Without a rule the parts
of every saved version of every large source travel with the file for ever.

## Decision

Reachability is judged at two moments, and only what is unreachable at both is dropped.

- **At open** (activation, or the editor's `documentLoaded`): the undo history is empty, so a
  part that no label names now can only be named again by a write of this session. The
  collector lists the parts and marks the unnamed ones: a `sources/<hash>.json` whose hash no
  web label points to, and a legacy `<frame>/source.json` whose frame the document does not
  have.
- **On save** (`document.onWillSave`): each marked part that no label names now and that this
  session did not write (`source-part.ts` records every part it writes) is deleted.

A part written in this session is never dropped by this session's saves; the next open
collects it. Paths that are not source parts are never judged. Deleting needs the engine's
delete door (`storage.parts@2`, protocol 66); without it, or when the engine refuses, nothing
is deleted and the save proceeds.

## Evidence

- `packages/web-bundle/src/parts-gc.ts` — the two moments and the rule.
- `packages/web-bundle/test/parts-gc.spec.ts` — on a modelled host: orphan content and legacy
  parts dropped; a named part, a part named again before the save, a session-written part and
  a non-source part kept; nothing dropped without the delete door.
- `packages/web-bundle/test/conformance/parts-gc.spec.ts` — the same against the real host
  (the delete case runs on an engine with protocol ≥ 66).

## Alternatives considered

- **Delete a frame's part with the frame.** Undo of the delete brings back a label pointing at
  a missing part.
- **Collect on every save by what labels name now.** Drops parts an undo of this session
  still needs (ADR 409's reason for content addressing).
- **Wait for undoable parts or an atomic label-and-part write in the engine.** The right end
  state; this rule is correct meanwhile and becomes unnecessary when parts follow undo.

## Consequences

- A document carries at most the parts of one session's history beyond what its labels name.
- Saving writes a deletion only for parts the opened file carried.
- When the engine makes parts undoable, this collector can collect on every save.
