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

// A tiny trailing-edge debouncer — the unit under the panel's
// keystroke→preview lane (Phase 2c task 2). Kept as a plain object
// (no React) so the timing semantics are testable with fake timers
// without rendering: `schedule` REPLACES any pending callback and
// restarts the window, so a burst of keystrokes yields exactly one
// trailing invocation `ms` after the last one.

export interface Debouncer {
  /** Replace the pending callback (if any) and restart the window. */
  schedule(fn: () => void): void;
  /** Drop the pending callback without running it. */
  cancel(): void;
  /** Whether a callback is currently pending. */
  pending(): boolean;
}

export function createDebouncer(ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(fn) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pending() {
      return timer !== null;
    },
  };
}
