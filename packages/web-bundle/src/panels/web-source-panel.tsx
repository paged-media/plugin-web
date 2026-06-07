// The webFrame source panel — HTML + CSS editors, a sandboxed live
// preview, frame options, and the diagnostics line (concept §8).
// W-04 RESOLVED: the editors are now the HOST code-editor widget
// (`host.widgets.CodeEditor` — line numbers, HTML/CSS highlighting, a
// diagnostics gutter), falling back to a plain textarea where the host
// injects no widget catalog (headless/older hosts). W-05 RESOLVED: the
// linter publishes through `host.diagnostics`, which the editor's
// Problems panel consumes.
//
// Built from host surfaces + React ONLY: the component is created by
// a factory that closes over the BundleHost, reads/writes through
// host.selection / host.document metadata / host.diagnostics, and styles
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

import type {
  BundleHost,
  CodeEditorDiagnostic,
  ElementId,
} from "@paged-media/plugin-api";
import {
  asFrameTarget,
  composeSrcdoc,
  DEFAULT_SOURCE,
  diagnoseFonts,
  diagnoseHtml,
  envelopeFor,
  fontParity,
  sourceFromEnvelope,
  sourceKeyFor,
  type WebDiagnostic,
  type WebFrameSource,
} from "@paged-media/web-model";

const SAVE_DEBOUNCE_MS = 300;

/** The `fonts` collection's row shape we read — family NAMES only.
 *  Structural twin of the wire `FontSummary` (not re-exported from
 *  plugin-api), supplied as the `collection<T>` type parameter so the
 *  bundle stays decoupled from the vendored wire types. The wire
 *  shape carries no face BYTES (and the only bytes-bearing message is
 *  the engine's host→worker `registerFont`), so the panel can read
 *  family parity but cannot serve `@font-face` sources — that is the
 *  W-06 asset-store dependency. */
interface FontSummaryLike {
  family: string;
}

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

const DOT: Record<WebDiagnostic["severity"], string> = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
};

// ----------------------------------------------------------- badge state

/** Pure derivation of the preview's font-substitution badge — split
 *  out so it's unit-testable without rendering. The iframe always
 *  renders with browser fonts (no face bytes cross a door — W-06), so
 *  the badge SHOWS whenever the source uses any (non-generic) family;
 *  its severity escalates to "review" when families are also absent
 *  from the document (those substitute on-canvas too, not just here). */
export interface PreviewFontBadge {
  /** Whether to render the badge at all. */
  show: boolean;
  /** Families used by the source but NOT registered by the document. */
  unregistered: string[];
  /** Families the document registers and the source uses (honest in
   *  the document, still substituted in THIS preview). */
  matched: string[];
  /** "review" when any used family is missing from the document,
   *  "info" when every used family resolves (preview-only caveat). */
  severity: "review" | "info";
}

export function previewFontBadge(
  css: string,
  registered: readonly string[],
): PreviewFontBadge {
  const { matched, unregistered } = fontParity(css, registered);
  const show = matched.length + unregistered.length > 0;
  return {
    show,
    matched,
    unregistered,
    severity: unregistered.length > 0 ? "review" : "info",
  };
}

// ----------------------------------------------------------------- panel

