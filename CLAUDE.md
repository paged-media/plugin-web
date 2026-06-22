# CLAUDE.md

Orientation for Claude sessions in **paged-media/plugin-web** — the
paged.web plugin (public; dual-licensed AGPL-3.0 OR PMEL, And The Next
GmbH; license headers on every source file).

## What this is

HTML/CSS as a content type for the Paged editor (concept:
`thoughts/docs/paged/plugin-web/base-idea.md`; v0 = the source lane, see
README). Two packages: `web-model` (pure source model + diagnostics
linter) and `web-bundle` (manifest + `activate(host)` + the source
panel).

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
- **Honest seams.** The remaining gaps are tracked in the RFI
  (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`, W-01 in
  §6) — never fake them. Landed since: the `codeEditor` widget IS
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
  diagnostics behind the ~300 ms debounce; the document is written ONLY
  by the explicit "Save to document" action (`persistDraft` — one
  undoable metadata mutation per save). Don't re-conflate them.
- **Styling = the token layer** (`--pg-*`, `--status-*`, `--font-mono`,
  `--space-*`, `--radius-*`, `--tracking-wide`): sentence case labels,
  uppercase kickers, mono tabular code, hairline borders, no hardcoded
  chrome hexes. Content colours (the preview's paper white) stay
  literal by design.
- **Install order:** editor → plugin-sdk → plugin-web (`link:` chain).

## Commands

```bash
pnpm install && pnpm -r test && pnpm -r typecheck
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/web-bundle/manifest.json
```
