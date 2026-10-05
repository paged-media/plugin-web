#!/usr/bin/env node
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

// parity-table.mjs — regenerate the measured tables in PARITY.md from the
// reports the Rust replay writes:
//
//   (cd ../web-render && cargo test --features blitz --test chrome_parity --test flow_parity)
//   node chrome/parity-table.mjs
//
// Only the block between the GENERATED markers is rewritten; the prose
// around it is hand-written.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HERE } from "./shared.mjs";

const TARGET = join(HERE, "../../web-render/target");
const chrome = JSON.parse(readFileSync(join(TARGET, "chrome-parity-report.json"), "utf8"));
const flow = JSON.parse(readFileSync(join(TARGET, "flow-parity-report.json"), "utf8"));

const ASPECTS = ["boxes", "breaks", "lines", "paint"];
const kind = (v) => (v === "agree" ? "agree" : v.startsWith("defect") ? "defect" : v.startsWith("diverges") ? "diverges" : "FAIL");
const cell = (v) => {
  const k = kind(v);
  if (k === "agree") return "agree";
  const id = /(CW|FW)-\d+/.exec(v);
  return k === "defect" ? `**defect ${id ? id[0] : ""}**` : k === "diverges" ? "diverges" : "FAIL";
};
const sum = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
const fmt = (n) => (Math.round(n * 100) / 100).toString();

const out = [];
out.push("### Summary by family");
out.push("");
out.push("| Family | Fixtures | boxes | breaks | lines | paint |");
out.push("|---|---:|---|---|---|---|");
const families = [...new Set(chrome.map((r) => r.family))].sort();
for (const fam of families) {
  const rs = chrome.filter((r) => r.family === fam);
  const cols = ASPECTS.map((a) => {
    const c = { agree: 0, defect: 0, diverges: 0, FAIL: 0 };
    for (const r of rs) c[kind(r.verdicts[a])]++;
    return [c.agree && `${c.agree} agree`, c.defect && `${c.defect} defect`, c.diverges && `${c.diverges} diverges`, c.FAIL && `${c.FAIL} FAIL`]
      .filter(Boolean)
      .join(", ");
  });
  out.push(`| ${fam} | ${rs.length} | ${cols.join(" | ")} |`);
}
const all = chrome.flatMap((r) => ASPECTS.map((a) => kind(r.verdicts[a])));
const count = (k) => all.filter((x) => x === k).length;
const fixturesAllAgree = chrome.filter((r) => ASPECTS.every((a) => kind(r.verdicts[a]) === "agree")).length;
out.push("");
out.push(
  `${chrome.length} fixtures x ${chrome[0].widths.length} widths, ${all.length} aspect verdicts: ` +
    `**${count("agree")} agree, ${count("defect")} defect, ${count("diverges")} diverges, ${count("FAIL")} fail**. ` +
    `${fixturesAllAgree} fixtures agree on every aspect.`,
);
out.push("");
out.push("### Per fixture");
out.push("");
out.push("Numbers per width (`240 / 400`): boxes agreeing/checked and the largest box delta (px); lines Chrome/Blitz; line positions agreeing/checked and the largest delta (px).");
out.push("");
out.push("| Fixture | boxes | breaks | lines | paint | boxes ok (max Δpx) | line count C/B | line pos ok (max Δpx) |");
out.push("|---|---|---|---|---|---|---|---|");
for (const r of chrome) {
  const w = r.widths;
  const bx = w.map((x) => `${x.boxes.agree}/${x.boxes.checked} (${fmt(x.boxes.max_delta)})`).join(" / ");
  const lc = w.map((x) => `${x.chrome_lines}/${x.blitz_lines}`).join(" / ");
  const lp = w.map((x) => `${x.lines.agree}/${x.lines.checked} (${fmt(x.lines.max_delta)})`).join(" / ");
  out.push(`| ${r.fixture} | ${ASPECTS.map((a) => cell(r.verdicts[a])).join(" | ")} | ${bx} | ${lc} | ${lp} |`);
}
out.push("");
out.push("### Fragmentation (flow) fixtures");
out.push("");
out.push("Words per frame, Chrome vs Blitz (`+` = overset).");
out.push("");
out.push("| Fixture | breaks | overset | conserve | Chrome words | Blitz words |");
out.push("|---|---|---|---|---|---|");
for (const r of flow) {
  const cw = r.chrome_words.join("/") + (r.chrome_overset ? " +" : "");
  const bw = r.blitz_words.join("/") + (r.blitz_overset ? " +" : "");
  out.push(`| ${r.fixture} | ${["breaks", "overset", "conserve"].map((a) => cell(r.verdicts[a])).join(" | ")} | ${cw} | ${bw} |`);
}

const file = join(HERE, "PARITY.md");
const md = readFileSync(file, "utf8");
const start = "<!-- GENERATED:BEGIN (chrome/parity-table.mjs) -->";
const end = "<!-- GENERATED:END -->";
const a = md.indexOf(start);
const b = md.indexOf(end);
if (a < 0 || b < 0) throw new Error("PARITY.md lacks the GENERATED markers");
writeFileSync(file, md.slice(0, a + start.length) + "\n\n" + out.join("\n") + "\n\n" + md.slice(b));
console.log(`parity-table: ${chrome.length} fixtures, ${flow.length} flow fixtures`);
