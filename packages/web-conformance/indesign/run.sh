#!/usr/bin/env bash
# The InDesign lane, local half (maintainer machine: core's `paged` CLI and
# Adobe InDesign 2025). For every committed scripts/<fixture>.js:
#
#   paged new (612x792 pt) -> paged script <fixture>.js -> <fixture>.idml
#   -> InDesign opens it (probe.jsx) -> answers/<fixture>.json
#
# The scripts come from the REAL bake (test/indesign-bake.spec.ts with
# UPDATE_INDESIGN_SCRIPTS=1). The IDML is staged with a "Document fonts"
# folder holding the engine's Inter face, so InDesign sets the text in the
# face the bake measured with. Judge by the artifact: a run that writes no
# answer JSON failed, whatever osascript returned.
#
#   PAGED_BIN=~/paged/core/target/debug/paged bash indesign/run.sh [fixture…]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAGED_BIN="${PAGED_BIN:-$HOME/paged/core/target/debug/paged}"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
FONT="$HERE/../../web-render/assets/fonts/Inter.ttf"
STAGE="${PAGED_INDESIGN_STAGE:-$(mktemp -d "${TMPDIR:-/tmp}/paged-web-indesign.XXXXXX")}"
mkdir -p "$STAGE/Document fonts" "$HERE/answers"
cp "$FONT" "$STAGE/Document fonts/Inter.ttf"

names=("$@")
if [[ ${#names[@]} -eq 0 ]]; then
  for f in "$HERE"/scripts/*.js; do names+=("$(basename "$f" .js)"); done
fi

"$PAGED_BIN" new --size 612x792 -o "$STAGE/blank.paged" >/dev/null
for name in "${names[@]}"; do
  idml="$STAGE/$name.idml"
  out="$STAGE/$name.answer.json"
  rm -f "$out"
  "$PAGED_BIN" script "$STAGE/blank.paged" "$HERE/scripts/$name.js" -o "$idml" --font "$FONT"
  shim="$STAGE/$name.shim.jsx"
  cat > "$shim" <<JSX
var PROBE_IDML = "$idml";
var PROBE_OUT = "$out";
\$.evalFile(File("$HERE/probe.jsx"));
JSX
  # The raw `do script` event: sandboxed shells cannot compile `do script`
  # (see core tools/indesign-export/run-export.sh).
  osascript <<OSA || true
with timeout of 300 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$shim") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
  if [[ ! -s "$out" ]]; then
    echo "run.sh: InDesign wrote no answer for $name (staged in $STAGE)" >&2
    exit 1
  fi
  cp "$out" "$HERE/answers/$name.json"
  echo "run.sh: $name -> answers/$name.json"
done
