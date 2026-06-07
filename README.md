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
- **Web frame panel** — HTML + CSS editors (token-styled, mono), a
  **sandboxed** live preview (`sandbox=""` — page JavaScript never executes,
  §6.1), `print`/`screen` media option, and a diagnostics list (policy
  errors like `<script>`, tag-balance warnings) that also feeds
  `host.diagnostics`.
- **Font registration parity** (W1, BREAKAGE_LOG W-01 follow-up) — the panel
  reads the document's registered font families (the `fonts` collection door —
  family NAMES only; no face bytes cross any door, so serving real
  `@font-face` is the W-06 dependency), checks them against the families the
  source CSS uses, and surfaces parity diagnostics ("font not in document" /
  "document font not previewable"). Because the preview can't load the document
  faces, it renders with browser defaults and **visibly badges** the
  substitution — the source lane stays honest about typography.
- **Persistence** via plugin storage keyed by element id — the
  `x-paged-web:*` metadata SHAPE (§5), pending engine-side document metadata
  (BREAKAGE_LOG W-02; does not round-trip IDML yet, and the UI says so).

The manifest already declares the forward contract: the `webFrame` object
type with `bakedFallback: "rectangle"` and the `webFrame` edit context —
both reserved host-side.

## Packages

| Package | Contents |
|---|---|
| `@paged-media/web-model` | pure TS, zero deps: `WebFrameSource` model, `composeSrcdoc`, the `diagnoseHtml` linter (policy + tag balance), and the font-parity scanner (`familiesUsed` / `fontParity` / `diagnoseFonts`) |
| `@paged-media/web-bundle` | manifest (id `media.paged.web`) + `activate(host)`: the panel, the insert command — built from host surfaces + React only |

## Setup

Sibling checkout layout (pnpm `link:` into `../plugin-sdk`; install order:
editor → plugin-sdk → here):

```bash
cd ~/paged/plugin-web && pnpm install
pnpm -r test && pnpm -r typecheck
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/web-bundle/manifest.json
```

`BREAKAGE_LOG.md` records every place the plugin surface fell short
(W-01…W-09) — together with plugin-draw's log, it is the API-v1 punch list.
