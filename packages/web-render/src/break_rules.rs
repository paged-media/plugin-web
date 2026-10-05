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

//! Fragmentation rules (feature = `blitz`): `break-before`, `break-after`,
//! `break-inside`, `orphans`, `widows` and `@page` margins, read from the
//! document's own CSS.
//!
//! The pinned Stylo builds these properties for Gecko only, so the computed
//! style never carries them. This module reads them itself, the way the
//! bundle reads CSS Regions `flow-into` (`web-model/src/css-flow.ts`): a
//! scanner over the text of every `<style>` element plus each element's
//! `style` attribute, with rule selectors matched by Blitz's own selector
//! engine. The cascade is simplified (ADR 412): rules apply in source
//! order, a later rule wins per property, an inline `style` wins over every
//! rule; specificity is not compared. `@media` blocks are skipped (the
//! engine lays out for the screen), so are other at-rules except `@page`.
//!
//! A frame is a page box (ADR 412): `@page` margins inset the content of
//! every frame; `@page size` is not applied, the frame's size is the page
//! size.

use std::collections::HashMap;

use blitz_dom::BaseDocument;

/// A `break-before` / `break-after` value, reduced to what fragmentation
/// does with it. `page`, `column`, `always`, `left`, `right`, `recto`,
/// `verso` and `region` are all a forced frame break, because a frame is
/// both the page and the column of a web flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Between {
    Auto,
    Forced,
    Avoid,
}

/// A `break-inside` value: `avoid`, `avoid-page`, `avoid-column` and
/// `avoid-region` all keep the box in one frame where possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Within {
    Auto,
    Avoid,
}

/// The fragmentation properties one element declares (absent = not
/// declared on that element).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BreakProps {
    pub before: Option<Between>,
    pub after: Option<Between>,
    pub inside: Option<Within>,
    pub orphans: Option<u32>,
    pub widows: Option<u32>,
}

impl BreakProps {
    fn merge(&mut self, other: &BreakProps) {
        self.before = other.before.or(self.before);
        self.after = other.after.or(self.after);
        self.inside = other.inside.or(self.inside);
        self.orphans = other.orphans.or(self.orphans);
        self.widows = other.widows.or(self.widows);
    }

    fn is_empty(&self) -> bool {
        *self == BreakProps::default()
    }
}

/// The CSS initial value of `orphans` and `widows`.
pub const DEFAULT_ORPHANS: u32 = 2;
pub const DEFAULT_WIDOWS: u32 = 2;

/// `@page` margins in CSS px, `[top, right, bottom, left]`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PageBox {
    pub margin_px: [f32; 4],
    /// Whether an `@page` rule declared `size` (not applied: the frame's
    /// size is the page size).
    pub declares_size: bool,
}

impl PageBox {
    pub fn top(&self) -> f32 {
        self.margin_px[0]
    }
    pub fn bottom(&self) -> f32 {
        self.margin_px[2]
    }
    pub fn has_margin(&self) -> bool {
        self.margin_px.iter().any(|m| *m > 0.0)
    }
}

/// Every element's fragmentation properties, resolved once per flow.
/// Node ids are stable across the flow's DOM mutations (removing a node or
/// editing a text node does not renumber the others).
#[derive(Debug, Default)]
pub struct BreakRules {
    by_node: HashMap<usize, BreakProps>,
    pub page: PageBox,
}

impl BreakRules {
    /// Read every `<style>` element and `style` attribute of `doc`.
    pub fn from_doc(doc: &BaseDocument) -> Self {
        let mut rules = BreakRules::default();
        let css = style_text(doc);
        let sheet = scan_stylesheet(&css);
        rules.page = sheet.page;
        for (selector, props) in &sheet.rules {
            let Ok(ids) = doc.query_selector_all(selector) else {
                continue; // a selector the engine cannot parse
            };
            for id in ids {
                rules.by_node.entry(id).or_default().merge(props);
            }
        }
        // Inline `style` attributes win over every rule.
        let mut stack = vec![doc.root_node().id];
        while let Some(id) = stack.pop() {
            let Some(node) = doc.get_node(id) else {
                continue;
            };
            if let Some(el) = node.element_data() {
                if let Some(style) = el
                    .attrs()
                    .iter()
                    .find(|a| &*a.name.local == "style")
                    .map(|a| a.value.as_str())
                {
                    let props = parse_declarations(style);
                    if !props.is_empty() {
                        rules.by_node.entry(id).or_default().merge(&props);
                    }
                }
            }
            stack.extend(node.children.iter().copied());
        }
        rules
    }

