// The webFrame source panel — HTML + CSS editors, a sandboxed live
// preview, frame options, and the diagnostics line (concept §8,
// reduced to what API v0.2 carries; the `codeEditor` host widget is
// W-04 on the breakage log, so the editors are token-styled
// textareas — honest, not fake-interactive).
//
// Built from host surfaces + React ONLY: the component is created by
// a factory that closes over the BundleHost, reads/writes through
// host.selection / host.storage / host.diagnostics, and styles
// itself with the design-system token layer (--pg-*, --status-*,
// --font-mono, --space-*, --radius-*) so it reads as native in both
// themes. No @paged-media/shell imports — selection reactivity comes
// from host.selection.onDidChange, not React context hooks.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  asFrameTarget,
  composeSrcdoc,
  DEFAULT_SOURCE,
  diagnoseHtml,
  sourceKeyFor,
  type WebDiagnostic,
  type WebFrameSource,
} from "@paged-media/web-model";

const SAVE_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------- styles
// Token-layer styling per the brand system: sentence case labels,
// UPPERCASE kicker labels with wide tracking, mono tabular code,
// hairline borders, no hardcoded hexes in chrome.

const kicker: CSSProperties = {
  font: "700 10px var(--font-sans, sans-serif)",
  letterSpacing: "var(--tracking-wide, 0.14em)",
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: "var(--space-3, 12px) 0 var(--space-1, 4px)",
};

const codeArea: CSSProperties = {
  width: "100%",
  minHeight: 96,
  resize: "vertical",
  font: "12px/1.5 var(--font-mono, monospace)",
  fontVariantNumeric: "tabular-nums",
  color: "var(--pg-fg)",
  background: "var(--pg-bg)",
  border: "1px solid var(--pg-border)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 8px)",
  boxSizing: "border-box",
};

const DOT: Record<WebDiagnostic["severity"], string> = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
};

// ----------------------------------------------------------------- panel

export function makeWebSourcePanel(host: BundleHost): () => ReactElement {
  return function WebSourcePanel(): ReactElement {
    const [selection, setSelection] = useState<ElementId[]>(() =>
      host.selection.get(),
    );
    const [source, setSource] = useState<WebFrameSource | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const target =
      selection.length === 1 ? asFrameTarget(selection[0]) : null;
    const key = target ? sourceKeyFor(target) : null;

    // Selection → reload the stored source for the new target. The
    // mount effect RE-READS the snapshot: the panel may mount after a
    // selection event already passed (insert → select → open-panel),
    // and the lazy useState initial races the same React commit that
    // delivered the new selection through the host's live handle.
    useEffect(() => {
      setSelection(host.selection.get());
      const sub = host.selection.onDidChange((ids) => setSelection(ids));
      return () => sub.dispose();
    }, []);
    useEffect(() => {
      setSource(key ? (host.storage.get<WebFrameSource>(key) ?? null) : null);
    }, [key]);

    // Edits → debounced persist + diagnostics.
    const commit = useCallback(
      (next: WebFrameSource) => {
        setSource(next);
        if (!key) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          host.storage.set(key, next);
          host.diagnostics.set(key, diagnoseHtml(next.html));
        }, SAVE_DEBOUNCE_MS);
      },
      [key],
    );
    useEffect(
      () => () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
      },
      [],
    );

    const diagnostics = useMemo(
      () => (source ? diagnoseHtml(source.html) : []),
      [source],
    );
    const srcdoc = useMemo(
      () => (source ? composeSrcdoc(source) : ""),
      [source],
    );

    // ---------------------------------------------------- empty states
    if (!target) {
      return (
        <div data-web-panel="empty" style={{ padding: "var(--space-3, 12px)", color: "var(--pg-muted-fg)", font: "12px var(--font-sans, sans-serif)" }}>
          Select a single frame to edit it as a web frame, or insert one via
          the “Insert web frame” command.
        </div>
      );
    }
    if (!source) {
      return (
        <div data-web-panel="convert" style={{ padding: "var(--space-3, 12px)", font: "12px var(--font-sans, sans-serif)" }}>
          <p style={{ margin: "0 0 var(--space-2, 8px)", color: "var(--pg-muted-fg)" }}>
            The selected {target.kind} is not a web frame yet.
          </p>
          <button
            type="button"
            data-web-make
            onClick={() => {
              host.storage.set(key!, DEFAULT_SOURCE);
              setSource(DEFAULT_SOURCE);
            }}
            style={{
              font: "500 12px var(--font-sans, sans-serif)",
              color: "var(--primary-fg, #fff)",
              background: "var(--pg-primary)",
              border: "none",
              borderRadius: "var(--radius-md, 6px)",
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            Make web frame
          </button>
        </div>
      );
    }

    // ------------------------------------------------------- the editor
    return (
      <div data-web-panel="source" style={{ padding: "var(--space-3, 12px)", display: "flex", flexDirection: "column" }}>
        <div style={{ ...kicker, marginTop: 0 }}>HTML</div>
        <textarea
          data-web-html
          spellCheck={false}
          value={source.html}
          onChange={(e) => commit({ ...source, html: e.target.value })}
          style={codeArea}
        />
        <div style={kicker}>CSS</div>
        <textarea
          data-web-css
          spellCheck={false}
          value={source.css}
          onChange={(e) => commit({ ...source, css: e.target.value })}
          style={{ ...codeArea, minHeight: 72 }}
        />
        <div style={kicker}>Options</div>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 8px)", font: "12px var(--font-sans, sans-serif)", color: "var(--pg-fg)" }}>
          Media
          <select
            data-web-media
            value={source.options.media}
            onChange={(e) =>
              commit({
                ...source,
                options: {
                  ...source.options,
                  media: e.target.value as "print" | "screen",
                },
              })
            }
            style={{
              font: "12px var(--font-sans, sans-serif)",
              color: "var(--pg-fg)",
              background: "var(--pg-bg)",
              border: "1px solid var(--pg-border)",
              borderRadius: "var(--radius-sm, 4px)",
              padding: "2px 6px",
            }}
          >
            <option value="print">print</option>
            <option value="screen">screen</option>
          </select>
        </label>
        <div style={kicker}>Preview</div>
        {/* sandbox="" — no scripts, no same-origin: §6.1, page JS never
            runs. Paper-white ground: the preview shows CONTENT, and
            content colours stay literal by design. */}
        <iframe
          data-web-preview
          title="Web frame preview"
          sandbox=""
          srcDoc={srcdoc}
          style={{
            width: "100%",
            height: 180,
            background: "#ffffff",
            border: "1px solid var(--pg-border)",
            borderRadius: "var(--radius-sm, 4px)",
          }}
        />
        {/* On-canvas rendering awaits the engine lane (Blitz/WASM, W0
            spike) — saying so beats pretending. */}
        <p style={{ margin: "var(--space-1, 4px) 0 0", font: "10px var(--font-sans, sans-serif)", color: "var(--pg-muted-fg)" }}>
          Panel preview only — on-canvas vector rendering ships with the
          engine lane.
        </p>
        {diagnostics.length > 0 && (
          <>
            <div style={kicker}>Diagnostics</div>
            <ul data-web-diagnostics style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {diagnostics.map((d, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "var(--space-2, 8px)",
                    font: "11px/1.6 var(--font-mono, monospace)",
                    color: "var(--pg-fg)",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "var(--radius-full, 999px)",
                      background: DOT[d.severity],
                      flex: "none",
                      transform: "translateY(-1px)",
                    }}
                  />
                  <span>
                    {d.line !== undefined ? `${d.line}: ` : ""}
                    {d.message}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  };
}
