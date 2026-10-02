# ADR 408 — Page JavaScript never executes; templating is a closed pass

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `40792fa`.
- **Scope:** `packages/web-model/src/diagnose.ts`, `sanitize.ts`, `import-html.ts`,
  `transform.ts`; the preview in `packages/web-bundle/src/panels/web-source-panel.tsx`;
  `packages/web-bundle/src/panels/ingest.ts`; the dependency list of `packages/web-render`

## Context

HTML that a user pastes or opens can carry scripts. The code treats "page JavaScript never
executes in a web frame" as platform policy (`packages/web-model/src/diagnose.ts:75-76`,
`packages/web-model/src/sanitize.ts:21-24`) and refers to a section of the original design
spec, which is not part of this repository. The repository does not record why.

What the repository does record is how far the rule goes. For content brought in from
outside the editor it "must be ENFORCED, not merely diagnosed" (`sanitize.ts:19-24`).

The plugin also has a pre-render step that fills variables into the source. The template
module says where real scripting belongs: in the host engine's Boa runtime, under a script
budget. Doing it in the bundle "would mean embedding a second JS engine as plugin wasm".
Until the host offers that, the bundle ships a template pass whose output is "a total
function of (text, vars), reproducible across machines and years"
(`packages/web-model/src/transform.ts:22-37`).

## Decision

Scripts in web-frame content are never run, and the only computation before rendering is a
fixed template substitution.

- The live preview is an `<iframe sandbox="">` fed through `srcDoc`: no script permission
  and no same-origin access.
- The linter reports a `<script>` tag as an error and an `on…=` attribute as a warning.
- Content entering from outside (clipboard paste, `.html` import) passes `sanitizeHtml`,
  which removes `<script>` elements, inline event-handler attributes and `javascript:` URLs,
  and returns which of the three classes it removed.
- The engine build has no script runtime: `web-render` depends on the Blitz DOM, HTML,
  paint and traits crates and on no script engine.
- The template pass replaces `{{name}}` from a flat string map stored in the envelope
  (`vars`) and applies filters from a closed list: `upper`, `lower`, `trim`,
  `number-format`. It runs only when `vars` is present. An unknown name, an unknown filter
  or a malformed placeholder stays verbatim and produces a diagnostic.
- The linter, the sanitiser, the `.html` splitter and the flow-syntax scanner are
  regular-expression scanners with no DOM and no dependencies, written not to throw on any
  input.

## Evidence

- `packages/web-bundle/src/panels/web-source-panel.tsx:1311-1324` — `sandbox=""` and `srcDoc`
- `packages/web-model/src/diagnose.ts:71-90` — the `<script>` error and the handler warning
- `packages/web-model/src/sanitize.ts:26-41`, `:90-141` — scanner, the three classes, the
  removal order
- `packages/web-model/src/import-html.ts:50`, `packages/web-bundle/src/panels/ingest.ts:48-51`
  — the two call sites of `sanitizeHtml`
- `packages/web-model/src/transform.ts:22-45`, `:52-57` — what the pass must not become;
  `TEMPLATE_FILTERS`
- `packages/web-model/src/transform.ts:139-225`, `:249-257` — substitution, verbatim
  fallback, the `vars` gate
- `packages/web-render/Cargo.toml:54-71` — the crate's dependencies

## Alternatives considered

A scripted transform that runs in the host's script engine is named as the later form and
is kept out of the bundle for the reason quoted in Context (`transform.ts:22-30`,
`README.md:51-54`). The module also rules out the middle road: an ad-hoc expression language
in the template pass (`transform.ts:41-44`).

## Consequences

A page that depends on scripts shows its static markup only.

Source typed in the panel is linted, not rewritten. The sanitiser runs on the two ingest
paths only, and saving writes the draft as it is (`web-source-panel.tsx:291-301`). A typed
`<script>` is therefore stored and reported as an error; it does not run because of the
sandbox and because the engine has no script runtime.

The filter list is closed on purpose: "Growing this list is an API decision, not a
convenience patch" (`transform.ts:50-51`). `number-format` uses a fixed `,` grouping and `.`
decimal point and no locale API (`transform.ts:88-103`).

Because the preview's origin is opaque, document fonts are inlined as `data:` URLs; `blob:`
URLs cannot be fetched there (`packages/web-bundle/src/panels/font-resolution.ts:26-30`).

The scanners are not parsers. The sanitiser removes any `on<word>=` at an attribute
boundary, including an attribute that is not a real handler (`sanitize.ts:63-69`).

## Related

- [ADR 406](406-web-frame-and-source-storage.md) — the envelope that stores `vars`; the `.html` importer
- [ADR 401](401-layout-engine-pinned.md) — the engine build and its dependencies
- [ADR 001](https://github.com/paged-media/core/blob/main/docs/adr/001-boa-over-quickjs.md) — the host's script runtime, where a scripted transform would run
