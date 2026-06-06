# CLAUDE.md

Orientation for Claude sessions in **paged-media/plugin-web** — the
paged.web plugin (private, proprietary, And The Next GmbH; no license
headers).

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
  the linter. Don't soften either.
- **Honest seams.** On-canvas rendering, IDML round-trip, the
  `codeEditor` widget, and the objectType/edit-context registrations
  are NOT implemented — the UI and the manifest say so explicitly, and
  `BREAKAGE_LOG.md` (W-01…) tracks each gap. Never fake them.
- **Styling = the token layer** (`--pg-*`, `--status-*`, `--font-mono`,
  `--space-*`, `--radius-*`, `--tracking-wide`): sentence case labels,
  uppercase kickers, mono tabular code, hairline borders, no hardcoded
  chrome hexes. Content colours (the preview's paper white) stay
  literal by design.
- **Install order:** editor → sdk → plugin-web (`link:` chain).

## Commands

```bash
pnpm install && pnpm -r test && pnpm -r typecheck
node ../sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/web-bundle/manifest.json
```
