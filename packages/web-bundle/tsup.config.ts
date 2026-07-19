import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [/^@paged-media\/web-/],
  // Leave `?url` asset imports (the Blitz `_bg.wasm`) as runtime imports so
  // the editor's Vite resolves + serves them relative to the served dist —
  // esbuild can't load a `.wasm?url` at build time. Mirrors sheet-bundle.
  external: [/\?url$/],
});
