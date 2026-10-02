# ADR 404 — A flow is fragmented by laying out the remainder again

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-render/src/flow.rs` and the `render_web_flow` export in `lib.rs`

## Context

A web flow is one HTML document shown across an ordered chain of frames, which may differ in
width ([ADR 020](020-paged-web-native-engine-defer-frame-threading.md),
[ADR 405](405-flow-chain-is-plugin-data.md)). The crate drives Blitz with one viewport per
document (`set_viewport`, then `resolve`); splitting a document across frames is done by
this crate, not by the engine.

Laying the document out once and slicing the painted result into bands is valid only when
every frame has the same width, because no line is broken again
(`packages/web-render/src/flow.rs:71-78`).

The module states the mechanism it uses instead and why: after the consumed part is deleted
from the DOM and the document is resolved again at the next width, the remainder is
line-broken again, "through the pinned `BaseDocument`/mutator API with NO engine fork"
(`flow.rs:127-133`).

## Decision

The exported `render_web_flow` threads the document through the frames by repeating, for
each frame: set the viewport to that frame's width, resolve layout, capture the paint, plan
a cut, keep the paint commands whose vertical band starts above the cut, then delete what
was consumed from the DOM.

- Deletion uses `remove_node` for consumed blocks and `set_node_text` to drop the consumed
  prefix of a split paragraph. The next resolve then lays out only what is left, from the
  top.
- A cut falls between sibling blocks; at a line boundary inside a text paragraph (the last
  Parley line that fits, mapped back to DOM text nodes by counting non-whitespace
  characters); between the children of a container, recursively; or between the body rows
  of a table. Rows inside `<thead>` are never deleted, so the header is laid out again at
  the top of each following frame.
- A block that straddles the cut and is none of these moves whole to the next frame.
- The last frame keeps everything up to its height. Content below that sets `overset`.
- With a flow root selector, every element below `<body>` that is neither the root, one of
  its ancestors nor inside it is removed from the DOM before the loop. Text and comment
  nodes outside the root are left in place (`flow.rs:278-280`).

## Evidence

- `packages/web-render/src/lib.rs:116-122`, `packages/web-render/src/flow.rs:774-785` — the
  export and the JSON entry, which call the variable-width path
- `packages/web-render/src/flow.rs:189-249` — the per-frame loop: `set_viewport`, `resolve`,
  `capture_resolved`, the band filter, `remove_node`, `set_node_text`
- `packages/web-render/src/flow.rs:359-427` — `plan_blocks_cut`: paragraph split, table
  rows, container descent, whole-block move
- `packages/web-render/src/flow.rs:595-681` — `try_split`; `:619-626` the non-whitespace
  mapping
- `packages/web-render/src/flow.rs:386-391`, `:497-509`, `:538-557` — body rows, the header
  repeat, and the row band taken from cell geometry because the row has no layout box
- `packages/web-render/src/flow.rs:162-179` — pruning to the flow root
- `packages/web-render/src/flow.rs:228-233` — `overset` on the last frame

## Alternatives considered

`render_web_flow_equalwidth` lays out once and slices the display list by band. It is still
in the file (`flow.rs:79-118`) and in the tests, and its comment gives its limit: equal
widths only, and a box that straddles a boundary appears in both frames. The export does not
reach it.

## Consequences

Each frame costs one full layout and one full paint of the remaining document. The code
depends on the pinned Blitz version's API ([ADR 401](401-layout-engine-pinned.md)): `mutate`,
`remove_node`, `set_node_text`, `query_selector`, `inline_layout_data`, `final_layout` and
`absolute_position`.

Cuts are planned from geometry only. `flow.rs` contains no handling of the CSS `break-*`
properties, `orphans` or `widows`. A table row, an image and the replaced or form elements
listed at `flow.rs:455-468` are never split; a row or block taller than a frame moves on
whole.

Paint commands are selected by vertical band, not clipped (`flow.rs:219-224`). A table's
column widths are resolved again in each frame and may shift between fragments
(`flow.rs:494-496`). When no line fits, or the split offset cannot be mapped to the DOM
text, the paragraph is not split and moves whole (`flow.rs:614-617`, `:653`, `:676-678`).

Comments contradict the code. The module header (`flow.rs:19-37`) and `lib.rs:80-81` call
this a feasibility prototype that is "not shipped" and works at block granularity; the
module backs a wasm export and splits paragraphs, containers and tables.

## Related

- [ADR 020](020-paged-web-native-engine-defer-frame-threading.md) — fragmentation without a forked engine
- [ADR 405](405-flow-chain-is-plugin-data.md) — where the list of frames comes from
- [ADR 401](401-layout-engine-pinned.md), [ADR 403](403-json-wasm-boundary.md) — the pinned engine API this relies on; the JSON shape of the result
