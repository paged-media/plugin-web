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

// CSS Regions syntax parser (flow-into / flow-from) — a scanner, never throws.

import { describe, expect, it } from "vitest";

import {
  flowRootSelector,
  flowSelectorFor,
  flowThreadOptions,
  namedFlowDiagnostics,
  parseFlowFrom,
  parseFlowInto,
} from "../src";

describe("parseFlowInto / flowRootSelector", () => {
  it("extracts the selector + flow name of a flow-into rule", () => {
    expect(parseFlowInto("#story { flow-into: main; color: red }")).toEqual([
      { selector: "#story", name: "main" },
    ]);
    expect(flowRootSelector("#story { flow-into: main }")).toBe("#story");
  });

  it("skips flow-into: none (the initial value)", () => {
    expect(parseFlowInto(".x { flow-into: none }")).toEqual([]);
    expect(flowRootSelector(".x { flow-into: none }")).toBeUndefined();
  });

  it("returns the FIRST flow-into selector as the flow root", () => {
    const css = "#a { flow-into: one } #b { flow-into: two }";
    expect(flowRootSelector(css)).toBe("#a");
    expect(parseFlowInto(css)).toHaveLength(2);
  });

  it("no flow-into → undefined root (the whole body flows)", () => {
    expect(flowRootSelector("p { color: red }")).toBeUndefined();
  });

  it("flowSelectorFor maps a flow NAME to its selector (multi-flow)", () => {
    const css = "#story { flow-into: main } #notes { flow-into: side }";
    expect(flowSelectorFor(css, "")).toBe("#story"); // primary = first
    expect(flowSelectorFor(css, "main")).toBe("#story");
    expect(flowSelectorFor(css, "side")).toBe("#notes");
    expect(flowSelectorFor(css, "absent")).toBeUndefined();
  });
});

describe("flowThreadOptions — the panel flow picker's model", () => {
  it("a single flow → one PRIMARY option (untagged, flowName undefined)", () => {
    expect(flowThreadOptions("#story { flow-into: main }")).toEqual([
      { flowName: undefined, name: "main", primary: true },
    ]);
  });

  it("makes EVERY named flow reachable — primary + each secondary in order", () => {
    const css =
      "#story{flow-into:main} #notes{flow-into:side} #ads{flow-into:promo}";
    expect(flowThreadOptions(css)).toEqual([
      { flowName: undefined, name: "main", primary: true },
      { flowName: "side", name: "side", primary: false },
      { flowName: "promo", name: "promo", primary: false },
    ]);
  });

  it("deduplicates a flow named across several selectors", () => {
    const css = "#a{flow-into:main} #b{flow-into:main} #c{flow-into:side}";
    expect(flowThreadOptions(css)).toEqual([
      { flowName: undefined, name: "main", primary: true },
      { flowName: "side", name: "side", primary: false },
    ]);
  });

  it("no flow-into → no options (no picker shown)", () => {
    expect(flowThreadOptions("p { color: red }")).toEqual([]);
    expect(flowThreadOptions(".x { flow-into: none }")).toEqual([]);
  });

  it("never throws on junk CSS", () => {
    expect(() => parseFlowInto("}{ flow-into ::: ")).not.toThrow();
    expect(() => parseFlowInto("")).not.toThrow();
  });
});

describe("parseFlowFrom", () => {
  it("extracts flow-from regions", () => {
    expect(parseFlowFrom(".region { flow-from: main }")).toEqual([
      { selector: ".region", name: "main" },
    ]);
  });
});

describe("namedFlowDiagnostics", () => {
  it("is silent when there are no named flows", () => {
    expect(namedFlowDiagnostics("p { color: red }")).toEqual([]);
  });

  it("reports the flow-into content root as info", () => {
    const d = namedFlowDiagnostics("#story { flow-into: main }");
    expect(d[0]).toMatchObject({ severity: "info", source: "css" });
    expect(d[0].message).toContain("#story");
    expect(d[0].message).toContain("main");
  });

  it("notes multiple named flows are each threadable via the picker (all render)", () => {
    const d = namedFlowDiagnostics("#a { flow-into: one } #b { flow-into: two }");
    expect(
      d.some(
        (x) =>
          x.severity === "info" &&
          x.message.includes("multiple named flows") &&
          x.message.includes("flow picker"),
      ),
    ).toBe(true);
    // No longer claims "only the first renders" (all named flows render now).
    expect(d.some((x) => x.message.includes("only the first"))).toBe(false);
  });

  it("notes that DOM flow-from regions are not used (the frame chain receives)", () => {
    const d = namedFlowDiagnostics("#a { flow-into: main } .r { flow-from: main }");
    expect(d.some((x) => x.message.includes("flow-from") && x.message.includes("frame chain"))).toBe(true);
  });
});
