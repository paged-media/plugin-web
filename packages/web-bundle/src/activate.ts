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

import { bakeSelectedWebFrame } from "./bake-to-document";
import { insertWebFrame } from "./insert";
import { renderSelectedWebFrame } from "./render-command";
import {
  renderSelectedWebFlow,
  threadSelectedIntoFlow,
  threadSelectedIntoNamedFlow,
  unthreadSelectedFromFlow,
} from "./render-flow-command";
import {
  makeWebFrameEditContext,
  webFrameObjectType,
} from "./edit-context";
import { sourceFromHtmlFile } from "../../web-model/src";
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
  // ADR-020 rung 2 — "Render web flow": thread ONE web source across the
  // SELECTED chain of frames (source first, recipients after, in selection
  // order), submitting one C-1 SceneLayer per frame. Same engine gate + the
  // same honest not-loaded fallback as "Render to frame".
  host.contribute.command({
    id: "media.paged.web.command.renderWebFlow",
    title: "Render web flow across frames",
    category: "Web",
    handler: () => renderSelectedWebFlow(host),
  });
  // ADR-020 rung 2 — "Thread web flow into frames": append the selected
  // target frames to the source web frame's PERSISTED region chain (rides
  // the source envelope, so the flow survives reopen).
  host.contribute.command({
    id: "media.paged.web.command.threadWebFlow",
    title: "Thread web flow into frames",
    category: "Web",
    handler: () => threadSelectedIntoFlow(host),
  });
  host.contribute.command({
    id: "media.paged.web.command.unthreadWebFlow",
    title: "Unthread web flow from frames",
    category: "Web",
    handler: () => unthreadSelectedFromFlow(host),
  });
  // CSS multi-flow: route the selected targets into the source's SECONDARY
  // named flow (the second `flow-into`) — the common article + sidebar case,
  // picker-free (the host exposes no quick-pick).
  host.contribute.command({
    id: "media.paged.web.command.threadWebFlowNamed",
    title: "Thread web flow into the named flow",
    category: "Web",
    handler: () => threadSelectedIntoNamedFlow(host),
  });
  // Phase C — "Bake web frame to document": FLATTEN the selected web frame's
  // render into NATIVE Paged content (swatches + rectangles + text frames), so
  // it exports to IDML/PDF and a foreign open sees real content with no plugin
  // engine. Engine-gated + honest: unsupported item kinds are reported, never
  // faked; the not-loaded path bakes nothing and says so.
  host.contribute.command({
    id: "media.paged.web.command.bakeWebFrame",
    title: "Bake web frame to document",
    category: "Web",
    handler: () => bakeSelectedWebFrame(host),
  });
  // W3.2 — register the webFrame OBJECT TYPE + its source EDIT CONTEXT
  // (closes W-03): a webFrame is a rectangle with attached source
  // metadata; double-clicking one now enters the source context (and
  // raises the source panel) instead of descending into a group.
  contributeObjectType(host, webFrameObjectType);
  contributeEditContext(host, makeWebFrameEditContext(PANEL_ID));
  // `.html` FILE intake (editor-ui-coverage S): File▸Open + drag-drop of
  // an .html file inserts a web frame with that file as its source —
  // <style> blocks land in the css lane, sanitize runs ON INGEST (§6.1:
  // page JavaScript never executes; removals are logged, never silent).
  if (host.supports("contribute.importer@1")) {
    host.contribute.importer({
      id: "media.paged.web.importer.html",
      title: "HTML file",
      extensions: [".html", ".htm"],
      mimeTypes: ["text/html"],
      import: async ({ name, bytes }) => {
        const text = new TextDecoder().decode(bytes);
        const { source, removed } = sourceFromHtmlFile(text);
        if (removed.length > 0) {
          host.log.warn(
            `import ${name}: sanitized on ingest (removed: ${removed.join(", ")})`,
          );
        }
        await insertWebFrame(host, PANEL_ID, source);
      },
    });
  }
  host.log.info(`activated (apiVersion ${manifest.apiVersion})`);
  return { dispose() {} };
}

export { manifest, PANEL_ID };
