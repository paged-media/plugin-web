// The webFrame source panel — HTML + CSS editors, a sandboxed live
// preview, frame options, and the diagnostics line (concept §8).
//
// W-04 (Phase 2c): the editors are the HOST code-editor widget when
// `host.supports("widgets.codeEditor@1")` answers true (line numbers,
// HTML/CSS highlighting, a diagnostics gutter), and the bundle's OWN
// plain textarea when it answers false (headless/conformance/older
// hosts) — `resolveEditorLane` is the explicit, testable branch and
// `data-web-editor-lane` says which lane rendered. W-05: the linter
// publishes through `host.diagnostics`, which the editor's Problems
// panel consumes.
//
// Preview vs. persistence (Phase 2c task 2 — two separate lanes):
//   · KEYSTROKES feed the sandboxed preview + the diagnostics LIVE,
//     behind a ~300 ms trailing debounce (`PREVIEW_DEBOUNCE_MS`) —
//     no document write happens while typing;
//   · the explicit "Save to document" action is the panel's ONLY
//     document write: ONE undoable metadata mutation per commit
//     (`persistDraft`), never conflated with a preview refresh.
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
  composeFontFaces,
  composeSrcdoc,
  DEFAULT_SOURCE,
  diagnoseFonts,
  diagnoseHtml,
  envelopeFor,
  fontParity,
  MAX_VIEWPORT_WIDTH,
  normalizeViewportWidth,
  sourceFromEnvelope,
  sourceKeyFor,
  type ResolvedFontFace,
  type WebDiagnostic,
  type WebFrameSource,
} from "@paged-media/web-model";

import { createDebouncer } from "./debounce";
import { resolveEditorLane, type EditorLane } from "./editor-lane";

/** Trailing-edge debounce between a keystroke and the preview/lint
 *  refresh. Document writes do NOT ride this timer — see `persistDraft`. */
export const PREVIEW_DEBOUNCE_MS = 300;

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

const field: CSSProperties = {
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg)",
  background: "var(--pg-bg)",
  border: "1px solid var(--pg-border)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "2px 6px",
};

const optionRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2, 8px)",
  font: "12px var(--font-sans, sans-serif)",
  color: "var(--pg-fg)",
  margin: "0 0 var(--space-1, 4px)",
};

const mutedNote: CSSProperties = {
  font: "10px var(--font-sans, sans-serif)",
  color: "var(--pg-muted-fg)",
};

const DOT: Record<WebDiagnostic["severity"], string> = {
  error: "var(--status-error)",
  warning: "var(--status-review)",
  info: "var(--status-info)",
};

// ----------------------------------------------------------- badge state

/** Pure derivation of the preview's font-substitution badge — split
 *  out so it's unit-testable without rendering.
 *
 *  W-06 flip: when the host asset store serves a used family's BYTES,
 *  the panel composes a real `@font-face` and the badge flips for that
 *  family. `shown` carries the matched families whose bytes were
 *  resolved and injected; those are removed from the substitution
 *  story. The badge then has three states:
 *    · hidden       — no (non-generic) family is used;
 *    · "shown"      — every used+registered family was served (no
 *                     substitution among document fonts; the badge
 *                     CONFIRMS the document faces are shown — `state`
 *                     `"shown"`, severity `info`);
 *    · substituting — some used family is still substituted (a matched
 *                     family the host had no bytes for, or an
 *                     unregistered family that has no bytes by
 *                     definition). */
export interface PreviewFontBadge {
  /** Whether to render the badge at all. */
  show: boolean;
  /** `"shown"` when every used+registered family was resolved to real
   *  bytes (the W3.12 flip — "document fonts shown"); `"substituting"`
   *  when at least one used family is still a browser substitute. */
  state: "shown" | "substituting";
  /** Families used by the source but NOT registered by the document. */
  unregistered: string[];
  /** Families the document registers and the source uses. */
  matched: string[];
  /** The subset of `matched` whose BYTES the host asset store served
   *  and the panel composed into a real `@font-face` (now SHOWN). */
  shown: string[];
  /** "review" when any used family is missing from the document,
   *  "info" otherwise (a preview-only caveat, or the all-shown flip). */
  severity: "review" | "info";
}

