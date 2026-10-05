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

// Unsaved drafts, kept per frame for the life of the panel.
//
// The source editor remounts whenever the selected frame changes or an undo
// reverts the source under it; the draft it held used to vanish with it.
// The panel keeps every DIRTY draft here, keyed by the frame's source key,
// and a remounted editor starts from it (still shown as unsaved). In memory
// only: a draft is not the document — "Save to document" is.

import type { WebFrameSource } from "../../../web-model/src";

export interface DraftStore {
  /** The kept unsaved draft for a frame, if any. */
  get(key: string): WebFrameSource | undefined;
  /** Record the editor's current draft: kept while it differs from the
   *  persisted source, dropped once it equals it (saved, or edited back). */
  track(key: string, draft: WebFrameSource, persisted: WebFrameSource): void;
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, WebFrameSource>();
  return {
    get: (key) => drafts.get(key),
    track(key, draft, persisted) {
      if (JSON.stringify(draft) === JSON.stringify(persisted)) drafts.delete(key);
      else drafts.set(key, draft);
    },
  };
}

// ------------------------------------------------------------- history

/** Edits closer together than this (ms) are one undo step — typing a
 *  word is one step, not one per keystroke. */
export const COALESCE_MS = 1000;

/** Per-frame draft history: the states the draft went through, the
 *  current position, and when the top state was recorded. */
interface History {
  states: WebFrameSource[];
  at: number;
  lastAt: number;
}

const same = (a: WebFrameSource, b: WebFrameSource) => JSON.stringify(a) === JSON.stringify(b);

/** The panel's drafts plus their undo history, shared by the panel and the
 *  web frame's edit context: while the context is active the host routes
 *  Cmd+Z / Shift+Cmd+Z to the context (ADR 012), which steps the history
 *  of the frame it was entered on; the panel shows the stepped draft. */
export interface DraftSession {
  drafts: DraftStore;
  /** Record the draft's current state (an edit, or the state on mount). */
  record(key: string, draft: WebFrameSource): void;
  canUndo(key: string): boolean;
  canRedo(key: string): boolean;
  /** Step back / forward; the panel is told through `onApply`. */
  undo(key: string): boolean;
  redo(key: string): boolean;
  /** The panel showing `key` follows stepped states. */
  onApply(listener: (key: string, draft: WebFrameSource) => void): () => void;
}

export function createDraftSession(opts: { now?: () => number } = {}): DraftSession {
  const now = opts.now ?? (() => Date.now());
  const histories = new Map<string, History>();
  const listeners = new Set<(key: string, draft: WebFrameSource) => void>();
  const step = (key: string, by: -1 | 1): boolean => {
    const h = histories.get(key);
    if (!h) return false;
    const to = h.at + by;
    if (to < 0 || to >= h.states.length) return false;
    h.at = to;
    h.lastAt = -Infinity; // the next edit starts a new step
    for (const l of listeners) l(key, h.states[to]);
    return true;
  };
  return {
    drafts: createDraftStore(),
    record(key, draft) {
      const t = now();
      const h = histories.get(key);
      if (!h) {
        histories.set(key, { states: [draft], at: 0, lastAt: -Infinity });
        return;
      }
      if (same(h.states[h.at], draft)) return;
      h.states.length = h.at + 1; // a new edit drops the redo branch
      if (h.at > 0 && t - h.lastAt < COALESCE_MS) h.states[h.at] = draft;
      else {
        h.states.push(draft);
        h.at += 1;
      }
      h.lastAt = t;
    },
    canUndo: (key) => (histories.get(key)?.at ?? 0) > 0,
    canRedo: (key) => {
      const h = histories.get(key);
      return !!h && h.at < h.states.length - 1;
    },
    undo: (key) => step(key, -1),
    redo: (key) => step(key, 1),
    onApply(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
