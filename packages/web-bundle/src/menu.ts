/**
 * paged.web — the menu bar entries.
 *
 * A top-level `Web` menu for the render/flow/bake verbs, plus the insert verb in the host's `Object` menu where minting a page item lives.
 *
 * Registered through `contribute.menu()` (plugin-api 0.2.33). Before it
 * there was no menu door at all, so every verb here lived behind Cmd+K
 * and nowhere else.
 *
 * `Object ▸ Insert web frame…` is the SAME path the host curates as a
 * courtesy, deliberately: `fallbackFor` lets this entry supersede it, so
 * the item stays where the user already found it while the host stops
 * naming this bundle by hand.
 * */

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

const C = "media.paged.web.command";

/** `[path, command suffix, group]`. */
const ENTRIES: [path: string, suffix: string, group: string][] = [
  ["Object/Insert web frame…", "insertWebFrame", "insert-plugin"],
  ["Web/Render frame", "renderWebFrame", "render"],
  ["Web/Render flow across frames", "renderWebFlow", "render"],
  ["Web/Thread flow into frames", "threadWebFlow", "flow"],
  ["Web/Thread into named flow…", "threadWebFlowNamed", "flow"],
  ["Web/Unthread flow", "unthreadWebFlow", "flow-off"],
  ["Web/Bake to document", "bakeWebFrame", "bake"],
];

/**
 * Register every entry; one Disposable drops them all. Degrades on a
 * host older than plugin-api 0.2.33 by contributing nothing and saying
 * so, rather than throwing and taking the bundle down over a menu.
 */
export function contributeMenu(host: BundleHost): Disposable {
  const contribute = host.contribute as BundleHost["contribute"] & {
    menu?: (c: {
      path: string;
      command: string;
      order?: number;
      group?: string;
    }) => Disposable;
  };
  if (typeof contribute.menu !== "function") {
    host.log.info(
      "host predates contribute.menu (plugin-api 0.2.33) — " +
        `${ENTRIES.length} menu entries not contributed; every command ` +
        "remains reachable through the command palette",
    );
    return { dispose() {} };
  }

  const handles: Disposable[] = [];
  const perGroup = new Map<string, number>();
  for (const [path, suffix, group] of ENTRIES) {
    const n = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, n);
    handles.push(
      contribute.menu({ path, command: `${C}.${suffix}`, group, order: n * 10 }),
    );
  }
  host.log.info(`contributed ${handles.length} menu entries`);
  return {
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}

/** Exported for the bundle's own test. */
export const MENU_ENTRIES = ENTRIES;
export const MENU_COMMAND_PREFIX = C;