    /// Whether no element declares a fragmentation property.
    pub fn is_empty(&self) -> bool {
        self.by_node.is_empty()
    }

    fn props(&self, id: usize) -> BreakProps {
        self.by_node.get(&id).copied().unwrap_or_default()
    }

    pub fn before(&self, id: usize) -> Between {
        self.props(id).before.unwrap_or(Between::Auto)
    }

    pub fn after(&self, id: usize) -> Between {
        self.props(id).after.unwrap_or(Between::Auto)
    }

    pub fn inside(&self, id: usize) -> Within {
        self.props(id).inside.unwrap_or(Within::Auto)
    }

    /// `orphans` of `id` — an inherited property: the nearest ancestor-or-
    /// self that declares it, else the initial value 2.
    pub fn orphans(&self, doc: &BaseDocument, id: usize) -> u32 {
        self.inherited(doc, id, |p| p.orphans)
            .unwrap_or(DEFAULT_ORPHANS)
    }

    /// `widows` of `id` (inherited, initial 2).
    pub fn widows(&self, doc: &BaseDocument, id: usize) -> u32 {
        self.inherited(doc, id, |p| p.widows)
            .unwrap_or(DEFAULT_WIDOWS)
    }

    fn inherited(
        &self,
        doc: &BaseDocument,
        id: usize,
        pick: impl Fn(&BreakProps) -> Option<u32>,
    ) -> Option<u32> {
        let mut cur = Some(id);
        while let Some(n) = cur {
            if let Some(v) = self.by_node.get(&n).and_then(&pick) {
                return Some(v.max(1));
            }
            cur = doc.get_node(n).and_then(|node| node.parent);
        }
        None
    }
}

/// Apply the document's `@page` margins as the root element's PADDING, so
/// every frame lays its content out inside the page area. (Padding, not
/// margin: the engine ignores margins on the root element, and padding does
/// not collapse with the first child's margin, as a page margin does not.)
/// Returns the page box (no margins when the document declares no `@page`
/// rule).
pub fn apply_page_box(doc: &mut BaseDocument) -> PageBox {
    let page = scan_stylesheet(&style_text(doc)).page;
    if page.has_margin() {
        let html = doc.root_element().id;
        let [t, r, b, l] = page.margin_px;
        doc.set_style_property(html, "padding", &format!("{t}px {r}px {b}px {l}px"));
    }
    page
}

/// The concatenated text of every `<style>` element, in document order.
fn style_text(doc: &BaseDocument) -> String {
    let mut out = String::new();
    if let Ok(ids) = doc.query_selector_all("style") {
        for id in ids {
            if let Some(node) = doc.get_node(id) {
                out.push_str(&node.text_content());
                out.push('\n');
            }
        }
    }
    out
}

/// What a stylesheet says about fragmentation: `(selector, properties)` in
/// source order, and the `@page` box.
#[derive(Debug, Default)]
pub struct ScannedSheet {
    pub rules: Vec<(String, BreakProps)>,
    pub page: PageBox,
}

