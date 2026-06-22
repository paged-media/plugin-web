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

// The paged.web bundle entry. v0 scope (the honest slice API v0.2
// carries): the webFrame SOURCE lane — insert command, the source
// panel (HTML/CSS editors + sandboxed preview + diagnostics), and
// storage-backed persistence. The rendering lane (Blitz/WASM into
// Vello, concept §4) is the W0 engine spike; the manifest already
// declares the webFrame object type + edit context so the contract
// is forward-complete (both reserved host-side).

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";
import {
  contributeEditContext,
  contributeObjectType,
  contributePanel,
} from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";

import { insertWebFrame } from "./insert";
import { renderSelectedWebFrame } from "./render-command";
import {
  makeWebFrameEditContext,
  webFrameObjectType,
} from "./edit-context";
import { makeWebSourcePanel } from "./panels/web-source-panel";

const PANEL_ID = "media.paged.web.panel.source";

export function activate(host: BundleHost): BundleHandle {
  contributePanel(host, {
    id: PANEL_ID,
    title: "Web frame",
    icon: "panel-canvas",
    component: makeWebSourcePanel(host),
    defaultDock: "right",
  });
  host.contribute.command({
    id: "media.paged.web.command.insertWebFrame",
    title: "Insert web frame",
    category: "Web",
    handler: () => insertWebFrame(host, PANEL_ID),
  });
  // W-01 — "Render to frame": the bake-path affordance. Loads the
  // Blitz/WASM engine (manifest capabilities.wasm ∋ blitz), renders the
  // selected web frame's source, and submits the real C-1 SceneLayer to
  // the rail (ADR-011 Option B) so core composes it inside the frame.
  // When the engine can't load (no artifact built / a realm that can't
  // fetch the sibling asset), it falls back to the honest "engine not
  // loaded" diagnostic + the sandboxed source-lane preview — never a fake
  // render.
  host.contribute.command({
    id: "media.paged.web.command.renderWebFrame",
    title: "Render web frame to canvas",
    category: "Web",
    handler: () => renderSelectedWebFrame(host),
  });
  // W3.2 — register the webFrame OBJECT TYPE + its source EDIT CONTEXT
  // (closes W-03): a webFrame is a rectangle with attached source
  // metadata; double-clicking one now enters the source context (and
  // raises the source panel) instead of descending into a group.
  contributeObjectType(host, webFrameObjectType);
  contributeEditContext(host, makeWebFrameEditContext(host, PANEL_ID));
  host.log.info(`activated (apiVersion ${manifest.apiVersion})`);
  return { dispose() {} };
}

export { manifest, PANEL_ID };