export function previewFontBadge(
  css: string,
  registered: readonly string[],
  shown: readonly string[] = [],
): PreviewFontBadge {
  const { matched, unregistered } = fontParity(css, registered);
  const usedCount = matched.length + unregistered.length;
  const show = usedCount > 0;
  // A matched family is "shown" only if its bytes were served.
  const shownLower = new Set(shown.map((f) => f.trim().toLowerCase()));
  const shownMatched = matched.filter((f) =>
    shownLower.has(f.trim().toLowerCase()),
  );
  // Still substituting if any unregistered family is used, OR any
  // matched family was NOT served bytes.
  const stillSubstituting =
    unregistered.length > 0 || shownMatched.length < matched.length;
  return {
    show,
    state: stillSubstituting ? "substituting" : "shown",
    matched,
    unregistered,
    shown: shownMatched,
    severity: unregistered.length > 0 ? "review" : "info",
  };
}

// ------------------------------------------------------------ persistence

/** Persist a draft as the element's source metadata — the panel's ONLY
 *  document write, fired by the explicit "Save to document" action
 *  (never by the preview debounce). One call = one undoable metadata
 *  mutation. Returns whether the engine applied it. */
export async function persistDraft(
  host: Pick<BundleHost, "document">,
  id: ElementId,
  draft: WebFrameSource,
): Promise<boolean> {
  const outcome = await host.document.setMetadata(id, envelopeFor(draft));
  return outcome.applied;
}

// ---------------------------------------------------------------- hooks

/** The debounced shadow of a value: re-emits `value` `ms` after the
 *  LAST change (trailing edge, via `createDebouncer` — the unit the
 *  fake-timer spec covers). The first render emits immediately. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const debouncer = useMemo(() => createDebouncer(ms), [ms]);
  useEffect(() => {
    debouncer.schedule(() => setDebounced(value));
  }, [value, debouncer]);
  useEffect(() => () => debouncer.cancel(), [debouncer]);
  return debounced;
}

// ----------------------------------------------------------------- panel

export function makeWebSourcePanel(host: BundleHost): () => ReactElement {
  // The lane is stable for the host's lifetime — probe once.
  const lane = resolveEditorLane(host);
  return function WebSourcePanel(): ReactElement {
    const [selection, setSelection] = useState<ElementId[]>(() =>
      host.selection.get(),
    );
    // The PERSISTED source for the selected target (document metadata
    // truth). The editing draft lives in <SourceEditor>, which remounts
    // per target + per undo/redo revert (the `generation` key).
    const [source, setSource] = useState<WebFrameSource | null>(null);
    const [generation, setGeneration] = useState(0);
    // The document's registered font FAMILIES (the `fonts` collection,
    // names only — no face bytes cross the door; W-06). Fed into
    // web-model for parity checks + the substitution badge. Loaded
    // once on mount and refreshed on document change.
    const [fontFamilies, setFontFamilies] = useState<string[]>([]);
    const sourceRef = useRef<WebFrameSource | null>(source);
    sourceRef.current = source;

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
      // Drop the PREVIOUS target's source synchronously so the editor
      // never renders old content under the new key while the read is
      // in flight.
      setSource(null);
      if (!target || !key) return;
      const id = selection[0];
      void loadFor(id, key).then((src) => {
        if (!stale) setSource(src);
      });
      return () => {
        stale = true;
      };
    }, [key]);
    // Undo/redo can revert the metadata under the panel — re-read on
    // those (NOT on mutationApplied: the panel's own explicit saves
    // must not bounce the editor through a redundant async re-read).
    // An UNRELATED undo leaves the source identical: keep the user's
    // uncommitted draft then; only a real revert bumps `generation`
    // (remounting the editor onto the reverted source).
    useEffect(() => {
      if (!target || !key) return;
      const id = selection[0];
      const sub = host.document.onDidChange((e) => {
        if (e.kind === "undoApplied" || e.kind === "redoApplied") {
          void loadFor(id, key).then((src) => {
            if (JSON.stringify(sourceRef.current) === JSON.stringify(src))
              return;
            setSource(src);
            setGeneration((g) => g + 1);
          });
        }
      });
      return () => sub.dispose();
    }, [key, loadFor]);

    // ---------------------------------------------------- empty states
    if (!target || !key) {
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

    return (
      <SourceEditor
        // Remount per target AND per undo/redo revert: a fresh draft
        // + an immediate (un-debounced) first preview every time the
        // persisted truth changes under the panel.
        key={`${generation}:${key}`}
        host={host}
        lane={lane}
        id={selection[0]}
        sourceKey={key}
        initial={source}
        fontFamilies={fontFamilies}
        onPersisted={setSource}
      />
    );
  };
}

// ---------------------------------------------------------- the editor

interface SourceEditorProps {
  host: BundleHost;
  lane: EditorLane;
  id: ElementId;
  sourceKey: string;
  /** The persisted source this editor session starts from. */
  initial: WebFrameSource;
  fontFamilies: string[];
  /** Reports a successful save so the owner's persisted state tracks. */
  onPersisted(next: WebFrameSource): void;
}

