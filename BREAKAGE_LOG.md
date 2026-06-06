# BREAKAGE_LOG — paged.web vs. the plugin surface

Every place the plugin surface (`@paged-media/plugin-api` v0.2) fell
short of what paged.web needs — the second half of the platform's
existential test (concept §9.1: where paged.draw proved the platform
hosts a *tool*, paged.web proves it hosts a *foreign document model*).
Same contract as plugin-draw's log: **this is the API-v1 punch list.**

Format: `W-NN · date · area · status`.

---

- **W-01 · 2026-06-06 · rendering · OPEN (the big one)** — no engine
  lane for webFrame content. Concept §4's architecture (Blitz/WASM:
  Stylo+Taffy+Parley painting into Vello, client-side, deterministic,
  pinned) needs the **W0 feasibility spike in core** — compile the
  Blitz stack to wasm, paint a static fragment through the existing
  pipeline. Until then the v0 slice renders a sandboxed PANEL preview
  only (the O1 stopgap, panel-scoped, explicitly labeled in the UI).
  Server rendering remains rejected (O2).

- **W-02 · 2026-06-06 · document model · OPEN** — no namespaced plugin
  metadata on document objects (`x-paged-web:source/engine/options`,
  concept §5). v0 persists `WebFrameSource` in plugin storage keyed by
  element id — the SHAPE is the metadata shape, but it lives outside
  the document: **it does not round-trip IDML** and is lost on
  collaborative/other-machine open. The engine needs metadata write
  ops + the B2 baking pipeline (rendered scene → IDML constructs) for
  the fidelity doctrine to hold.

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