/// Scan a stylesheet. A scanner, not a parser: comments are dropped,
/// braces balanced, and anything it does not understand is skipped.
pub fn scan_stylesheet(css: &str) -> ScannedSheet {
    let css = strip_comments(css);
    let bytes = css.as_bytes();
    let mut out = ScannedSheet::default();
    let mut i = 0usize;
    while i < bytes.len() {
        // The prelude runs to the next `{` or `;` at this level.
        let start = i;
        while i < bytes.len() && bytes[i] != b'{' && bytes[i] != b';' {
            i += 1;
        }
        let prelude = css[start..i].trim();
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == b';' {
            i += 1; // `@import …;` / `@charset …;`
            continue;
        }
        // A block: find its matching `}`.
        let body_start = i + 1;
        let mut depth = 1usize;
        i += 1;
        while i < bytes.len() && depth > 0 {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        let body_end = if depth == 0 { i - 1 } else { i };
        let body = &css[body_start..body_end.max(body_start)];
        if let Some(at) = prelude.strip_prefix('@') {
            let name = at
                .split(|c: char| c.is_whitespace() || c == ':')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            // `@page` and `@page :first` alike (pseudo pages are not
            // distinguished: every frame is a page).
            if name == "page" {
                let page = parse_page_block(body);
                for (k, m) in page.margin_px.iter().enumerate() {
                    if *m > 0.0 || page.margin_set[k] {
                        out.page.margin_px[k] = *m;
                    }
                }
                out.page.declares_size |= page.declares_size;
            }
            continue; // every other at-rule (incl. `@media`) is skipped
        }
        if prelude.is_empty() {
            continue;
        }
        let props = parse_declarations(body);
        if !props.is_empty() {
            out.rules.push((prelude.to_string(), props));
        }
    }
    out
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(at) = rest.find("/*") {
        out.push_str(&rest[..at]);
        match rest[at + 2..].find("*/") {
            Some(end) => rest = &rest[at + 2 + end + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// The declarations of one block (`name: value; …`).
fn declarations(body: &str) -> impl Iterator<Item = (String, String)> + '_ {
    body.split(';').filter_map(|decl| {
        let (name, value) = decl.split_once(':')?;
        let value = value.trim();
        let value = value
            .strip_suffix("!important")
            .unwrap_or(value)
            .trim()
            .to_ascii_lowercase();
        Some((name.trim().to_ascii_lowercase(), value))
    })
}

/// Parse the fragmentation properties out of a declaration block (a rule
/// body or a `style` attribute). Unknown values are ignored.
pub fn parse_declarations(body: &str) -> BreakProps {
    let mut p = BreakProps::default();
    for (name, value) in declarations(body) {
        match name.as_str() {
            "break-before" => p.before = between(&value).or(p.before),
            "break-after" => p.after = between(&value).or(p.after),
            "page-break-before" => p.before = legacy_between(&value).or(p.before),
            "page-break-after" => p.after = legacy_between(&value).or(p.after),
            "break-inside" | "page-break-inside" => p.inside = within(&value).or(p.inside),
            "orphans" => p.orphans = value.parse::<u32>().ok().filter(|n| *n > 0).or(p.orphans),
            "widows" => p.widows = value.parse::<u32>().ok().filter(|n| *n > 0).or(p.widows),
            _ => {}
        }
    }
    p
}

fn between(v: &str) -> Option<Between> {
    match v {
        "auto" => Some(Between::Auto),
        "page" | "column" | "always" | "left" | "right" | "recto" | "verso" | "region" | "all" => {
            Some(Between::Forced)
        }
        "avoid" | "avoid-page" | "avoid-column" | "avoid-region" => Some(Between::Avoid),
        _ => None,
    }
}

/// `page-break-before/after` (CSS 2): `always` / `left` / `right` force,
/// `avoid` avoids.
fn legacy_between(v: &str) -> Option<Between> {
    match v {
        "auto" => Some(Between::Auto),
        "always" | "left" | "right" => Some(Between::Forced),
        "avoid" => Some(Between::Avoid),
        _ => None,
    }
}

fn within(v: &str) -> Option<Within> {
    match v {
        "auto" => Some(Within::Auto),
        "avoid" | "avoid-page" | "avoid-column" | "avoid-region" => Some(Within::Avoid),
        _ => None,
    }
}

struct PageBlock {
    margin_px: [f32; 4],
    margin_set: [bool; 4],
    declares_size: bool,
}

fn parse_page_block(body: &str) -> PageBlock {
    let mut out = PageBlock {
        margin_px: [0.0; 4],
        margin_set: [false; 4],
        declares_size: false,
    };
    // Nested margin boxes (`@top-center { … }`) are not page margins.
    let flat: String = {
        let mut s = String::new();
        let mut depth = 0usize;
        for c in body.chars() {
            match c {
                '{' => depth += 1,
                '}' => depth = depth.saturating_sub(1),
                _ if depth == 0 => s.push(c),
                _ => {}
            }
        }
        s
    };
    for (name, value) in declarations(&flat) {
        let mut set = |k: usize, v: Option<f32>| {
            if let Some(v) = v {
                out.margin_px[k] = v.max(0.0);
                out.margin_set[k] = true;
            }
        };
        match name.as_str() {
            "margin" => {
                let vals: Vec<Option<f32>> = value.split_whitespace().map(length_px).collect();
                let [t, r, b, l] = match vals.as_slice() {
                    [a] => [*a, *a, *a, *a],
                    [a, b] => [*a, *b, *a, *b],
                    [a, b, c] => [*a, *b, *c, *b],
                    [a, b, c, d] => [*a, *b, *c, *d],
                    _ => [None; 4],
                };
                set(0, t);
                set(1, r);
                set(2, b);
                set(3, l);
            }
            "margin-top" => set(0, length_px(&value)),
            "margin-right" => set(1, length_px(&value)),
            "margin-bottom" => set(2, length_px(&value)),
            "margin-left" => set(3, length_px(&value)),
            "size" => out.declares_size = true,
            _ => {}
        }
    }
    out
}

/// A CSS length in px (`0`, `px`, `pt`, `pc`, `in`, `cm`, `mm`, `q`; `em`
/// and `rem` at the 16 px default; `auto` = 0). Percentages and anything
/// else: `None` (not applied).
fn length_px(v: &str) -> Option<f32> {
    let v = v.trim();
    if v == "0" || v == "auto" {
        return Some(0.0);
    }
    let split = v
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f32 = num.parse().ok()?;
    let per = match unit {
        "px" => 1.0,
        "pt" => 96.0 / 72.0,
        "pc" => 16.0,
        "in" => 96.0,
        "cm" => 96.0 / 2.54,
        "mm" => 96.0 / 25.4,
        "q" => 96.0 / 101.6,
        "em" | "rem" => 16.0,
        _ => return None,
    };
    Some(n * per)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn scans_break_properties_per_rule_in_source_order__feat__plugin_web_page_breaks() {
        let s = scan_stylesheet(
            "/* c { break-before: page } */ h2 { break-after: avoid; orphans: 3 }\n\
             @media print { p { break-before: page } }\n\
             .x, .y { page-break-before: always; break-inside: avoid-column !important }\n\
             p { widows: 0; color: red }",
        );
        assert_eq!(s.rules.len(), 2, "{:?}", s.rules);
        assert_eq!(s.rules[0].0, "h2");
        assert_eq!(s.rules[0].1.after, Some(Between::Avoid));
        assert_eq!(s.rules[0].1.orphans, Some(3));
        assert_eq!(s.rules[1].0, ".x, .y");
        assert_eq!(s.rules[1].1.before, Some(Between::Forced));
        assert_eq!(s.rules[1].1.inside, Some(Within::Avoid));
    }

    #[test]
    #[allow(non_snake_case)]
    fn scans_page_margins_and_size__feat__plugin_web_page_breaks() {
        let s = scan_stylesheet(
            "@page { size: A4; margin: 0.5in 10px; @top-center { margin: 99px } }\n\
             @page :first { margin-bottom: 12pt }",
        );
        assert!(s.page.declares_size);
        assert_eq!(s.page.margin_px[0], 48.0);
        assert_eq!(s.page.margin_px[1], 10.0);
        assert_eq!(s.page.margin_px[2], 16.0);
        assert_eq!(s.page.margin_px[3], 10.0);
        assert!(s.rules.is_empty());
    }

    #[test]
    #[allow(non_snake_case)]
    fn never_panics_on_broken_css__feat__plugin_web_page_breaks() {
        for css in [
            "{",
            "}",
            "a {",
            "@page {",
            "@media {{}",
            "a{b:}",
            ":;{}",
            "/*",
            "p{orphans:x}",
        ] {
            let _ = scan_stylesheet(css);
        }
    }
}
