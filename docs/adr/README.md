# Architecture decision records

An ADR records one load-bearing decision that has already been made: what was decided, what
in the code shows it, and what it obliges other code to do. It is a record, not a proposal.
When the code stops matching a record, the body is left as it is and a dated amendment is
added at the end.

ADR numbers are unique across the paged-media repositories, so a number names the same
record wherever it is cited. New records in this repository use 400–449. Records 011 and 020
predate that scheme and keep their numbers. Records 400–408 were written on 2026-10-02 from
the code as it stood, for decisions made earlier; their status says so.

| ADR | Title | Status |
|---|---|---|
| [011](011-web-rendering-fork-defer-to-scenelayer.md) | paged.web rendering: freeze the source lane for v1, lower via SceneLayer when rendering lands | Accepted (amended 2026-10-02) |
| [020](020-paged-web-native-engine-defer-frame-threading.md) | paged-web native engine: defer the fork; extend the SceneLayer lane for frame threading | Accepted (amended 2026-10-02) |
| [400](400-pure-lowering-and-capture-layer.md) | The renderer splits a pure lowering from an opt-in capture layer | Accepted, recorded retroactively 2026-10-02 |
| [401](401-layout-engine-pinned.md) | The layout engine is pinned exactly and used for style, layout and paint capture only | Accepted, recorded retroactively 2026-10-02 |
| [402](402-text-crosses-as-strings.md) | Text crosses to the page as plain strings; the engine repaints it | Accepted, recorded retroactively 2026-10-02 |
| [403](403-json-wasm-boundary.md) | The Rust/JS boundary is two string-in, JSON-out functions | Accepted, recorded retroactively 2026-10-02 |
| [404](404-fragmentation-by-relayout.md) | A flow is fragmented by laying out the remainder again | Accepted, recorded retroactively 2026-10-02 |
| [405](405-flow-chain-is-plugin-data.md) | The frame chain of a web flow is plugin data on the source frame | Accepted, recorded retroactively 2026-10-02 |
| [406](406-web-frame-and-source-storage.md) | A web frame is an ordinary rectangle claimed by metadata; its source lives in a container part | Accepted, recorded retroactively 2026-10-02; storage superseded by 409 |
| [407](407-baking-flattens-to-native-items.md) | Baking flattens a web frame into native page items; the plugin contributes no exporter | Accepted, recorded retroactively 2026-10-02 |
| [408](408-no-page-javascript.md) | Page JavaScript never executes; templating is a closed pass | Accepted, recorded retroactively 2026-10-02 |
| [409](409-label-is-the-truth-large-sources-by-pointer.md) | The label names the live source; a large source is a content-addressed part behind a pointer | Accepted 2026-10-05 |
| [410](410-unreachable-source-parts-dropped-on-save.md) | Source parts no label or undo step can reach are dropped on save | Accepted 2026-10-05 |

Decisions made in other repositories that this plugin's code rests on are listed in
[`../README.md`](../README.md).
