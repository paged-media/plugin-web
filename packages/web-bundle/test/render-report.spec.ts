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

import { beforeEach, describe, expect, it } from "vitest";

import {
  formatDeferred,
  lastRenderReport,
  publishRenderReport,
  resetRenderReport,
  subscribeRenderReport,
} from "../src/render-report";

beforeEach(() => resetRenderReport());

describe("render-report store", () => {
  it("retains the last outcome with a monotonic sequence", () => {
    expect(lastRenderReport()).toBeNull();
    publishRenderReport({
      op: "renderFlow",
      rendered: true,
      submitted: 3,
      overset: true,
      deferred: {},
      messages: [],
    });
    publishRenderReport({
      op: "bake",
      rendered: true,
      submitted: 7,
      overset: null,
      deferred: { image: 2, gradient: 1 },
      messages: ["4 unsupported item(s) not baked"],
    });
    const r = lastRenderReport();
    expect(r?.op).toBe("bake");
    expect(r?.seq).toBe(2);
    expect(r?.deferred).toEqual({ image: 2, gradient: 1 });
  });

  it("notifies subscribers and honors unsubscribe", () => {
    let calls = 0;
    const off = subscribeRenderReport(() => {
      calls += 1;
    });
    publishRenderReport({
      op: "renderFrame",
      rendered: false,
      submitted: 0,
      overset: null,
      deferred: {},
      messages: ["engine not loaded"],
    });
    expect(calls).toBe(1);
    off();
    publishRenderReport({
      op: "renderFrame",
      rendered: false,
      submitted: 0,
      overset: null,
      deferred: {},
      messages: [],
    });
    expect(calls).toBe(1);
  });
});

describe("formatDeferred", () => {
  it("formats kind counts and stays empty on none", () => {
    expect(formatDeferred({})).toBe("");
    expect(formatDeferred({ image: 2, stroke: 1 })).toBe("image ×2 · stroke ×1");
  });
});
