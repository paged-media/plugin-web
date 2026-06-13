#!/usr/bin/env bash
# build-wasm.sh — build the web-render lowering crate to the bundle's
# wasm artifact (ADR-011 Option B: "HTML/CSS in, scene layer out").
#
# TWO MODES, matching the honest scoping of the lowering slice:
#
#   (default) LOWERING wasm — builds web-render with DEFAULT features (the
#     pure C-1 lowering lane + wire types, NO Blitz) to wasm32 and runs
#     wasm-bindgen. This proves the lowering compiles + binds to JS on
#     wasm, and produces a small artifact. It exposes the lowering, not a
#     live engine: the bundle still calls the TS render contract's honest
#     not-loaded path until the engine mode below ships.
#
#   --engine  ENGINE wasm (the NAMED NEXT SLICE) — builds with the `blitz`
#     feature so the full Stylo/Taffy/Parley stack + the capture sink go
#     into the artifact, exposing `render_web_frame(html, w, h) -> JSON`.
#     This is the multi-week artifact: it ALSO needs pinned-face
#     registration (so text shapes on wasm — the spike's 22-vs-19 delta)
#     and DOM run-text attachment to captured glyph runs before it renders
#     text. Gated behind the flag so the default gate stays light; the W0
#     spike (core/spikes/blitz-wasm) already proved this stack compiles +
#     paints on wasm32.
#
# Output: packages/web-bundle/bin/blitz_web.wasm (manifest
# capabilities.wasm), gitignored.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$HERE/packages/web-render"
OUT="$HERE/packages/web-bundle/bin"
TARGET="wasm32-unknown-unknown"

FEATURES=""
PROFILE_DIR="release"
MODE="lowering"
if [[ "${1:-}" == "--engine" ]]; then
  FEATURES="--features blitz"
  MODE="engine"
fi

echo "build-wasm: mode=$MODE (crate=$CRATE)"

if ! rustup target list --installed 2>/dev/null | grep -q "$TARGET"; then
  echo "build-wasm: installing $TARGET target" >&2
  rustup target add "$TARGET"
fi

( cd "$CRATE" && cargo build --release --target "$TARGET" $FEATURES )

WASM_IN="$CRATE/target/$TARGET/$PROFILE_DIR/web_render.wasm"
if [[ ! -f "$WASM_IN" ]]; then
  echo "build-wasm: expected $WASM_IN — build produced no cdylib" >&2
  exit 1
fi

mkdir -p "$OUT"
if command -v wasm-bindgen >/dev/null 2>&1; then
  wasm-bindgen "$WASM_IN" --target web --out-dir "$OUT" --out-name blitz_web
else
  echo "build-wasm: wasm-bindgen not found; copying raw module" >&2
  cp "$WASM_IN" "$OUT/blitz_web.wasm"
fi

# Optional size pass (matches the spike's measurement path).
if command -v wasm-opt >/dev/null 2>&1 && [[ -f "$OUT/blitz_web_bg.wasm" ]]; then
  wasm-opt -Oz "$OUT/blitz_web_bg.wasm" -o "$OUT/blitz_web_bg.wasm"
fi

echo "build-wasm: wrote artifact(s) to $OUT"
ls -la "$OUT"

# Size report + budget gate. The manifest's `capabilities.wasm[blitz]`
# declares the D-07b ceiling (64 MiB); the engine artifact must fit. The
# W0 spike measured ~2.2 MB brotli for the marginal Blitz stack — report
# the same so a regression in the artifact size is visible at build time.
BG="$OUT/blitz_web_bg.wasm"
BUDGET_BYTES=$((64 * 1024 * 1024))
if [[ -f "$BG" ]]; then
  RAW_BYTES=$(wc -c < "$BG" | tr -d ' ')
  printf 'build-wasm: artifact %s = %d bytes (%.2f MiB), budget %d MiB\n' \
    "$(basename "$BG")" "$RAW_BYTES" "$(echo "$RAW_BYTES" | awk '{print $1/1048576}')" \
    $((BUDGET_BYTES / 1024 / 1024))
  if command -v brotli >/dev/null 2>&1; then
    BR_BYTES=$(brotli -q 11 -c "$BG" 2>/dev/null | wc -c | tr -d ' ')
    printf 'build-wasm: brotli transfer size = %d bytes (%.2f MiB)\n' \
      "$BR_BYTES" "$(echo "$BR_BYTES" | awk '{print $1/1048576}')"
  fi
  if (( RAW_BYTES > BUDGET_BYTES )); then
    echo "build-wasm: ERROR — artifact exceeds the 64 MiB D-07b budget" >&2
    exit 1
  fi
fi

if [[ "$MODE" == "lowering" ]]; then
  cat <<'NOTE'

build-wasm: NOTE — this is the LOWERING artifact (no engine). The bundle's
render contract stays on its honest not-loaded path until the engine
artifact ships:  bash scripts/build-wasm.sh --engine  (the full Blitz
stack + pinned-face registration + DOM run-text capture).
NOTE
else
  cat <<'NOTE'

build-wasm: NOTE — this is the ENGINE artifact (full Blitz: Stylo/Taffy/
Parley + the capture sink, with a pinned fallback face registered so text
shapes on wasm). It exposes render_web_frame(html, w, h) -> C-1 SceneLayer
JSON, which the bundle loads + submits via host.contribute.sceneLayer().
NOTE
fi
