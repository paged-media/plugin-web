#!/usr/bin/env bash
# build-wasm.sh — build the web-render crate to the bundle's wasm artifact
# (ADR-011 Option B: "HTML/CSS in, scene layer out").
#
# Two modes:
#
#   --engine  the ENGINE artifact the bundle ships and every test lane uses:
#     web-render with the `blitz` feature (the full Stylo/Taffy/Parley stack,
#     the capture sink and the vendored font), exposing
#     render_web_frame / render_web_flow / engine_source_hash.
#
#   (default) the LOWERING artifact: default features only (the pure
#     lowering + wire types, no Blitz). A light check that the lowering
#     compiles and binds on wasm32; it renders nothing.
#
# Both stamp the source hash (scripts/source-hash.mjs) into the wasm and into
# bin/SOURCE_HASH, so packages/web-bundle/test/wasm-fresh.spec.ts can tell a
# wasm built from these sources from one built from older ones.
#
# wasm-bindgen-cli must equal the wasm-bindgen version in
# packages/web-render/Cargo.lock (checked below — a mismatched CLI produces
# glue that does not match the module).
#
# Output: packages/web-bundle/bin/blitz_web*.{wasm,js} (gitignored).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$HERE/packages/web-render"
OUT="$HERE/packages/web-bundle/bin"
TARGET="wasm32-unknown-unknown"

FEATURES=""
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

# Pin check BEFORE the (long) build.
LOCKED=$(grep -A1 '^name = "wasm-bindgen"$' "$CRATE/Cargo.lock" | grep version | head -1 | cut -d'"' -f2)
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "build-wasm: error — wasm-bindgen not found; cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi
CLI=$(wasm-bindgen --version | awk '{print $2}')
if [[ "$LOCKED" != "$CLI" ]]; then
  echo "build-wasm: error — wasm-bindgen-cli $CLI != Cargo.lock wasm-bindgen $LOCKED" >&2
  echo "            cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi

SOURCE_HASH=$(node "$HERE/scripts/source-hash.mjs")
# shellcheck disable=SC2086 # FEATURES is intentionally word-split
( cd "$CRATE" && WEB_RENDER_SOURCE_HASH="$SOURCE_HASH" cargo build --release --target "$TARGET" $FEATURES )

# Cargo writes under CARGO_TARGET_DIR when it is set (relative to the crate,
# where cargo ran), else the crate's own target/.
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
[[ "$TARGET_DIR" = /* ]] || TARGET_DIR="$CRATE/$TARGET_DIR"
WASM_IN="$TARGET_DIR/$TARGET/release/web_render.wasm"
if [[ ! -f "$WASM_IN" ]]; then
  echo "build-wasm: expected $WASM_IN — build produced no cdylib" >&2
  exit 1
fi

mkdir -p "$OUT"
wasm-bindgen "$WASM_IN" --target web --out-dir "$OUT" --out-name blitz_web

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz "$OUT/blitz_web_bg.wasm" -o "$OUT/blitz_web_bg.wasm"
else
  echo "build-wasm: warning — wasm-opt not found; shipping unoptimized wasm (CI optimizes)" >&2
fi

echo "$SOURCE_HASH" > "$OUT/SOURCE_HASH"
echo "build-wasm: wrote artifact(s) to $OUT (SOURCE_HASH ${SOURCE_HASH:0:12})"
ls -la "$OUT"

# Size report + budget gate. The manifest's `capabilities.wasm[blitz]`
# declares a 64 MiB ceiling for this artifact; the app-wide sum is the
# editor's concern (its scripts/wasm-budget.mjs).
BG="$OUT/blitz_web_bg.wasm"
BUDGET_BYTES=$((64 * 1024 * 1024))
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
  echo "build-wasm: ERROR — artifact exceeds the 64 MiB budget" >&2
  exit 1
fi
