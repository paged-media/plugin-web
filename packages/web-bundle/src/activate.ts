// The paged.web bundle entry. v0 scope (the honest slice API v0.2
// carries): the webFrame SOURCE lane — insert command, the source
// panel (HTML/CSS editors + sandboxed preview + diagnostics), and
// storage-backed persistence. The rendering lane (Blitz/WASM into
// Vello, concept §4) is the W0 engine spike; the manifest already
// declares the webFrame object type + edit context so the contract
// is forward-complete (both reserved host-side).

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";
import { contributePanel } from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";

import { insertWebFrame } from "./insert";
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
  host.log.info(`activated (apiVersion ${manifest.apiVersion})`);
  return { dispose() {} };
}

export { manifest, PANEL_ID };
