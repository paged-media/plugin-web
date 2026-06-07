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

- **W-04 · 2026-06-06 · panel widgets · OPEN** — no `codeEditor` host
  widget (§9.1.1): syntax highlighting, line numbers, gutter
  diagnostics. v0 ships token-styled `<textarea>`s — honest but
  spartan. The widget belongs in the host's catalog (shared with
  every scripting-adjacent plugin), not in this bundle.

- **W-05 · 2026-06-06 · diagnostics UI · PARTIAL** — `host.diagnostics`
  exists (set/clear/onDidChange + console mirror) and the bundle
  feeds it, but no host problems-panel consumes the store yet, and
  there is no per-line gutter binding (depends on W-04).

- **W-06 · 2026-06-06 · assets · OPEN** — no capability-gated asset
  store (§9.1.5): `@font-face` and image embedding (fetch at edit
  time, render offline forever) have no API. Gates the
  fonts/URL-import milestone (W3 in the concept roadmap).

- **W-07 · 2026-06-06 · wasm lane · OPEN** — no packaging story for a
  plugin-shipped WASM module (§9.1.3). Becomes concrete with the W0
  spike; the manifest will need a `wasm` capability + budget rules.

- **W-08 · 2026-06-06 · transforms · OPEN** — Boa generation
  transforms (§6.2: template + data → HTML, pure, pinned) need a host
  API to run scripts against the embedded engine with budgets — the
  same Boa-budget gap as plugin-draw B-09, plus a binding context
  (document variables, datasets). Phase W3.

- **W-09 · 2026-06-06 · shell · RESOLVED (2026-06-06)** — bundle
  panels had no entry path (no cockpit mode slot, host builds
  show/hide commands for startup panels only). Resolved in SDK 0.2:
  host-app-injected `host.shell.openPanel/closePanel` +
  `contributePanel` (panel + namespaced show/hide commands).
