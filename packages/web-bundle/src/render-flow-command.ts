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

// The FLOW commands (ADR-020 rung 2) — thread one web source across a chain
// of frames, and render it.
//
//  · "Thread web flow into frames" (`threadSelectedIntoFlow`): append the
//    selected TARGET frames to the SOURCE web frame's PERSISTED region chain
//    (source = selection[0]; targets = the rest). The chain rides the source
//    envelope (web-model `WebFlowChain`), so it survives reopen — the fix for
//    the earlier ephemeral, selection-only chain.
//
//  · "Render web flow across frames" (`renderSelectedWebFlow`): resolve the
//    chain (the PERSISTED chain on the selected source frame wins; a >=2-frame
//    selection is the ephemeral fallback), load the engine, and submit one
//    C-1 SceneLayer per frame via `bakeWebFlow`. Honest: an engine that can't
//    load falls back to the not-loaded note; never a fake render.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  flowChainOf,
  parseFlowInto,
  sourceFromEnvelope,
  sourceKeyFor,
  withRecipient,
  withoutRecipient,
  type WebFrameSource,
} from "../../web-model/src";

import { bakeWebFlow, bakeWebFlows, type FlowBakeOutcome } from "./bake";
import { loadWebEngine } from "./engine-loader";
import { publishRenderReport } from "./render-report";
import { persistSource, readSourcePart } from "./source-part";

/** Diagnostics key suffix for the flow render lane — distinct from the
 *  single-frame render key + the panel lint key so notes don't clobber. */
const FLOW_DIAG_SUFFIX = "#renderFlow";

/** Read a frame's web source — the container part (preferred) then the
 *  metadata label — or `null` when the frame is not a web frame. */
async function readFlowSource(
  host: BundleHost,
  id: ElementId,
): Promise<WebFrameSource | null> {
  return (
    (await readSourcePart(host, id)) ??
    sourceFromEnvelope(await host.document.getMetadata(id))
  );
}

/**
 * Resolve the flow chain to render for a selection. The PERSISTED chain on
 * the (first) selected web frame wins — `[source, ...recipients]`; otherwise
 * a >=2-frame selection is the ephemeral fallback (an unthreaded ad-hoc
 * render). Returns `null` when there is nothing to thread (a lone unthreaded
 * frame, or an empty selection). Exported for unit tests.
 */
export async function resolveFlowChain(
  host: BundleHost,
  selection: ElementId[],
): Promise<ElementId[] | null> {
  if (selection.length === 0) return null;
  const sourceId = selection[0];
  const sourceTarget = asFrameTarget(sourceId);
  if (sourceTarget) {
    const source = await readFlowSource(host, sourceId);
    if (source?.flow && source.flow.recipients.length > 0) {
      // The persisted chain wins. FrameTarget[] is ElementId-shaped for
      // string-id page items — exactly what the recipients are.
      return flowChainOf(source, sourceTarget) as unknown as ElementId[];
    }
  }
  return selection.length >= 2 ? selection : null;
}

/**
 * "Render web flow": resolve the chain, load the engine, submit one layer
 * per frame, and report the outcome honestly (submitted count + overset, or
 * the not-loaded note in the Problems panel).
 */
export async function renderSelectedWebFlow(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.info(
      "renderWebFlow: select a threaded web frame, or a source web frame plus target frames",
    );
    return;
  }

  const sourceId = selection[0];
  const sourceTarget = asFrameTarget(sourceId);
  const source = sourceTarget ? await readFlowSource(host, sourceId) : null;
  const engine = await loadWebEngine(host);

  let outcome: FlowBakeOutcome;
  if (source?.flow) {
    // A PERSISTED flow (single or CSS multi-flow) → render every flow group.
    outcome = await bakeWebFlows(host, sourceId, engine);
  } else {
    // No persisted flow → the ephemeral selection-derived single flow.
    const chain = await resolveFlowChain(host, selection);
    if (!chain) {
      host.log.info(
        "renderWebFlow: this web frame has no flow — thread it into target frames first",
      );
      return;
    }
    outcome = await bakeWebFlow(host, chain, engine);
  }

  if (sourceTarget) {
    host.diagnostics.set(
      sourceKeyFor(sourceTarget) + FLOW_DIAG_SUFFIX,
      outcome.diagnostics,
    );
  }

  publishRenderReport({
    op: "renderFlow",
    rendered: outcome.rendered,
    submitted: outcome.submittedCount,
    overset: outcome.overset,
    deferred: {},
    messages: outcome.diagnostics.map((d) => d.message),
  });

  if (outcome.submittedCount > 0) {
    host.log.info(
      `renderWebFlow: threaded ${outcome.submittedCount} frame(s)` +
        (outcome.overset ? " (overset — content remains past the last frame)" : ""),
    );
  } else if (outcome.rendered) {
    host.log.info(
      "renderWebFlow: rendered, but the host wired no scene channel — not composited",
    );
  } else {
    host.log.info(
      "renderWebFlow: " +
        (outcome.diagnostics[0]?.message ?? "engine not loaded"),
    );
  }
}

