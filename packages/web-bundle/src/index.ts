/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

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