function SourceEditor({
  host,
  lane,
  id,
  sourceKey,
  initial,
  fontFamilies,
  onPersisted,
}: SourceEditorProps): ReactElement {
  // The DRAFT is what the editors bind — it never touches the document
  // by itself. `persisted` mirrors the last successful save for the
  // dirty flag; `preview` is the draft's debounced shadow and drives
  // the iframe + diagnostics (task 2: preview refresh ≠ document write).
  const [draft, setDraft] = useState<WebFrameSource>(initial);
  const [persisted, setPersisted] = useState<WebFrameSource>(initial);
  const preview = useDebouncedValue(draft, PREVIEW_DEBOUNCE_MS);
  // W-06 — document faces the host asset store served BYTES for and we
  // composed into real `@font-face` rules (object URLs). The preview
  // shows these as the DOCUMENT's actual faces; the badge flips for
  // them. `shownFamilies` are the matched families now shown. Object
  // URLs are revoked on change/unmount (see the resolution effect).
  const [resolvedFaces, setResolvedFaces] = useState<ResolvedFontFace[]>([]);
  const [shownFamilies, setShownFamilies] = useState<string[]>([]);

  // W-06 — resolve the BYTES of the document faces the source uses,
  // through the capability-gated asset store, and compose real
  // `@font-face` (object URLs) so the sandboxed preview shows the
  // DOCUMENT's actual faces. Only families that are BOTH used by the
  // source AND registered by the document are worth asking for (an
  // unregistered family has no document bytes by definition). When the
  // host injects no asset source, every read is `null` and the badge
  // stays in its honest substitution state (W1). The `@font-face` CSS
  // lands in the srcdoc <style> — NO script, so `sandbox=""` is
  // unchanged. Keyed on the DEBOUNCED css (no byte reads per keystroke);
  // revokes prior object URLs on every change + unmount.
  const cssForFonts = preview.css;
  useEffect(() => {
    let stale = false;
    const created: string[] = [];
    // Nothing to resolve without a real byte source — keep the honest
    // substitution path (and avoid creating object URLs we'd revoke).
    if (!host.supports("assets.fonts@1")) {
      setResolvedFaces([]);
      setShownFamilies([]);
      return;
    }
    const { matched } = fontParity(cssForFonts, fontFamilies);
    if (matched.length === 0) {
      setResolvedFaces([]);
      setShownFamilies([]);
      return;
    }
    void (async () => {
      const faces: ResolvedFontFace[] = [];
      const shown: string[] = [];
      for (const family of matched) {
        try {
          const asset = await host.assets.getFontFace(family);
          if (!asset || asset.bytes.byteLength === 0) continue;
          // Copy into a fresh non-shared ArrayBuffer so the Blob part
          // is a plain `ArrayBuffer` (the served bytes may be backed by
          // a SharedArrayBuffer; `Blob` rejects SAB-backed views).
          const copy = new Uint8Array(asset.bytes.byteLength);
          copy.set(asset.bytes);
          const blob = new Blob([copy.buffer], {
            type: "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          created.push(url);
          faces.push({ family, src: url, format: asset.format });
          shown.push(family);
        } catch {
          // A failing read is just "no bytes" — substitute + badge.
        }
      }
      if (stale) {
        // Effect re-ran/unmounted before we committed — drop the URLs.
        for (const u of created) URL.revokeObjectURL(u);
        return;
      }
      setResolvedFaces(faces);
      setShownFamilies(shown);
    })();
    return () => {
      stale = true;
      for (const u of created) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssForFonts, fontFamilies.join(" ")]);

  // The full diagnostic set: HTML policy/balance + CSS↔document font
  // parity (W1). Both lanes share the same WebDiagnostic shape so the
  // panel list, the Problems panel, and the gutter render them
  // uniformly. Pure web-model calls over the DEBOUNCED draft — the
  // lint lane rides the same ~300 ms cadence as the preview. W-06: a
  // family whose bytes were SHOWN drops its "not previewable" info
  // (it IS previewable now).
  const diagnostics = useMemo<WebDiagnostic[]>(
    () => [
      ...diagnoseHtml(preview.html),
      ...diagnoseFonts(preview.css, fontFamilies, shownFamilies),
    ],
    [preview, fontFamilies, shownFamilies],
  );
  // Publish to the host problems lane on the same debounced cadence —
  // linting is analysis, not a document write, so it stays LIVE while
  // typing (unlike persistence, which waits for the explicit save).
  useEffect(() => {
    host.diagnostics.set(sourceKey, diagnostics);
  }, [diagnostics, sourceKey]);

  // Font badge state (W-06 flip): for families whose BYTES the host
  // asset store served, the preview now shows the DOCUMENT's actual
  // faces (composed `@font-face`), so the badge flips to "document
  // fonts shown" once EVERY used+registered family is shown. Until
  // then it stays the honest substitution badge (W1): `unregistered`
  // families are missing from the engine document (substitute
  // on-canvas too), and a matched family the host had no bytes for is
  // still a browser substitute HERE.
  const badge = useMemo(
    () => previewFontBadge(preview.css, fontFamilies, shownFamilies),
    [preview, fontFamilies, shownFamilies],
  );
  // Per-line markers for the HTML editor's gutter (the linter only
  // diagnoses HTML today; line-less policy notes don't carry a
  // gutter position so they're filtered out here but still show in
  // the summary list + the Problems panel). Rendered only by the
  // widget lane — the textarea fallback has no gutter and says so.
  const htmlGutter = useMemo<CodeEditorDiagnostic[]>(
    () =>
      diagnostics
        .filter((d): d is typeof d & { line: number } => d.line !== undefined)
        .map((d) => ({ severity: d.severity, message: d.message, line: d.line })),
    [diagnostics],
  );
  // W-06: the served document faces become a real `@font-face` prelude
  // inside the srcdoc <style> (plain CSS + object-URL src, NO script —
  // sandbox="" unchanged). The preview then uses the document's actual
  // faces for every resolved family.
  const fontFaceCss = useMemo(
    () => composeFontFaces(resolvedFaces),
    [resolvedFaces],
  );
  const srcdoc = useMemo(
    () => composeSrcdoc(preview, fontFaceCss),
    [preview, fontFaceCss],
  );

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(persisted),
    [draft, persisted],
  );
  const commit = useCallback(() => {
    const next = draft;
    void persistDraft(host, id, next).then((applied) => {
      if (!applied) return;
      setPersisted(next);
      onPersisted(next);
    });
  }, [draft, id, onPersisted]);

  const CodeEditor = lane.CodeEditor;
  // The honest viewport: the preview IFRAME takes the declared width,
  // and an iframe's element size IS the CSS viewport its content lays
  // out (and media-queries) against. Applied from the DEBOUNCED draft
  // so the whole preview moves on one cadence.
  const viewportWidth = preview.options.viewportWidth;

  return (
    <div
      data-web-panel="source"
      data-web-editor-lane={lane.native ? "widget" : "textarea"}
      style={{ padding: "var(--space-3, 12px)", display: "flex", flexDirection: "column" }}
    >
      <div style={{ ...kicker, marginTop: 0 }}>HTML</div>
      <div data-web-html>
        <CodeEditor
          language="html"
          value={draft.html}
          onChange={(html) => setDraft({ ...draft, html })}
          diagnostics={htmlGutter}
          minHeight={96}
          ariaLabel="Web frame HTML"
        />
      </div>
      <div style={kicker}>CSS</div>
      <div data-web-css>
        <CodeEditor
          language="css"
          value={draft.css}
          onChange={(css) => setDraft({ ...draft, css })}
          minHeight={72}
          ariaLabel="Web frame CSS"
        />
      </div>
      <div style={kicker}>Options</div>
      <label style={optionRow}>
        Media
        <select
          data-web-media
          value={draft.options.media}
          onChange={(e) =>
            setDraft({
              ...draft,
              options: {
                ...draft.options,
                media: e.target.value as "print" | "screen",
              },
            })
          }
          style={field}
        >
          <option value="print">print</option>
          <option value="screen">screen</option>
        </select>
      </label>
      <label style={optionRow}>
        Viewport width
        <input
          data-web-viewport
          type="number"
          min={1}
          max={MAX_VIEWPORT_WIDTH}
          placeholder="auto"
          value={draft.options.viewportWidth ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            const next = { ...draft.options };
            const w =
              raw === ""
                ? undefined
                : normalizeViewportWidth(Number(raw));
            if (w === undefined) delete next.viewportWidth;
            else next.viewportWidth = w;
            setDraft({ ...draft, options: next });
          }}
          style={{ ...field, width: 72 }}
        />
        <span style={mutedNote}>px — empty = panel width</span>
      </label>
      <label style={optionRow}>
        Overflow
        {/* Declared but FIXED: "clip" is the only honest policy before
            the engine renders web frames on canvas (W0). A disabled
            single-option control is the visible seam — never a fake
            choice. */}
        <select data-web-overflow value="clip" disabled style={{ ...field, opacity: 0.6 }}>
          <option value="clip">clip</option>
        </select>
        <span style={mutedNote}>
          other policies ship with the engine rendering lane
        </span>
      </label>
      {/* Persistence is EXPLICIT: one undoable metadata mutation per
          save, never a side effect of typing (the preview above the
          fold refreshes live; the document does not). */}
      <div
        data-web-commit-row
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2, 8px)",
          margin: "var(--space-2, 8px) 0 0",
        }}
      >
        <button
          type="button"
          data-web-commit
          disabled={!dirty}
          onClick={commit}
          style={{
            font: "500 12px var(--font-sans, sans-serif)",
            color: "var(--primary-fg, #fff)",
            background: "var(--pg-primary)",
            border: "none",
            borderRadius: "var(--radius-md, 6px)",
            padding: "4px 12px",
            cursor: dirty ? "pointer" : "default",
            opacity: dirty ? 1 : 0.5,
          }}
        >
          Save to document
        </button>
        <span data-web-dirty={dirty ? "true" : "false"} style={mutedNote}>
          {dirty
            ? "Unsaved edits — live in the preview only"
            : "Saved to the document"}
        </span>
      </div>
      <div style={kicker}>Preview</div>
      {/* Font badge: W1 honesty + the W-06 flip. When the asset store
          serves a used family's BYTES, the panel composes a real
          `@font-face` (object URL) into the srcdoc and the badge flips
          to "document fonts shown" for those families. While any used
          family is still a browser substitute (no bytes served, or a
          family missing from the document) the honest substitution
          badge stays. `data-badge-state` exposes which for tests. */}
      {badge.show && (
        <div
          data-web-font-badge
          data-badge-severity={badge.severity}
          data-badge-state={badge.state}
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
                  : badge.state === "shown"
                    ? "var(--status-ok, var(--status-info))"
                    : "var(--status-info)",
              transform: "translateY(1px)",
            }}
          />
          {badge.state === "shown" ? (
            <span>
              Document fonts shown — the preview uses the document’s
              actual faces
              {badge.shown.length > 0 ? `: ${badge.shown.join(", ")}.` : "."}
            </span>
          ) : (
            <span>
              Fonts substituted in preview — browser defaults, not the
              document faces.
              {badge.shown.length > 0
                ? ` Shown from document: ${badge.shown.join(", ")}.`
                : ""}
              {badge.unregistered.length > 0
                ? ` ${badge.unregistered.length} not in document: ${badge.unregistered.join(", ")}.`
                : ""}
            </span>
          )}
        </div>
      )}
      {/* sandbox="" — no scripts, no same-origin: §6.1, page JS never
          runs. Paper-white ground: the preview shows CONTENT, and
          content colours stay literal by design. The stage scrolls
          horizontally when a declared viewport is wider than the
          panel. */}
      <div
        data-web-preview-stage
        style={{ overflowX: viewportWidth ? "auto" : "visible" }}
      >
        <iframe
          data-web-preview
          title="Web frame preview"
          sandbox=""
          srcDoc={srcdoc}
          style={{
            width: viewportWidth ? `${viewportWidth}px` : "100%",
            height: 180,
            background: "#ffffff",
            border: "1px solid var(--pg-border)",
            borderRadius: "var(--radius-sm, 4px)",
          }}
        />
      </div>
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
}
