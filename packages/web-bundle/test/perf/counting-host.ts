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

// The work counter the paged.web perf budgets stand on (adapted from
// plugin-draw's draw-bundle/test/perf/counting-host.ts).
//
// A web command's cost on the host side is the DOORS it goes through:
// every `host.document.*` call is a request/reply to the engine worker in
// the editor, and every `mutate` is a document rebuild (and, unless the
// host coalesces, an undo step). So the budgets count door calls, not
// milliseconds: a count is the same on a laptop and a CI runner, and a fix
// that halves it halves it everywhere.
//
// `countingHost(h.host)` wraps a real `BundleHost` in a Proxy that counts
// every function call by its dotted door name (`document.mutate`,
// `storage.parts.read`, …) and forwards it untouched. A door that RETURNS a
// surface (`contribute.sceneLayer()`) is wrapped too, so its methods count
// as `contribute.sceneLayer().submit`. Nothing is mocked: the engine still
// answers, so a budget and a behaviour assertion share one command.
//
// Hand the WRAPPED host to the command under test. A bundle activated
// through `h.loadBundle` holds the unwrapped host, so its own background
// work is deliberately not counted.

import type { BundleHost } from "@paged-media/plugin-api";

/** One `document.mutate` as the engine saw it. */
export interface CountedMutation {
  /** The op name; `"batch"` for a batch. */
  op: string;
  /** How many ops it carried — 1 unless it is a batch. */
  ops: number;
}

export interface WorkLog {
  /** Calls per door, keyed by dotted path from the host root. A
   *  `document.collection` call is also counted as
   *  `document.collection:<name>`. */
  readonly calls: Readonly<Record<string, number>>;
  /** Every `document.mutate`, in order. */
  readonly mutations: readonly CountedMutation[];
  /** Rows the engine handed BACK per collection name, across every
   *  `document.collection` reply. A call count cannot tell a 3-row read
   *  from a 3 000-row one; this can — a bake that re-reads every story per
   *  run shows up here growing with the SQUARE of the run count. Counted
   *  when the reply lands, so `settle()` first. */
  readonly rowsRead: Readonly<Record<string, number>>;
  /** Arguments of every call to the doors named in `captureArgs`. */
  readonly captured: Readonly<Record<string, readonly unknown[][]>>;
  /** Calls to one door (0 when it was never called). */
  count(door: string): number;
  /** Every `document.*` call that is not a write, a history step or a
   *  subscription — i.e. the engine round trips spent READING. */
  reads(): number;
  /** Every host door call, of any kind. */
  total(): number;
  /** Forget everything counted so far. */
  reset(): void;
  /** A frozen copy of the counts as they stand. */
  snapshot(): WorkLog;
}

