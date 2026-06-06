// "Insert web frame" — one undoable insertFrame on the active page,
// the default source stored under the created element's key, the new
// frame selected, and the source panel opened. The frame itself is
// an ordinary rectangle (the manifest's declared baked fallback);
// what makes it a webFrame is the source attached to it — exactly
// the §5 model, pending engine-side metadata (BREAKAGE_LOG W-02).

import type { BundleHost, PageId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  DEFAULT_SOURCE,
  sourceKeyFor,
} from "@paged-media/web-model";

/** Default frame bounds, page-local pt: [top, left, bottom, right]. */
const DEFAULT_BOUNDS: [number, number, number, number] = [60, 60, 240, 300];

interface PageSummaryLike {
  selfId: string;
}

async function activePageId(host: BundleHost): Promise<PageId | null> {
  const meta = await host.document.meta();
  if (meta.activePage) return meta.activePage;
  const pages = await host.document.collection<PageSummaryLike>("pages");
  return pages.length > 0 ? pages[0].selfId : null;
}

export async function insertWebFrame(
  host: BundleHost,
  panelId: string,
): Promise<void> {
  const pageId = await activePageId(host);
  if (!pageId) {
    host.log.warn("insertWebFrame: no page to insert into");
    return;
  }
  const outcome = await host.document.mutate({
    op: "insertFrame",
    args: { pageId, bounds: DEFAULT_BOUNDS },
  });
  if (!outcome.applied || !outcome.createdId) {
    host.log.warn("insertWebFrame rejected by engine", outcome);
    return;
  }
  const target = asFrameTarget(outcome.createdId);
  if (!target) {
    host.log.warn("insertWebFrame: created element is not a frame target");
    return;
  }
  host.storage.set(sourceKeyFor(target), DEFAULT_SOURCE);
  await host.selection.set([outcome.createdId]);
  host.shell.openPanel(panelId);
}