/**
 * "Thread web flow into frames": append the selected target frames to the
 * source web frame's PERSISTED region chain. Source = selection[0]; targets
 * = the rest (in selection order). Self-references + already-threaded frames
 * are skipped (via `withRecipient`); persists only when something changed.
 */
export async function threadSelectedIntoFlow(
  host: BundleHost,
  flowName?: string,
  selectionOverride?: ElementId[],
): Promise<void> {
  // The panel picker passes the selection it was RENDERED for: clicking a
  // panel button can collapse the live canvas selection, so acting on
  // `host.selection.get()` at click time would see nothing.
  const selection = selectionOverride ?? host.selection.get();
  if (selection.length < 2) {
    host.log.info(
      "threadWebFlow: select the source web frame plus one or more target frames",
    );
    return;
  }

  const sourceId = selection[0];
  const sourceTarget = asFrameTarget(sourceId);
  if (!sourceTarget) {
    host.log.info("threadWebFlow: the first selection is not a page-item frame");
    return;
  }

  const source = await readFlowSource(host, sourceId);
  if (!source) {
    host.log.info("threadWebFlow: the first selected frame is not a web frame");
    return;
  }

  let next = source;
  let added = 0;
  for (const targetId of selection.slice(1)) {
    const target = asFrameTarget(targetId);
    if (!target) continue;
    const updated = withRecipient(next, sourceTarget, target, flowName);
    if (updated !== next) {
      next = updated;
      added += 1;
    }
  }

  if (added === 0) {
    host.log.info(
      "threadWebFlow: no new target frames to add (already threaded, or self)",
    );
    return;
  }

  await persistSource(host, sourceId, next);
  const chainLength = (next.flow?.recipients.length ?? 0) + 1;
  host.log.info(
    `threadWebFlow: threaded ${added} frame(s) — flow chain length ${chainLength}`,
  );
}

/**
 * "Thread web flow into the NAMED flow": route the selected target frames to
 * the source's SECONDARY named flow (CSS multi-flow). The first `flow-into` is
 * the primary flow (use "Thread web flow into frames" for it); this command
 * targets the second `flow-into` — the common two-flow case (an article body +
 * a sidebar) — without needing a flow picker (the host exposes none). For a
 * source with >2 named flows it routes to the second and logs.
 */
export async function threadSelectedIntoNamedFlow(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length < 2) {
    host.log.info(
      "threadWebFlowNamed: select the source web frame plus one or more target frames",
    );
    return;
  }
  const sourceTarget = asFrameTarget(selection[0]);
  const source = sourceTarget ? await readFlowSource(host, selection[0]) : null;
  if (!source) {
    host.log.info("threadWebFlowNamed: the first selected frame is not a web frame");
    return;
  }
  const flows = parseFlowInto(source.css);
  if (flows.length < 2) {
    host.log.info(
      "threadWebFlowNamed: the source declares no secondary named flow — add a second `flow-into` rule",
    );
    return;
  }
  const name = flows[1].name;
  await threadSelectedIntoFlow(host, name);
  host.log.info(`threadWebFlowNamed: routed into named flow '${name}'`);
}

/**
 * "Unthread web flow": remove the selected target frames from the source web
 * frame's persisted region chain (source = selection[0]; targets = the rest).
 * The inverse of `threadSelectedIntoFlow`; persists only when something
 * changed. Frames not in the chain are ignored.
 */
export async function unthreadSelectedFromFlow(
  host: BundleHost,
  selectionOverride?: ElementId[],
): Promise<void> {
  const selection = selectionOverride ?? host.selection.get();
  if (selection.length < 2) {
    host.log.info(
      "unthreadWebFlow: select the source web frame plus the target frame(s) to remove",
    );
    return;
  }

  const sourceId = selection[0];
  const sourceTarget = asFrameTarget(sourceId);
  if (!sourceTarget) {
    host.log.info("unthreadWebFlow: the first selection is not a page-item frame");
    return;
  }

  const source = await readFlowSource(host, sourceId);
  if (!source) {
    host.log.info("unthreadWebFlow: the first selected frame is not a web frame");
    return;
  }

  let next = source;
  let removed = 0;
  for (const targetId of selection.slice(1)) {
    const target = asFrameTarget(targetId);
    if (!target) continue;
    const updated = withoutRecipient(next, target.id);
    if (updated !== next) {
      next = updated;
      removed += 1;
    }
  }

  if (removed === 0) {
    host.log.info("unthreadWebFlow: none of the selected frames were in the flow");
    return;
  }

  await persistSource(host, sourceId, next);
  host.log.info(`unthreadWebFlow: removed ${removed} frame(s) from the flow`);
}
