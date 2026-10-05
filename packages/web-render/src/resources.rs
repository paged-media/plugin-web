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

//! Sub-resources for a render (feature = "blitz"): images (`<img src>`, CSS
//! `background-image`), stylesheets (`<link rel=stylesheet>`, `@import`) and
//! `@font-face` sources.
//!
//! The engine never touches the network. A source's relative URLs resolve
//! against [`BASE_URL`]; the host resolves each one (a container part, an
//! asset-store entry) and hands its bytes to [`register_resource`] under the
//! URL the source wrote (relative to the base). A render's documents get a
//! [`ResourceProvider`] that answers Blitz's fetches SYNCHRONOUSLY from those
//! bytes, decodes `data:` URIs itself, and records every other URL as a
//! miss ([`take_resource_misses`]) so the host can say which resource did not
//! load. A response arriving during a resolve (a CSS background is fetched
//! while styles resolve) is applied by one more resolve ([`resolve`]).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};

use crate::perf::{self, Counter};

/// The base every relative URL in a source resolves against. A resolved URL
/// under it maps back to the key the host registered (`images/a.png`). The
/// `.invalid` host can never reach a network.
pub const BASE_URL: &str = "https://source.paged.invalid/";

/// The most extra resolves [`resolve`] spends applying late responses (an
/// image referenced by a stylesheet that itself arrived late).
const MAX_SETTLE_RESOLVES: u32 = 3;

thread_local! {
    /// The registered resources, keyed by their base-relative path. Shared
    /// into each document's provider by `Arc` (no copy per render).
    static RESOURCES: RefCell<Arc<HashMap<String, Bytes>>> = RefCell::new(Arc::new(HashMap::new()));
    /// The provider of the document built last on this thread — what
    /// [`resolve`] and [`take_resource_misses`] read.
    static CURRENT: RefCell<Option<Arc<ResourceProvider>>> = const { RefCell::new(None) };
}

/// Register `bytes` under `url`: a path relative to the source (`images/a.png`,
/// `./css/site.css`) or an absolute URL under [`BASE_URL`]. Later renders
/// load it. Registering a URL again replaces its bytes.
pub fn register_resource(url: &str, bytes: &[u8]) {
    let key = key_of(url);
    RESOURCES.with(|r| {
        Arc::make_mut(&mut r.borrow_mut()).insert(key, Bytes::copy_from_slice(bytes));
    });
}

/// Whether a resource is registered under `url` (so the host sends bytes once).
pub fn has_resource(url: &str) -> bool {
    let key = key_of(url);
    RESOURCES.with(|r| r.borrow().contains_key(&key))
}

/// Forget every registered resource.
pub fn clear_resources() {
    RESOURCES.with(|r| *r.borrow_mut() = Arc::new(HashMap::new()));
}

/// The registry key of a URL: the path under the base, without a leading
/// `./` or `/`, percent-decoded, query and fragment dropped. A URL outside
/// the base keys as itself (minus query and fragment), so only a host that
/// registered that exact URL can answer it.
fn key_of(url: &str) -> String {
    let Some(rest) = url.strip_prefix(BASE_URL).or_else(|| {
        // A relative URL (no scheme) is source-relative.
        (!url.contains(':')).then_some(url)
    }) else {
        return url.split(['?', '#']).next().unwrap_or("").to_string();
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let rest = rest.trim_start_matches("./").trim_start_matches('/');
    percent_decode(rest)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// The body of a `data:` URL (`data:[<mime>][;base64],<data>`), or `None`
/// when it is malformed.
pub fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if meta.split(';').any(|p| p.eq_ignore_ascii_case("base64")) {
        base64_decode(data)
    } else {
        Some(percent_decode(data).into_bytes())
    }
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Answers a document's fetches from the registered resources and `data:`
/// URIs; anything else is a miss.
pub struct ResourceProvider {
    resources: Arc<HashMap<String, Bytes>>,
    served: AtomicU64,
    misses: Mutex<Vec<String>>,
}

impl ResourceProvider {
    fn served(&self) -> u64 {
        self.served.load(Ordering::SeqCst)
    }
}

impl NetProvider for ResourceProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.as_str().to_string();
        let bytes = if url.starts_with("data:") {
            decode_data_url(&url).map(Bytes::from)
        } else {
            // Under the base: the source-relative key. Anything else only
            // when the host registered that exact URL (an asset-store entry
            // such as `paged-image:<element id>`) — never a network fetch.
            self.resources.get(&key_of(&url)).cloned()
        };
        match bytes {
            Some(b) => {
                self.served.fetch_add(1, Ordering::SeqCst);
                handler.bytes(url, b);
            }
            None => {
                let shown = if url.starts_with("data:") {
                    "a malformed data: URL".to_string()
                } else {
                    url.strip_prefix(BASE_URL).unwrap_or(&url).to_string()
                };
                if let Ok(mut m) = self.misses.lock() {
                    if !m.contains(&shown) {
                        m.push(shown);
                    }
                }
            }
        }
    }
}