export function makeWebSourcePanel(host: BundleHost): () => ReactElement {
  return function WebSourcePanel(): ReactElement {
    const [selection, setSelection] = useState<ElementId[]>(() =>
      host.selection.get(),
    );
    const [source, setSource] = useState<WebFrameSource | null>(null);
    // The document's registered font FAMILIES (the `fonts` collection,
    // names only — no face bytes cross the door; W-06). Fed into
    // web-model for parity checks + the substitution badge. Loaded
    // once on mount and refreshed on document change.
    const [fontFamilies, setFontFamilies] = useState<string[]>([]);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const target =
      selection.length === 1 ? asFrameTarget(selection[0]) : null;
    const key = target ? sourceKeyFor(target) : null;

    // Selection → reload the source for the new target. The mount
    // effect RE-READS the snapshot: the panel may mount after a
    // selection event already passed (insert → select → open-panel),
    // and the lazy useState initial races the same React commit that
    // delivered the new selection through the host's live handle.
    useEffect(() => {
      setSelection(host.selection.get());
      const sub = host.selection.onDidChange((ids) => setSelection(ids));
      return () => sub.dispose();
    }, []);
    // Document font registry → the parity check + badge. The `fonts`
    // collection crosses family NAMES (FontSummary; no bytes). Refresh
    // on any document change: registering/removing a document font
    // changes which families resolve. Failures read as "no registry"
    // (empty) — never a crash; parity then emits nothing (absence of a
    // registry is not evidence a family is missing).
    useEffect(() => {
      let stale = false;
      const refresh = (): void => {
        void host.document
          .collection<FontSummaryLike>("fonts")
          .then((rows) => {
            if (stale) return;
            const fams = rows
              .map((r) => (typeof r.family === "string" ? r.family : ""))
              .filter((f) => f.length > 0);
            setFontFamilies(fams);
          })
          .catch(() => {
            if (!stale) setFontFamilies([]);
          });
      };
      refresh();
      const sub = host.document.onDidChange(() => refresh());
      return () => {
        stale = true;
        sub.dispose();
      };
    }, []);
    // The source lives as DOCUMENT METADATA (protocol v33). Reads are
    // async; a stale flag guards out-of-order replies on fast
    // selection changes. Pre-v33 documents migrate one-time from
    // plugin storage (write-through, then the storage entry drops).
    const loadFor = useCallback(
      async (id: ElementId, storageKey: string) => {
        let src = sourceFromEnvelope(await host.document.getMetadata(id));
        if (!src) {
          const legacy = host.storage.get<WebFrameSource>(storageKey);
          if (legacy) {
            src = legacy;
            const out = await host.document.setMetadata(
              id,
              envelopeFor(legacy),
            );
            if (out.applied) host.storage.delete(storageKey);
          }
        }
        return src;
      },
      [],
    );
    useEffect(() => {
      let stale = false;
      if (!target || !key) {
        setSource(null);
        return;
      }
      const id = selection[0];
      void loadFor(id, key).then((src) => {
        if (!stale) setSource(src);
      });
      return () => {
        stale = true;
      };
    }, [key]);
    // Undo/redo can revert the metadata under the panel — re-read on
    // those (NOT on mutationApplied: our own debounced saves would
    // loop the textarea through a redundant async set).
    useEffect(() => {
      if (!target || !key) return;
      const id = selection[0];
      const sub = host.document.onDidChange((e) => {
        if (e.kind === "undoApplied" || e.kind === "redoApplied") {
          void loadFor(id, key).then(setSource);
        }
      });
      return () => sub.dispose();
    }, [key, loadFor]);

    // The full diagnostic set: HTML policy/balance + CSS↔document font
    // parity (W1). Both lanes share the same WebDiagnostic shape so the
    // panel list, the Problems panel, and the gutter render them
    // uniformly. Pure web-model calls — registry passed as data.
    const diagnoseAll = useCallback(
      (src: WebFrameSource, families: string[]): WebDiagnostic[] => [
        ...diagnoseHtml(src.html),
        ...diagnoseFonts(src.css, families),
      ],
      [],
    );
    // The debounced save reads the LATEST registry through a ref (the
    // commit closure is keyed on `key`, not `fontFamilies`, so it must
    // not capture a stale list).
    const familiesRef = useRef<string[]>(fontFamilies);
    familiesRef.current = fontFamilies;

    // Edits → debounced persist (one undoable metadata mutation per
    // pause) + diagnostics.
    const commit = useCallback(
      (next: WebFrameSource) => {
        setSource(next);
        if (!key) return;
        const id = selection[0];
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          void host.document.setMetadata(id, envelopeFor(next));
          host.diagnostics.set(key, diagnoseAll(next, familiesRef.current));
        }, SAVE_DEBOUNCE_MS);
      },
      [key, diagnoseAll],
    );
    useEffect(
      () => () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
      },
      [],
    );
    // Re-publish to the host problems lane when the registry changes
    // under a stable source (a document font added/removed flips parity
    // without a source edit). Mirrors what `commit` publishes.
    useEffect(() => {
      if (!key || !source) return;
      host.diagnostics.set(key, diagnoseAll(source, fontFamilies));
    }, [fontFamilies, key, source, diagnoseAll]);

    const diagnostics = useMemo(
      () => (source ? diagnoseAll(source, fontFamilies) : []),
      [source, fontFamilies, diagnoseAll],
    );
    // Substitution badge state: the preview iframe renders with BROWSER
    // fonts (no `@font-face` bytes cross any door — W-06), so whenever
    // the source uses ANY family the preview is showing a substitute.
    // The badge says so honestly; `unregistered` are also missing from
    // the engine document (worse — text substitutes on-canvas too),
    // `matched` are honest in the document but still substituted HERE.
    const badge = useMemo(
      () => (source ? previewFontBadge(source.css, fontFamilies) : null),
      [source, fontFamilies],
    );
    // Per-line markers for the HTML editor's gutter (the linter only
    // diagnoses HTML today; line-less policy notes don't carry a
    // gutter position so they're filtered out here but still show in
    // the summary list + the Problems panel).
    const htmlGutter = useMemo<CodeEditorDiagnostic[]>(
      () =>
        diagnostics
          .filter((d): d is typeof d & { line: number } => d.line !== undefined)
          .map((d) => ({ severity: d.severity, message: d.message, line: d.line })),
      [diagnostics],
    );
    const CodeEditor = host.widgets.CodeEditor;
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
              void host.document.setMetadata(
                selection[0],
                envelopeFor(DEFAULT_SOURCE),
              );
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
        <div data-web-html>
          <CodeEditor
            language="html"
            value={source.html}
            onChange={(html) => commit({ ...source, html })}
            diagnostics={htmlGutter}
            minHeight={96}
            ariaLabel="Web frame HTML"
          />
        </div>
        <div style={kicker}>CSS</div>
        <div data-web-css>
          <CodeEditor
            language="css"
            value={source.css}
            onChange={(css) => commit({ ...source, css })}
            minHeight={72}
            ariaLabel="Web frame CSS"
          />
        </div>
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
        {/* Honesty badge (W1): the preview iframe renders with BROWSER
            fonts. No `@font-face` bytes cross any existing door (the
            `fonts` collection is name-only; serving face bytes is the
            W-06 asset store), so whenever the source uses a font the
            preview is SUBSTITUTING it. Badge it rather than let the
            source lane lie about typography. */}
        {badge?.show && (
          <div
            data-web-font-badge
            data-badge-severity={badge.severity}
            role="note"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--space-2, 8px)",
              margin: "0 0 var(--space-1, 4px)",
              padding: "4px 8px",
              font: "10px/1.5 var(--font-sans, sans-serif)",
              color: "var(--pg-fg)",
              background: "var(--pg-subtle, var(--pg-bg))",
              border: "1px solid var(--pg-border)",
              borderRadius: "var(--radius-sm, 4px)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                flex: "none",
                borderRadius: "var(--radius-full, 999px)",
                background:
                  badge.severity === "review"
                    ? "var(--status-review)"
                    : "var(--status-info)",
                transform: "translateY(1px)",
              }}
            />
            <span>
              Fonts substituted in preview — browser defaults, not the
              document faces.
              {badge.unregistered.length > 0
                ? ` ${badge.unregistered.length} not in document: ${badge.unregistered.join(", ")}.`
                : ""}
            </span>
          </div>
        )}
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
