#!/usr/bin/env node
// The hash of every source file the engine wasm (packages/web-render) is
// built from.
//
// build-wasm.sh stamps it into the wasm (`engine_source_hash()`, through the
// WEB_RENDER_SOURCE_HASH env var) and next to it
// (packages/web-bundle/bin/SOURCE_HASH); packages/web-bundle/test/
// wasm-fresh.spec.ts recomputes it and fails when the wasm in bin/ was built
// from different sources. Without that check every vitest run exercises
// whatever wasm was last built, however old.
//
// Inputs: web-render's src/, assets/ (the vendored font is compiled in),
// Cargo.toml and Cargo.lock. Tests live inside src/ (#[cfg(test)] modules),
// so editing one asks for a rebuild too — the simple, conservative choice.
//
// Usage: node scripts/source-hash.mjs        → prints the hex digest
//        node scripts/source-hash.mjs --list → prints the input files

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = join(root, "packages", "web-render");
const TEXT = /\.(rs|toml|lock|txt|md)$/;

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

export function inputs() {
  const files = [
    ...filesUnder(join(CRATE, "src")),
    ...filesUnder(join(CRATE, "assets")),
    join(CRATE, "Cargo.toml"),
    join(CRATE, "Cargo.lock"),
  ].filter((f) => existsSync(f));
  return files.map((f) => relative(root, f).split("\\").join("/")).sort();
}

export function sourceHash() {
  const h = createHash("sha256");
  for (const rel of inputs()) {
    // Path and content both count; text has CRLF normalised so a Windows
    // checkout hashes the same as the one that built the wasm. Binary
    // assets (the font) are hashed as bytes.
    h.update(rel);
    h.update("\0");
    const bytes = readFileSync(join(root, rel));
    h.update(TEXT.test(rel) ? bytes.toString("utf8").replace(/\r\n/g, "\n") : bytes);
    h.update("\0");
  }
  return h.digest("hex");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--list")) console.log(inputs().join("\n"));
  else console.log(sourceHash());
}