/// The configuration every render's document is built with: the engine's
/// font context, the source base URL, and a provider over the registered
/// resources (which [`resolve`] and [`take_resource_misses`] then read).
pub fn document_config() -> DocumentConfig {
    let provider = Arc::new(ResourceProvider {
        resources: RESOURCES.with(|r| r.borrow().clone()),
        served: AtomicU64::new(0),
        misses: Mutex::new(Vec::new()),
    });
    CURRENT.with(|c| *c.borrow_mut() = Some(provider.clone()));
    DocumentConfig {
        font_ctx: Some(crate::fonts::font_ctx()),
        base_url: Some(BASE_URL.to_string()),
        net_provider: Some(provider),
        ..Default::default()
    }
}

/// Resolve a document built from [`document_config`], applying its
/// sub-resources. The provider answers synchronously, so a response is queued
/// the moment it is fetched: the ones fetched while the HTML was parsed
/// (`<img>`, `<link>`, an inline `@font-face`) are applied by the first
/// resolve; the ones fetched DURING a resolve (a CSS background, a linked
/// stylesheet's `@font-face`) need one more. A document that loads nothing
/// resolves exactly once.
pub fn resolve(doc: &mut BaseDocument) {
    let provider = CURRENT.with(|c| c.borrow().clone());
    let served = || provider.as_ref().map_or(0, |p| p.served());
    let mut applied = served();
    doc.resolve(0.0);
    perf::bump(Counter::Resolves, 1);
    let mut extra = 0;
    while served() > applied && extra < MAX_SETTLE_RESOLVES {
        applied = served();
        doc.resolve(0.0);
        perf::bump(Counter::Resolves, 1);
        extra += 1;
    }
    perf::bump(Counter::ResourceFetches, served());
}

/// The URLs the last-built document asked for that resolved to nothing (not
/// registered, not a `data:` URL, or outside the source), in request order.
pub fn take_resource_misses() -> Vec<String> {
    CURRENT.with(|c| {
        c.borrow()
            .as_ref()
            .and_then(|p| p.misses.lock().ok().map(|mut m| std::mem::take(&mut *m)))
            .unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_normalise_relative_and_absolute_urls() {
        assert_eq!(key_of("images/a.png"), "images/a.png");
        assert_eq!(key_of("./images/a.png"), "images/a.png");
        assert_eq!(key_of("/images/a.png"), "images/a.png");
        assert_eq!(
            key_of("https://source.paged.invalid/images/a%20b.png?x=1#f"),
            "images/a b.png"
        );
    }

    #[test]
    fn data_urls_decode_base64_and_percent_forms() {
        assert_eq!(
            decode_data_url("data:text/plain;base64,aGk=").unwrap(),
            b"hi"
        );
        assert_eq!(decode_data_url("data:text/css,a%7Bb%7D").unwrap(), b"a{b}");
        assert!(decode_data_url("data:nocomma").is_none());
    }

    #[test]
    fn a_url_outside_the_base_keys_as_itself() {
        assert_eq!(key_of("paged-image:u1a?x"), "paged-image:u1a");
        assert_eq!(
            key_of("https://example.com/a.png"),
            "https://example.com/a.png"
        );
    }
}
