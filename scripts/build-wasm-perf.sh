#!/usr/bin/env bash
# build-wasm-perf.sh — build the COUNTING engine wasm for the perf harness.
#
# Same crate and stack as `build-wasm.sh --engine`, plus the `perf-counters`
# feature, which adds the `perf_counters()` / `perf_counters_reset()` exports
# (engine-internal work counts: parses, resolves, paint captures, painted
# commands, run-match comparisons, font-context builds, boundary bytes).
#
# The counting build NEVER goes into the bundle: it is written to
# packages/web-render/target/perf-wasm/ (gitignored, own cargo target dir so
# it does not churn the shipped build), and only the perf spec
# (packages/web-bundle/test/perf/) loads it — to PRINT the engine counts
# beside the host-door counts under PERF_SHOW=1. The gated budgets do not
# need it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$HERE/packages/web-render"
OUT="$CRATE/target/perf-wasm"
TARGET="wasm32-unknown-unknown"

LOCKED=$(grep -A1 '^name = "wasm-bindgen"$' "$CRATE/Cargo.lock" | grep version | head -1 | cut -d'"' -f2)
CLI=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)
if [[ "$LOCKED" != "$CLI" ]]; then
  echo "build-wasm-perf: error — wasm-bindgen-cli '${CLI:-missing}' != Cargo.lock $LOCKED" >&2
  echo "                 cargo install wasm-bindgen-cli --version $LOCKED" >&2
  exit 1
fi

( cd "$CRATE" && cargo build --release --target "$TARGET" \
    --features blitz,perf-counters --target-dir "$CRATE/target/perf" )

mkdir -p "$OUT"
wasm-bindgen "$CRATE/target/perf/$TARGET/release/web_render.wasm" \
  --target web --out-dir "$OUT" --out-name blitz_web
echo "build-wasm-perf: wrote the counting engine to $OUT"
