# BREAKAGE_LOG — paged.web vs. the plugin surface

Every place the plugin surface (`@paged-media/plugin-api` v0.2) fell
short of what paged.web needs — the second half of the platform's
existential test (concept §9.1: where paged.draw proved the platform
hosts a *tool*, paged.web proves it hosts a *foreign document model*).
Same contract as plugin-draw's log: **this is the API-v1 punch list.**

Format: `W-NN · date · area · status`.

---

- **W-01 · 2026-06-06 · rendering · SPIKE DONE — GO (2026-06-06)** —
  the W0 feasibility spike landed in `core/spikes/blitz-wasm` and the
  embedded-engine bet is **GO**: the whole Blitz stack
  (`=0.3.0-alpha.4`, Stylo 0.17/Taffy/Parley) compiles clean to
  wasm32-unknown-unknown AND executes there (node run paints the
  fragment; the only native-vs-wasm delta is glyph runs — no system
  fonts on wasm, faces must be registered, which the determinism
  doctrine demands anyway). Numbers: brotli'd stack 2.20 MB
  (Vello excluded — `anyrender_vello 0.11` pins vello ^0.9 + wgpu ^29,
  EXACTLY core's versions, so the real integration paints into the
  shared instance); persistent-doc re-layout+repaint 58 µs/frame,
  fresh-doc with shared `FontContext` 373 µs. Full findings +
  integration levers (font_ctx sharing, no-op net_provider, custom
  ua_stylesheets, `@media print`, sequential styling on wasm):
  `core/spikes/blitz-wasm/README.md`. REMAINING for the engine lane
  (W1+): a real `anyrender_vello`-backed webFrame paint hook in the
  canvas, font registration parity, and the W-02 metadata/baking
  pipeline. The v0 panel preview (O1 stopgap) stays until then.

- **W-02 · 2026-06-06 · document model · RESOLVED (2026-06-07)**
  — the engine's plugin-metadata carrier shipped (core protocol v33,
  facility design §2-3): `Properties/Label` `KeyValuePair`s round-trip
  parse → mutate → write (F1-fixtured, InDesign-preservable), gated
  (`x-paged:<plugin-id>` namespace, 64 KiB cap, JSON envelope
  `{v, data, engine?}`), with SDK doors
  `host.document.getMetadata/setMetadata` (plugin-api 0.2.5-canary.0;
  key derived from the manifest id — own namespace only) and the
  `ObjectTypeBaker`/`BakeContext` contract types. The bundle is
  MIGRATED: sources persist as document metadata (envelope helpers in
  web-model; panel reads async with a one-time legacy-storage
  migration; edits are debounced undoable mutations; undo/redo
  re-reads), and "insert web frame" is ONE undo step via the protocol
  v34 batch-created `$created` sentinel (insertFrame +
  setPluginMetadata atomically). Sources now round-trip IDML and
  survive foreign opens. Still open (split to the baking lane): the
  B2 baking pipeline + host bake loop (`contribute.objectType`
  runtime-reserved) — that's W-03's territory.

- **W-03 · 2026-06-06 · contributions · OPEN** — `contribute.objectType`
  is reserved (declared in the manifest, throws at runtime). A
  webFrame is currently an ordinary rectangle with attached source;
  hit-testing, selection chrome, and double-click entry treat it as
  one. Needs the objectType registration API (paper §9.1.2) + the
  edit-context registry (shared with plugin-draw B-02).

