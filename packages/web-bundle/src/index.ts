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
