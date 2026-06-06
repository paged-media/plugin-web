import { describe, expect, it } from "vitest";

import { diagnoseHtml } from "../src/diagnose";
import { composeSrcdoc, DEFAULT_SOURCE, sourceKeyFor } from "../src/source";

describe("diagnoseHtml — policy", () => {
  it("flags <script> as a policy error with its line", () => {
    const d = diagnoseHtml('<p>ok</p>\n<script>alert(1)</script>');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("error");
    expect(d[0].line).toBe(2);
    expect(d[0].message).toMatch(/never executes/);
  });

  it("flags event-handler attributes as ignored", () => {
    const d = diagnoseHtml('<button onclick="x()">hi</button>');
    expect(d[0].severity).toBe("warning");
    expect(d[0].message).toMatch(/event-handler/);
  });

  it("empty source is an info, not an error", () => {
    expect(diagnoseHtml("  \n")).toEqual([
      { severity: "info", message: "empty web frame", source: "html" },
    ]);
  });
});

describe("diagnoseHtml — balance", () => {
  it("clean fragments produce no diagnostics", () => {
    expect(
      diagnoseHtml('<div class="a"><p>x <b>y</b></p><img src="i.png"></div>'),
    ).toEqual([]);
    expect(diagnoseHtml(DEFAULT_SOURCE.html)).toEqual([]);
  });

  it("reports never-closed tags with their open line", () => {
    const d = diagnoseHtml("<div>\n<p>text");
    expect(d.map((x) => x.message)).toEqual([
      "<div> is never closed",
      "<p> is never closed",
    ]);
    expect(d[0].line).toBe(1);
    expect(d[1].line).toBe(2);
  });

  it("reports stray close tags", () => {
    const d = diagnoseHtml("<p>x</p></div>");
    expect(d[0].message).toBe("</div> has no matching open tag");
  });

  it("self-closing and void tags do not unbalance", () => {
    expect(diagnoseHtml('<br><hr/><meta charset="utf-8"><p>x</p>')).toEqual([]);
  });

  it("closing an outer tag reports the skipped inner one", () => {
    const d = diagnoseHtml("<div><span>x</div>");
    expect(d.map((x) => x.message)).toEqual(["<span> is never closed"]);
  });
});

describe("source model", () => {
  it("composeSrcdoc embeds css and the media class", () => {
    const doc = composeSrcdoc({
      html: "<p>hi</p>",
      css: "p{color:red}",
      options: { media: "print", overflow: "clip" },
    });
    expect(doc).toContain("<style>p{color:red}</style>");
    expect(doc).toContain('class="media-print"');
    expect(doc).toContain("<p>hi</p>");
  });

  it("sourceKeyFor is stable per element", () => {
    expect(sourceKeyFor({ kind: "rectangle", id: "u42" })).toBe(
      "source.rectangle:u42",
    );
  });
});
