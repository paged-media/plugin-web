# CLAUDE.md

Orientation for Claude sessions in **paged-media/plugin-web** — the
paged.web plugin (public; dual-licensed AGPL-3.0 OR PMEL, And The Next
GmbH; license headers on every source file).

## What this is

HTML/CSS as a content type for the Paged editor (concept:
`docs/concept.md`; architecture, status, decisions and the latest analysis are in
`docs/`). Three packages: `web-model` (pure source model, storage envelope,
linter), `web-bundle` (manifest + `activate(host)`: commands, panel, importer,
render/flow/bake) and `web-render` (Rust: Blitz capture, lowering, flow
fragmentation → the bundle's engine wasm).

## Hard rules

- **`web-model` stays pure** — zero deps, no DOM APIs (the linter is a
  scanner, not a parser; it must never crash on bad input). Every
  behavior change lands with a vitest case.
- **The bundle touches host surfaces + React only.** No
  `@paged-media/shell`/`client` imports — selection reactivity comes
  from `host.selection.onDidChange`, persistence from `host.storage`,
  problems from `host.diagnostics`. The panel is created by a factory
  closing over the `BundleHost`.
- **Page JavaScript never executes** (§6.1 — product stance): the
  preview iframe keeps `sandbox=""`; `<script>` stays a policy ERROR in
  the linter. Don't soften either. (The journey + e2e suites see the
  browser log "Blocked script execution in 'about:srcdoc'" — that is
  this rule working, not a failure.)
- **Honest seams.** The remaining gaps are tracked in the internal gap
  register (W-01) and summarised in `docs/status.md` — never fake them. Landed since: the `codeEditor` widget IS
  consumed (probe `widgets.codeEditor@1`, bundle-owned textarea
  fallback), objectType/edit-context registered (W-03), metadata
  round-trips in-session (W-02), font bytes via the capability-gated
  asset store (W-06 — REAL editor bytes since v43, inlined as data-url
  `@font-face`; `blob:` can't cross into the opaque-origin sandbox),
  and the §6.2 DETERMINISTIC template pass (`{{name}}` + a closed
  pure-filter whitelist, vars persisted in the envelope). The scripted
  Boa transform lane (W-08) is the W2 follow-on — never grow the
  template pass into an expression language.
- **On-canvas rendering NOW SHIPS (ADR-011 Option B), but stays
  honest.** The Blitz/WASM W0 spike landed: `web-render` is a real
  crate, compiled to the bundle's `bin/blitz_web*.wasm` (the full
  Stylo/Taffy/Parley stack + vendored OFL font; gitignored generated
  output). The bundle contributes
  `media.paged.web.command.renderWebFrame` ("Render web frame to
  canvas") — `engine-loader.ts` loads the wasm (manifest
  `capabilities.wasm ∋ blitz`, purpose `engine`), `render-command.ts`
  renders the selected frame's source to a **real C-1 `SceneLayer`**
  and submits it so core composes it inside the frame. When the engine
  can't load (no artifact built / a realm that can't fetch the sibling
  asset), it FALLS BACK to the "engine not loaded" diagnostic + the
  sandboxed source-lane preview — never a fake render. Parts of the IR
  surface (per-fill blend, gradient strokes, gradient-in-blend,
  clip-in-blend) are built + contract-tested but DORMANT — real Blitz
  emits no such layers yet (accept-dormant per the ADR-011 addendum;
  the reachability tests flip to live the day Blitz implements them).
- **Preview ≠ persistence.** Keystrokes refresh the sandboxed preview +
  diagnostics behind the ~300 ms debounce and never write the document.
  The panel writes it only on "Save to document" (and "Make web frame");
  outside the panel, insert/import and the thread/unthread commands write
  it. Unsaved drafts are kept per frame in the panel (`draft-store.ts`).
- **One reader, one writer for the source** (`source-part.ts`):
  `loadWebSource` / `writeWebSource` (insert uses `prepareSourceLabel`). A
  source that fits stays inline in the metadata LABEL (undoable, 64 KiB
  engine cap); a larger one goes to a content-addressed container PART
  (`sources/<hash>.json`, never overwritten — parts are not undoable) and
  the label holds a pointer. The label is the truth undo restores; never
  read metadata or parts anywhere else (a spec enforces it), never send a
  label over the cap, and surface a refusal as a diagnostic.
- **Styling = the token layer** (`--pg-*`, `--status-*`, `--font-mono`,
  `--space-*`, `--radius-*`, `--tracking-wide`): sentence case labels,
  uppercase kickers, mono tabular code, hairline borders, no hardcoded
  chrome hexes. Content colours (the preview's paper white) stay
  literal by design.
- **Contract pins:** `@paged-media/plugin-api` / `plugin-sdk` are exact npm
  devDependency pins (peers keep a `>=` floor); `sdk-pin.spec.ts` checks it.
- **Engine wasm freshness:** after any Rust change run
  `bash scripts/build-wasm.sh --engine` (wasm-bindgen-cli must equal the
  version in `packages/web-render/Cargo.lock`); `wasm-fresh.spec.ts` fails on
  a stale artifact. A source change needs a version bump to publish
  (`scripts/package-hash.mjs --check`).

## Commands

```bash
pnpm install && bash scripts/build-wasm.sh --engine
pnpm -r typecheck && REQUIRE_REAL_ENGINE=1 pnpm -r test
(cd packages/web-render && cargo fmt --check && cargo clippy --all-targets --features blitz -- -D warnings && cargo test --features blitz)
```
