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

// Ask InDesign what a baked web frame became: every page item on page 1 in
// creation order (type, geometric bounds in points from the page origin,
// fill swatch; for text frames the contents, overset state, point size,
// text fill, font style and first baseline), every swatch with its colour
// space and value, and the fonts the document uses with their status. run.sh drives it; the answer is
// committed as answers/<fixture>.json and checked by
// test/indesign-bake.spec.ts.
(function () {
    var IDML = $.global.PROBE_IDML, OUT = $.global.PROBE_OUT;
    function q(s) { s = String(s); return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\u2029\u2028]/g, "\\n").replace(/\t/g, "\\t") + '"'; }
    function r3(v) { return Math.round(v * 1000) / 1000; }
    function arr(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(r3(a[i])); return "[" + o.join(",") + "]"; }
    var out = [];
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.open(File(IDML), false);
    try {
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.rulerOrigin = RulerOrigin.PAGE_ORIGIN;
        doc.zeroPoint = [0, 0];
        var page = doc.pages[0];
        var items = page.allPageItems;
        // allPageItems is front-to-back; creation order is back-to-front.
        var list = [];
        for (var i = items.length - 1; i >= 0; i--) {
            var it = items[i];
            var s = '{"type":' + q(it.constructor.name) + ',"bounds":' + arr(it.geometricBounds) +
                ',"fill":' + q(it.fillColor.name);
            if (it.constructor.name === "TextFrame") {
                var ch = it.parentStory.characters;
                s += ',"contents":' + q(it.parentStory.contents) + ',"overflows":' + it.overflows +
                    ',"pointSize":' + (ch.length ? r3(ch[0].pointSize) : "null") +
                    ',"textFill":' + (ch.length ? q(ch[0].fillColor.name) : "null") +
                    ',"font":' + (ch.length ? q(ch[0].appliedFont.name) : "null") +
                    ',"fontStyle":' + (ch.length ? q(ch[0].fontStyle) : "null") +
                    ',"baseline":' + (it.lines.length ? r3(it.lines[0].baseline) : "null") +
                    ',"lines":' + it.lines.length;
            }
            list.push(s + "}");
        }
        var sw = [];
        for (var k = 0; k < doc.colors.length; k++) {
            var c = doc.colors[k];
            if (!c.name) continue;
            sw.push('{"name":' + q(c.name) + ',"space":' + q(String(c.space).replace(/^.*\./, "")) + ',"value":' + arr(c.colorValue) + "}");
        }
        var fonts = [];
        for (var f = 0; f < doc.fonts.length; f++) {
            fonts.push('{"name":' + q(doc.fonts[f].name) + ',"status":' + q(doc.fonts[f].status) + "}");
        }
        out.push('"indesign":' + q(app.version));
        out.push('"page":' + arr(page.bounds));
        out.push('"items":[' + list.join(",") + "]");
        out.push('"swatches":[' + sw.join(",") + "]");
        out.push('"fonts":[' + fonts.join(",") + "]");
    } finally {
        doc.close(SaveOptions.NO);
    }
    var o = File(OUT);
    o.encoding = "UTF-8";
    o.open("w");
    o.write("{" + out.join(",\n") + "}\n");
    o.close();
})();
