# paged-media/plugin-web

**paged.web** — HTML/CSS as a first-class content type for the Paged editor.
Concept: `thoughts/docs/paged/plugin-web/base-idea.md` ("InDesign can't speak
web. Webflow can't speak print."). Where paged.draw proves the platform hosts
a *tool*, paged.web proves it hosts a *foreign document model* — the second
half of the plugin platform's existential test.

## v0 scope — the source lane

The end-state rendering architecture (Blitz/WASM painting vector-true into
Vello, concept §4) is gated on the **W0 engine spike** in `core`. What ships
today is the honest slice API v0.2 carries:

- **Insert web frame** (command) — one undoable `insertFrame` on the active
  page; the default `WebFrameSource` is attached under the created element's
  key; the frame is selected and the source panel opens.
- **Web frame panel** — HTML + CSS editors: the HOST code editor
  (`host.widgets.CodeEditor`, W-04 — line numbers, highlighting, a
  diagnostics gutter) where `supports("widgets.codeEditor@1")` answers
  true, the bundle's own plain textarea otherwise (headless/conformance
  hosts; `data-web-editor-lane` says which). A **sandboxed** live
  preview (`sandbox=""` — page JavaScript never executes, §6.1)
  refreshes on keystroke behind a ~300 ms debounce; the **document is
  written only by the explicit "Save to document" action** (one
  undoable metadata mutation per save — preview refresh ≠ document
  write). Frame options: `print`/`screen` media, a viewport width
  (applied as the preview iframe's element width — the real CSS
  viewport), and the overflow policy (fixed `clip`, a visible seam
  until the engine rendering lane). Diagnostics (policy errors like
  `<script>`, tag-balance warnings, font parity) render in the panel
  and feed `host.diagnostics` live.
- **Font registration parity + real document faces** (W1 + W-06) — the panel
  reads the document's registered font families (the `fonts` collection door —
  family NAMES), checks them against the families the source CSS uses, and
  surfaces parity diagnostics ("font not in document" / "document font not
  previewable"). Since W-06 landed end-to-end (the editor serves REAL engine
  font bytes through `host.assets.getFontFace`, v43), the panel resolves each
  used+registered family's bytes and inlines them as a **data-url
  `@font-face`** in the preview srcdoc (`data:`, not `blob:` — the
  `sandbox=""` iframe's opaque origin can't fetch origin-bound object URLs);
  the substitution badge **flips to "document fonts shown"** for served
  families. A `null` answer (no bytes / older host) keeps the honest
  substitution badge.
- **Pre-render template pass** (§6.2 — the deterministic, NON-Turing slice):
  `{{name}}` substitution plus a closed whitelist of pure filters (`upper`,
  `lower`, `trim`, `number-format`), applied between the source and the
  preview/lint/font-parity lanes when the source carries a panel-edited
  **variables map** (persisted additively in the same envelope; legacy
  envelopes are untouched). Unresolved placeholders stay verbatim and
  diagnose — nothing is guessed. **This is NOT the Boa lane**: §6.2's
  scripted transforms (core's Boa engine, ADR-001, with real ScriptBudget
  enforcement) are the W2 follow-on tracked as RFI W-08; the panel and the
  code say so explicitly rather than faking arbitrary JS.
- **Persistence** as DOCUMENT METADATA (§5; W-02 landed): the
  `x-paged:media.paged.web` envelope written through
  `host.document.setMetadata`, undoable and IDML-carried in-session
  (the cross-reload IDML-authored-Label read remains an engine gap —
  see the conformance suite's pinned-gap test). Pre-metadata documents
  migrate one-time from plugin storage.

The manifest already declares the forward contract: the `webFrame` object
type with `bakedFallback: "rectangle"` and the `webFrame` edit context —
both reserved host-side.

## Packages

| Package | Contents |
|---|---|
| `@paged-media/web-model` | pure TS, zero deps: `WebFrameSource` model, `composeSrcdoc`, the `diagnoseHtml` linter (policy + tag balance), the font-parity scanner (`familiesUsed` / `fontParity` / `diagnoseFonts` / `fontFaceDataUrl`), and the deterministic template pass (`applyTemplate` / `renderWebFrameSource`) |
| `@paged-media/web-bundle` | manifest (id `media.paged.web`) + `activate(host)`: the panel, the insert command — built from host surfaces + React only |

## Setup

Sibling checkout layout (pnpm `link:` into `../plugin-sdk`; install order:
editor → plugin-sdk → here):

```bash
cd ~/paged/plugin-web && pnpm install
pnpm -r test && pnpm -r typecheck
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/web-bundle/manifest.json
```

### Conformance corpus (W4.15)

`web-bundle/test/` carries a headless **conformance-fixture corpus** on
the B-13 foundation (`@paged-media/plugin-sdk`'s `createHeadlessHost` —
the published engine wasm booted in Node):

- `fixtures/build-idml.ts` — a pure-TS IDML package builder (no `zip`
  CLI, deterministic bytes, multi-story documents); `fixtures/corpus.ts`
  — W1 empty page, W2 a document registering known font families via
  styles + story `AppliedFont`.
- `conformance/*.spec.ts` — `insert.spec.ts` (the bundle's insert command
  fired headlessly: the single-undo batch + source envelope + selection),
  `source-roundtrip.spec.ts` (metadata write/read/re-write/survive-mutate
  + the unknown-version null), `fonts-diagnostics.spec.ts` (the `fonts`
  collection door drives font parity; the §6.1 `<script>` error + font
  diagnostics assemble the publishable set). One wasm boot per spec-file
  (the host supports reload).

Findings + residuals (the `fonts` door populates from styles; source
metadata persists WITHIN a session but cross-reload IDML-authored-Label
read is not yet headless) are tracked under **W-10** in `BREAKAGE_LOG.md`.

`BREAKAGE_LOG.md` records every place the plugin surface fell short
(W-01…W-10) — together with plugin-draw's log, it is the API-v1 punch list.

## License

Dual-licensed **AGPL-3.0 OR the Paged Media Enterprise License (PMEL)** —
the same as the paged editor (a plugin is part of the editor app). The engine
(`paged-media/core`) and the plugin SDK (`paged-media/plugin-sdk`) it builds on
are MPL-2.0 OR PMEL. See [`LICENSE.md`](./LICENSE.md), [`LICENSE`](./LICENSE),
and [`CONTRIBUTING.md`](./CONTRIBUTING.md) (contributions under a CLA).

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL`