const NOT_A_READ = new Set([
  "document.mutate",
  "document.undo",
  "document.redo",
  "document.onDidChange",
  "document.setMetadata",
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  !!v && typeof (v as PromiseLike<unknown>).then === "function";

export function countingHost(
  host: BundleHost,
  captureArgs: readonly string[] = [],
): { host: BundleHost; work: WorkLog } {
  let calls: Record<string, number> = {};
  let mutations: CountedMutation[] = [];
  let rowsRead: Record<string, number> = {};
  let captured: Record<string, unknown[][]> = {};
  const capture = new Set(captureArgs);
  const wrapped = new WeakMap<object, object>();

  const bump = (key: string): void => {
    calls[key] = (calls[key] ?? 0) + 1;
  };

  /** Count what a reply CARRIED, without touching what the caller sees. */
  const observe = (door: string, args: unknown[], result: unknown): void => {
    if (door !== "document.collection" || !isThenable(result)) return;
    const name = String(args[0]);
    result.then(
      (rows) => {
        if (Array.isArray(rows)) rowsRead[name] = (rowsRead[name] ?? 0) + rows.length;
      },
      () => {
        /* a refused read carried nothing */
      },
    );
  };

  const note = (door: string, args: unknown[]): void => {
    bump(door);
    if (capture.has(door)) (captured[door] ??= []).push(args);
    if (door === "document.collection") {
      bump(`document.collection:${String(args[0])}`);
    } else if (door === "document.mutate") {
      const m = args[0] as { op?: string; args?: { ops?: unknown[] } };
      mutations.push({
        op: m?.op ?? "?",
        ops: m?.op === "batch" ? (m.args?.ops?.length ?? 0) : 1,
      });
    }
  };

  const wrap = <T extends object>(target: T, path: string): T => {
    const hit = wrapped.get(target);
    if (hit) return hit as T;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof prop !== "string") return value;
        const door = path ? `${path}.${prop}` : prop;
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            note(door, args);
            const result = Reflect.apply(value, obj, args) as unknown;
            observe(door, args, result);
            // A door that hands back a SURFACE (not a promise): count its
            // methods too, as `<door>().<method>`.
            return isPlainObject(result) ? wrap(result, `${door}()`) : result;
          };
        }
        return isPlainObject(value) ? wrap(value, door) : value;
      },
    });
    wrapped.set(target, proxy);
    return proxy;
  };

  const logOver = (state: {
    calls: () => Record<string, number>;
    mutations: () => CountedMutation[];
    rowsRead: () => Record<string, number>;
    captured: () => Record<string, unknown[][]>;
    reset: () => void;
  }): WorkLog => ({
    get calls() {
      return state.calls();
    },
    get mutations() {
      return state.mutations();
    },
    get rowsRead() {
      return state.rowsRead();
    },
    get captured() {
      return state.captured();
    },
    count: (door) => state.calls()[door] ?? 0,
    reads: () =>
      Object.entries(state.calls())
        .filter(
          ([k]) => k.startsWith("document.") && !k.includes(":") && !NOT_A_READ.has(k),
        )
        .reduce((n, [, v]) => n + v, 0),
    total: () =>
      Object.entries(state.calls())
        .filter(([k]) => !k.includes(":"))
        .reduce((n, [, v]) => n + v, 0),
    reset: state.reset,
    snapshot: () => {
      const frozen = {
        calls: { ...state.calls() },
        mutations: [...state.mutations()],
        rowsRead: { ...state.rowsRead() },
        captured: { ...state.captured() },
      };
      return logOver({
        calls: () => frozen.calls,
        mutations: () => frozen.mutations,
        rowsRead: () => frozen.rowsRead,
        captured: () => frozen.captured,
        reset: () => {
          /* a snapshot is frozen */
        },
      });
    },
  });

  const work = logOver({
    calls: () => calls,
    mutations: () => mutations,
    rowsRead: () => rowsRead,
    captured: () => captured,
    reset: () => {
      calls = {};
      mutations = [];
      rowsRead = {};
      captured = {};
    },
  });

  return { host: wrap(host as unknown as object, "") as BundleHost, work };
}

/** Let in-flight replies land (the row observers hang off them). */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The per-test timeout the budget specs set. No budget is a duration, so
 *  a generous timeout hides nothing. */
export const BUDGET_TIMEOUT_MS = 120_000;

/** The whole log as one plain object — every door, not only the ones a
 *  budget names. */
export function workSummary(work: WorkLog): Record<string, unknown> {
  const calls: Record<string, number> = {};
  for (const door of Object.keys(work.calls).sort()) calls[door] = work.calls[door]!;
  const ops: Record<string, number> = {};
  for (const m of work.mutations) {
    const k = m.op === "batch" ? `batch(${m.ops})` : m.op;
    ops[k] = (ops[k] ?? 0) + 1;
  }
  return {
    total: work.total(),
    reads: work.reads(),
    calls,
    rowsRead: work.rowsRead,
    mutations: ops,
  };
}

/** HOW TO RE-MEASURE. Run the perf spec with `PERF_SHOW=1` and every
 *  scenario prints its full work log on one `PERF` line — the numbers a
 *  budget is pinned from. Silent otherwise. `extra` carries what a scenario
 *  measured beside the log (wasm calls, boundary bytes, engine counters,
 *  wall-clock). */
export function report(
  scenario: string,
  work: WorkLog,
  extra: Record<string, unknown> = {},
): WorkLog {
  if (process.env.PERF_SHOW) {
    // eslint-disable-next-line no-console
    console.log(`PERF ${scenario} ${JSON.stringify({ ...workSummary(work), ...extra })}`);
  }
  return work;
}
