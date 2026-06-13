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
  renderWebFrameSource,
  sourceFromEnvelope,
  sourceFromTemplate,
  sourceKeyFor,
  tagOutline,
  TEMPLATE_FILTERS,
  templateById,
  WEB_TEMPLATES,
  type ResolvedFontFace,
  type TagOutlineEntry,
  type WebDiagnostic,
  type WebFrameSource,
} from "@paged-media/web-model";

import { createDebouncer } from "./debounce";
import {
  FallbackCodeEditor,
  resolveEditorLane,
  type EditorLane,
} from "./editor-lane";
import { resolvePreviewFontFaces } from "./font-resolution";
import {
  clipboardAvailable,
  describeRemoval,
  ingestFromClipboard,
  ingestHtml,
} from "./ingest";
import { selectRange } from "./find-in-source";

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

// ----------------------------------------------------------- templates

/** The starter-template picker — a vetted, offline, dependency-free seed
 *  set (web-model's `WEB_TEMPLATES`). An empty frame is a poor first
 *  run; the picker seeds the source HTML/CSS from a chosen template. */
function TemplatePicker({
  onSeed,
}: {
  onSeed(templateId: string): void;
}): ReactElement {
  return (
    <div data-web-templates style={{ margin: "var(--space-1, 4px) 0" }}>
      <div style={{ ...kicker, marginTop: 0 }}>Start from a template</div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-1, 4px)",
        }}
      >
        {WEB_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            data-web-template={t.id}
            title={t.description}
            onClick={() => onSeed(t.id)}
            style={{
              font: "500 11px var(--font-sans, sans-serif)",
              color: "var(--pg-fg)",
              background: "var(--pg-bg)",
              border: "1px solid var(--pg-border)",
              borderRadius: "var(--radius-sm, 4px)",
              padding: "3px 9px",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
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
      const makeFrom = (src: WebFrameSource): void => {
        void host.document.setMetadata(selection[0], envelopeFor(src));
        setSource(src);
      };
      return (
        <div data-web-panel="convert" style={{ padding: "var(--space-3, 12px)", font: "12px var(--font-sans, sans-serif)" }}>
          <p style={{ margin: "0 0 var(--space-2, 8px)", color: "var(--pg-muted-fg)" }}>
            The selected {target.kind} is not a web frame yet.
          </p>
          <button
            type="button"
            data-web-make
            onClick={() => makeFrom(DEFAULT_SOURCE)}
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
          {/* Seed the new frame from a vetted starter instead of the
              default — an empty frame is a poor first run. */}
          <TemplatePicker
            onSeed={(id) => {
              const t = templateById(id);
              if (t) makeFrom(sourceFromTemplate(t, DEFAULT_SOURCE.options));
            }}
          />
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
  // The bundle-owned HTML <textarea> (fallback lane only) — the target
  // the "Find in source" affordance drives the caret in. The host
  // widget lane has no selection prop, so this stays null there and the
  // affordance degrades to a "go to line N" hint (find-in-source.ts).
  const htmlTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The paste-HTML box — a small ingest surface shown on demand. Filled
  // by a paste; its content is SANITIZED before it can seed the source.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [ingestNote, setIngestNote] = useState<string | null>(null);
  // §6.2 deterministic slice — the template pass sits between the
  // (debounced) source and EVERYTHING downstream: the srcdoc, the html
  // lint, and the font parity all consume the RENDERED html/css. The
  // pass only runs when the draft carries a `vars` map (additive
  // opt-in); the scripted Boa transform lane is the W2 follow-on
  // (W-08) — see web-model/src/transform.ts's seam comment. NOTE: when
  // a substituted value contains newlines, gutter line numbers can
  // drift against the editor's template text — the rendered output is
  // the honest lint target (a variable could inject `<script>`; the
  // policy error must fire on what actually previews).
  const rendered = useMemo(() => renderWebFrameSource(preview), [preview]);
  // W-06 — document faces the host asset store served BYTES for and we
  // composed into real `@font-face` rules (data URLs — see
  // font-resolution.ts for why data:, not blob:, in a sandboxed
  // iframe). The preview shows these as the DOCUMENT's actual faces;
  // the badge flips for them. `shownFamilies` are the matched families
  // now shown.
  const [resolvedFaces, setResolvedFaces] = useState<ResolvedFontFace[]>([]);
  const [shownFamilies, setShownFamilies] = useState<string[]>([]);

  // W-06 — resolve the BYTES of the document faces the RENDERED source
  // uses through the capability-gated asset store
  // (`resolvePreviewFontFaces` — the unit the spec exercises). When the
  // host serves no bytes (null answers / no source injected), nothing
  // resolves and the badge stays in its honest substitution state. The
  // `@font-face` CSS lands in the srcdoc <style> — plain CSS with
  // inline data-url src, NO script, so `sandbox=""` is unchanged.
  // Keyed on the DEBOUNCED rendered css (no byte reads per keystroke).
  const cssForFonts = rendered.css;
  useEffect(() => {
    let stale = false;
    void resolvePreviewFontFaces(host, cssForFonts, fontFamilies).then(
      ({ faces, shown }) => {
        if (stale) return;
        setResolvedFaces(faces);
        setShownFamilies(shown);
      },
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssForFonts, fontFamilies.join(" ")]);

  // The full diagnostic set: template-pass warnings (§6.2 slice) +
  // HTML policy/balance + CSS↔document font parity (W1). All lanes
  // share the same WebDiagnostic shape so the panel list, the Problems
  // panel, and the gutter render them uniformly. Pure web-model calls
  // over the DEBOUNCED, RENDERED draft — the lint lane rides the same
  // ~300 ms cadence as the preview. W-06: a family whose bytes were
  // SHOWN drops its "not previewable" info (it IS previewable now).
  const diagnostics = useMemo<WebDiagnostic[]>(
    () => [
      ...rendered.diagnostics,
      ...diagnoseHtml(rendered.html),
      ...diagnoseFonts(rendered.css, fontFamilies, shownFamilies),
    ],
    [rendered, fontFamilies, shownFamilies],
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
    () => previewFontBadge(rendered.css, fontFamilies, shownFamilies),
    [rendered, fontFamilies, shownFamilies],
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
  // inside the srcdoc <style> (plain CSS + inline data-url src, NO
  // script — sandbox="" unchanged). The preview then uses the
  // document's actual faces for every resolved family. The srcdoc body
  // is the RENDERED source (template pass applied).
  const fontFaceCss = useMemo(
    () => composeFontFaces(resolvedFaces),
    [resolvedFaces],
  );
  const srcdoc = useMemo(
    () =>
      composeSrcdoc(
        { html: rendered.html, css: rendered.css, options: preview.options },
        fontFaceCss,
      ),
    [rendered, preview.options, fontFaceCss],
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

  // Seed the draft from a starter template — replaces html/css, keeps
  // the author's current frame OPTIONS (media/viewport). A draft edit
  // (not a document write): the explicit save still commits it.
  const seedTemplate = useCallback((templateId: string) => {
    const t = templateById(templateId);
    if (!t) return;
    setDraft((d) => sourceFromTemplate(t, d.options));
    setIngestNote(null);
  }, []);

  // Paste-HTML ingestion — SANITIZE on the way in (§6.1: page JS never
  // runs, so strip it, don't just diagnose). Sets the draft html to the
  // cleaned markup and notes what was removed. Pure web-model strip via
  // `ingestHtml`; the linter still runs over the result downstream.
  const ingestInto = useCallback((raw: string) => {
    const { html, removed } = ingestHtml(raw);
    setDraft((d) => ({ ...d, html }));
    setIngestNote(
      describeRemoval(removed) ??
        "Pasted HTML — nothing to clean (no scripts or handlers).",
    );
    setPasteOpen(false);
  }, []);

  // Read from the K-6 system clipboard when wired; else open the paste
  // box (the affordance always available). Never throws.
  const pasteFromClipboard = useCallback(() => {
    void ingestFromClipboard(host).then((result) => {
      if (!result) {
        // No backend / empty clipboard → fall back to the paste box.
        setPasteOpen(true);
        setIngestNote(null);
        return;
      }
      setDraft((d) => ({ ...d, html: result.html }));
      setIngestNote(
        describeRemoval(result.removed) ??
          "Pasted from clipboard — nothing to clean.",
      );
    });
  }, []);

  // "Find in source" — the tag outline over the DRAFT html (the live
  // editor text, not the debounced preview). Clicking a tag selects its
  // source range in the bundle-owned textarea (fallback lane); in the
  // host-widget lane there is no selection prop, so it cannot move the
  // caret (the honest W-01 subset boundary — see find-in-source.ts).
  const outline = useMemo<TagOutlineEntry[]>(
    () => tagOutline(draft.html),
    [draft.html],
  );
  const findInSource = useCallback((entry: TagOutlineEntry) => {
    const el = htmlTextareaRef.current;
    if (!el) return; // host-widget lane: no caret to drive
    selectRange(el, entry.sourceStart, entry.sourceEnd);
  }, []);

  // §6.2 slice — the panel-edited variables map. Rows render in entry
  // order; a key rename rebuilds the object (a rename ONTO an existing
  // key keeps the later entry — Object.fromEntries semantics, fine for
  // a hand-edited map). Removing the last row drops `vars` entirely,
  // which DISABLES the pass (placeholders then stay verbatim and stop
  // warning — the documented opt-in seam).
  const varEntries = Object.entries(draft.vars ?? {});
  const setVarEntries = useCallback(
    (entries: Array<[string, string]>) => {
      setDraft((d) => {
        const next = { ...d };
        if (entries.length === 0) delete next.vars;
        else next.vars = Object.fromEntries(entries);
        return next;
      });
    },
    [],
  );

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
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div style={{ ...kicker, marginTop: 0 }}>HTML</div>
        {/* Paste-HTML ingest affordance: reads the K-6 system clipboard
            when wired, else opens the paste box — either way the markup
            is SANITIZED before it seeds the source (§6.1). */}
        <button
          type="button"
          data-web-paste
          onClick={pasteFromClipboard}
          title={
            clipboardAvailable(host)
              ? "Read HTML from the clipboard and sanitize it"
              : "Paste HTML and sanitize it"
          }
          style={{
            font: "500 10px var(--font-sans, sans-serif)",
            color: "var(--pg-fg)",
            background: "var(--pg-bg)",
            border: "1px solid var(--pg-border)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          Paste HTML
        </button>
      </div>
      {pasteOpen && (
        <div data-web-paste-box style={{ margin: "0 0 var(--space-1, 4px)" }}>
          <textarea
            data-web-paste-input
            autoFocus
            spellCheck={false}
            placeholder="Paste HTML here — it is sanitized on insert"
            aria-label="Paste HTML to ingest"
            onPaste={(e) => {
              const text = e.clipboardData.getData("text/html") ||
                e.clipboardData.getData("text/plain");
              if (text) {
                e.preventDefault();
                ingestInto(text);
              }
            }}
            style={{
              width: "100%",
              minHeight: 56,
              resize: "vertical",
              font: "11px/1.5 var(--font-mono, monospace)",
              color: "var(--pg-fg)",
              background: "var(--pg-bg)",
              border: "1px dashed var(--pg-border)",
              borderRadius: "var(--radius-sm, 4px)",
              padding: "var(--space-2, 8px)",
              boxSizing: "border-box",
            }}
          />
        </div>
      )}
      {ingestNote && (
        <p
          data-web-ingest-note
          style={{ margin: "0 0 var(--space-1, 4px)", ...mutedNote }}
        >
          {ingestNote}
        </p>
      )}
      <div data-web-html>
        {lane.native ? (
          <CodeEditor
            language="html"
            value={draft.html}
            onChange={(html) => setDraft({ ...draft, html })}
            diagnostics={htmlGutter}
            minHeight={96}
            ariaLabel="Web frame HTML"
          />
        ) : (
          // Fallback lane — render the bundle's own textarea with a ref
          // so "Find in source" can drive its caret.
          <FallbackCodeEditor
            ref={htmlTextareaRef}
            language="html"
            value={draft.html}
            onChange={(html) => setDraft({ ...draft, html })}
            diagnostics={htmlGutter}
            minHeight={96}
            ariaLabel="Web frame HTML"
          />
        )}
      </div>
      {/* Find in source — the W-01 source-side subset of click-to-inspect.
          Lists the markup's opening tags (the pure `tagOutline` scan);
          clicking one selects its source range in the editor. Full live
          element inspection (hovering a rendered box) awaits the engine
          render lane. */}
      {outline.length > 0 && (
        <details data-web-outline style={{ margin: "var(--space-1, 4px) 0 0" }}>
          <summary
            style={{
              font: "700 10px var(--font-sans, sans-serif)",
              letterSpacing: "var(--tracking-wide, 0.14em)",
              textTransform: "uppercase",
              color: "var(--pg-muted-fg)",
              cursor: "pointer",
            }}
          >
            Find in source ({outline.length})
          </summary>
          <ul
            style={{
              listStyle: "none",
              margin: "var(--space-1, 4px) 0 0",
              padding: 0,
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-1, 4px)",
            }}
          >
            {outline.map((entry, i) => (
              <li key={i}>
                <button
                  type="button"
                  data-web-outline-tag={entry.tag}
                  data-web-outline-line={entry.line}
                  onClick={() => findInSource(entry)}
                  title={
                    lane.native
                      ? `line ${entry.line} — select in the host editor is not wired`
                      : `select <${entry.tag}> at line ${entry.line}`
                  }
                  style={{
                    font: "11px var(--font-mono, monospace)",
                    color: "var(--pg-fg)",
                    background: "var(--pg-bg)",
                    border: "1px solid var(--pg-border)",
                    borderRadius: "var(--radius-sm, 4px)",
                    padding: "1px 6px",
                    cursor: lane.native ? "default" : "pointer",
                  }}
                >
                  {entry.tag}
                  <span style={{ color: "var(--pg-muted-fg)" }}>
                    :{entry.line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {lane.native && (
            <p style={{ margin: "var(--space-1, 4px) 0 0", ...mutedNote }}>
              The host code editor has no selection channel yet — these
              show the line; full element inspection ships with the engine
              render lane.
            </p>
          )}
        </details>
      )}
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
      {/* Replace the draft's HTML/CSS with a vetted starter (keeps the
          current frame options). A draft edit — the explicit save still
          commits it. */}
      <details data-web-template-replace style={{ margin: "var(--space-1, 4px) 0 0" }}>
        <summary
          style={{
            font: "700 10px var(--font-sans, sans-serif)",
            letterSpacing: "var(--tracking-wide, 0.14em)",
            textTransform: "uppercase",
            color: "var(--pg-muted-fg)",
            cursor: "pointer",
          }}
        >
          Replace with template
        </summary>
        <TemplatePicker onSeed={seedTemplate} />
      </details>
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
      <div style={kicker}>Variables</div>
      {/* §6.2 — the DETERMINISTIC template slice: {{name}} substitution
          plus a closed whitelist of pure filters, applied between the
          source and the preview (and, via the persisted vars map, any
          future render lane). NOT a scripting surface: the Boa-powered
          transform lane (ADR-001 engine, W-08) is the W2 follow-on, and
          this panel never pretends otherwise. */}
      {varEntries.map(([name, value], i) => (
        <div key={i} data-web-var-row style={optionRow}>
          <input
            data-web-var-name
            value={name}
            aria-label={`Variable ${i + 1} name`}
            onChange={(e) => {
              const entries = varEntries.slice() as Array<[string, string]>;
              entries[i] = [e.target.value, value];
              setVarEntries(entries);
            }}
            style={{ ...field, width: 96, fontFamily: "var(--font-mono, monospace)" }}
          />
          <input
            data-web-var-value
            value={value}
            aria-label={`Variable ${i + 1} value`}
            onChange={(e) => {
              const entries = varEntries.slice() as Array<[string, string]>;
              entries[i] = [name, e.target.value];
              setVarEntries(entries);
            }}
            style={{ ...field, flex: 1 }}
          />
          <button
            type="button"
            data-web-var-remove
            aria-label={`Remove variable ${name}`}
            onClick={() =>
              setVarEntries(
                varEntries.filter((_, j) => j !== i) as Array<[string, string]>,
              )
            }
            style={{
              font: "500 11px var(--font-sans, sans-serif)",
              color: "var(--pg-fg)",
              background: "var(--pg-bg)",
              border: "1px solid var(--pg-border)",
              borderRadius: "var(--radius-sm, 4px)",
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      ))}
      <div style={optionRow}>
        <button
          type="button"
          data-web-var-add
          onClick={() => {
            const used = new Set(varEntries.map(([k]) => k));
            let n = varEntries.length + 1;
            while (used.has(`var${n}`)) n += 1;
            setVarEntries([...varEntries, [`var${n}`, ""]] as Array<
              [string, string]
            >);
          }}
          style={{
            font: "500 11px var(--font-sans, sans-serif)",
            color: "var(--pg-fg)",
            background: "var(--pg-bg)",
            border: "1px solid var(--pg-border)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          Add variable
        </button>
        <span style={mutedNote}>
          {"{{name}}"} substitution + {TEMPLATE_FILTERS.join(" · ")} —
          deterministic; scripted (Boa) transforms ship with the W2 lane
        </span>
      </div>
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
