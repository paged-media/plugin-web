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