- **W-04 · 2026-06-06 · panel widgets · RESOLVED (2026-06-07)** — the
  `codeEditor` host widget shipped (§9.1.1). The contract is additive
  + type-only: `@paged-media/plugin-api` gained `CodeEditorProps`,
  `CodeEditorDiagnostic`, `CodeEditorLanguage`, and a `WidgetSurface`
  (`{ CodeEditor }`) on `host.widgets`. The host OWNS the widget (one
  editor across every scripting-adjacent plugin, no per-bundle dep):
  the editor injects a real `CodeEditor` (line numbers, light HTML/CSS
  highlighting via a zero-dep tokenizer — the editor tree carries no
  CodeMirror/Prism/Shiki and the brand line forbids adding one for two
  textareas — a diagnostics gutter with severity dots + inline
  squiggles, value/onChange, read-only mode) from `@paged-media/ui`
  into `loadBundle({ widgets })`. When the host injects no catalog,
  `host.widgets.CodeEditor` is a plain-textarea FALLBACK (same props
  contract — honest, not fake) and `supports("widgets.codeEditor@1")`
  answers false. The source panel's HTML + CSS lanes now use the widget
  (HTML lane gets the linter's per-line markers); the sandboxed preview
  is unchanged. Residuals: CSS-side diagnostics await a CSS linter
  (the engine-backed Blitz compatibility table, W-01); the highlighter
  is a tokenizer, not a parser (deliberately — it never crashes on bad
  input). Tests: plugin-sdk vitest (fallback default + injected-catalog
  feature flag); editor Playwright AC-WEB-4 (line numbers + highlight
  spans + gutter error mark + squiggle).

- **W-05 · 2026-06-06 · diagnostics UI · RESOLVED (2026-06-07)** — a
  host PROBLEMS PANEL now consumes `host.diagnostics`. The SDK gained
  an optional `diagnosticsSink` (`publish/clear` keyed by
  `(bundleId, key)`, `supports("diagnostics.publish@1")`): every
  `host.diagnostics.set/clear` fans out to it (the per-bundle store +
  `onDidChange` + console mirror are unchanged — this is a fan-out, not
  a replacement). The editor injects a sink backed by `problems-store`
  and registers a `paged.problems` panel that lists every loaded
  bundle's diagnostics — (severity, source, message, location) — so
  paged.web's linter findings surface OUTSIDE the plugin's own inline
  list. Click-to-focus reopens the OWNING bundle's panel (resolved from
  the panel registry by namespace). The bundle's linter publishes
  through the door on source change (debounced commit). Per-line gutter
  binding landed with W-04 (the source panel's CodeEditor gutter).
  Residual (follow-up note): document-location focus — the `Diagnostic`
  location type carries `source`/`line`, not a document/frame ref, so
  there is nothing to navigate the canvas to yet; jump-to-frame waits
  on a richer diagnostic location type. Tests: plugin-sdk vitest
  (publish/clear/list round-trip + feature flag); plugin-web vitest
  (linter → host.diagnostics → sink wiring, incl. the §6.1 policy
  error + its line); editor Playwright AC-WEB-5 (panel shows the
  published diagnostic; click focuses the source panel).

- **W-06 · 2026-06-06 · assets · OPEN** — no capability-gated asset
  store (§9.1.5): `@font-face` and image embedding (fetch at edit
  time, render offline forever) have no API. Gates the
  fonts/URL-import milestone (W3 in the concept roadmap).

- **W-07 · 2026-06-06 · wasm lane · RESOLVED-PARTIAL (2026-06-07,
  plugin-sdk W3.8)** — packaging story for a plugin-shipped WASM module
  (§9.1.3) now has a contract surface. A bundle declares its wasm under
  `capabilities.wasm: [{ name, path, purpose, maxBytes? }]` —
  declared-only, `purpose` a closed vocab (layout|codec|compute),
  bundle-relative path with traversal rejected. plugin-cli `validate`
  enforces the schema + budgets; the host-side door
  `loadBundleWasm(bundle, name, { assetSource, grant, … })` in
  `@paged-media/plugin-sdk` enforces declared-only access, a host GRANT
  (wasm is opt-in — no grant = refuse), per-artifact (8 MiB, tightened by
  manifest maxBytes) + total (16 MiB) + load-time (3 s) + memory-growth
  (256 MiB, non-shared; SAB/threads OFF) budgets, and instantiates with
  NO ambient authority — the module gets only the imports the caller
  passes, no engine/DOM/network handle; it is strictly downstream of the
  bundle's already-gated JS. Non-goals: no native plugins, no wasm-side
  direct engine access (v1). Design record:
  plugin-sdk/docs/wasm-packaging.md + DESIGN.md §10. Tests: plugin-sdk
  vitest — loader (declared-only / grant / budget / no-ambient-authority,
  on a hand-assembled wasm fixture) + plugin-cli validate (unknown
  purpose / traversal / over-budget / unknown key).
  RESIDUAL: the editor-side serving wiring is open — the editor must
  provide the `assetSource` rooted at each bundle's asset base, decide +
  surface the grant (auto-grant first-party / prompt third-party), and
  use `instantiateStreaming` over the bundle URL in the browser path.
  Plus: packager artifact checksums, real-engine (W0 Blitz spike) budget
  re-calibration, and the optional `wasm.load@1` supports() probe.
  Becomes fully RESOLVED when the editor serving lane lands.

- **W-08 · 2026-06-06 · transforms · RESOLVED-PARTIAL (2026-06-07)** —
  the Boa-budget half is in (core W3.9, shared with plugin-draw
  B-09): the embedding API now takes a per-execution `ScriptBudget`
  (loop/recursion/stack + wall-clock ms) and a host-injected ms
  clock, with typed `ScriptBudgetKind` exhaustion over the channel
  (rides v35). A pinned generation transform can run against a budget
  and terminate close to its deadline whenever it touches the host
  bridge. Still W-08's own: the **binding context** (document
  variables / datasets) for §6.2 template+data → HTML is a separate
  host API, not part of the budget work.

- **W-09 · 2026-06-06 · shell · RESOLVED (2026-06-06)** — bundle
  panels had no entry path (no cockpit mode slot, host builds
  show/hide commands for startup panels only). Resolved in SDK 0.2:
  host-app-injected `host.shell.openPanel/closePanel` +
  `contributePanel` (panel + namespaced show/hide commands).
