// Shared headless-host bootstrap for the paged.web conformance specs.
// One wasm boot per SUITE FILE (in `beforeAll`), reused across the
// file's tests — booting per test would dominate the runtime.

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

export const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

export const openHost = (): Promise<HeadlessHost> =>
  createHeadlessHost({ console: silent, storage: mapBacking() });
