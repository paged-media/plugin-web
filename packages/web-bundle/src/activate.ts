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
  // W-01 — "Render to frame": the bake-path affordance. Calls the render
  // contract for the selected web frame and lowers a real SceneLayer to
  // the C-1 rail (ADR-011 Option B). TODAY the engine is not loaded, so
  // it surfaces the honest "engine not loaded" diagnostic and the
  // sandboxed source-lane preview stays the only preview — never a fake
  // render. The door is wired; the Blitz engine drops in behind it.
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
