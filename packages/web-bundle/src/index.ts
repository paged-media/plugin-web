// @paged-media/web-bundle — the paged.web plugin bundle.

import { defineBundle } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";

import { activate, PANEL_ID } from "./activate";
import manifestJson from "../manifest.json";

export const webBundle = defineBundle({
  manifest: manifestJson as PluginManifest,
  activate,
});

export { activate, PANEL_ID };
// W3.2 — the webFrame object type + edit context (closes W-03),
// exported for the conformance + activation specs.
export {
  webFrameObjectType,
  makeWebFrameEditContext,
  WEB_FRAME_TYPE,
} from "./edit-context";
// W-01 — the bake path (render contract → C-1 sceneLayer) + its command
// handler, exported for the render-lane specs.
export { bakeWebFrame, type BakeOutcome } from "./bake";
export { renderSelectedWebFrame } from "./render-command";
