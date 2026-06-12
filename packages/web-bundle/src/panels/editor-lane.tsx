// W-04 consumer — which code-editor lane the source panel renders.
//
// The probe is `host.supports("widgets.codeEditor@1")`: true means the
// host APP injected a real widget catalog and `host.widgets.CodeEditor`
// is the rich editor (line numbers, HTML/CSS highlighting, diagnostics
// gutter). False means headless/conformance/older hosts — the SDK's
// `host.widgets` does degrade to ITS textarea stand-in, but the bundle
// renders its OWN plain textarea instead of leaning on that catalog
// internal: the branch is explicit, bundle-owned, and testable, and
// `data-web-editor-lane` says which lane is live (honest seams — the
// fallback never pretends to be the widget).

import type { ComponentType, ReactElement } from "react";

import type { CodeEditorProps } from "@paged-media/plugin-api";

/** The bundle's honest plain-textarea fallback. Same props CONTRACT as
 *  the host widget so the panel wires both lanes identically; the
 *  `diagnostics` prop is accepted but renders no gutter (the panel's
 *  diagnostics list below the preview still shows every finding). */
export function FallbackCodeEditor(props: CodeEditorProps): ReactElement {
  return (
    <textarea
      data-web-editor-fallback={props.language ?? "text"}
      value={props.value}
      readOnly={props.readOnly}
      spellCheck={false}
      aria-label={props.ariaLabel}
      onChange={(e) => props.onChange(e.target.value)}
      style={{
        width: "100%",
        minHeight: props.minHeight ?? 96,
        resize: "vertical",
        font: "12px/1.5 var(--font-mono, monospace)",
        fontVariantNumeric: "tabular-nums",
        color: "var(--pg-fg)",
        background: "var(--pg-bg)",
        border: "1px solid var(--pg-border)",
        borderRadius: "var(--radius-sm, 4px)",
        padding: "var(--space-2, 8px)",
        boxSizing: "border-box",
      }}
    />
  );
}

export interface EditorLane {
  /** True when the HOST's rich widget is live (the W-04 surface). */
  native: boolean;
  CodeEditor: ComponentType<CodeEditorProps>;
}

/** Resolve the editor lane once per bundle activation — `supports` and
 *  `widgets` are stable for the host's lifetime. */
export function resolveEditorLane(host: {
  supports(feature: string): boolean;
  widgets: { CodeEditor: ComponentType<CodeEditorProps> };
}): EditorLane {
  return host.supports("widgets.codeEditor@1")
    ? { native: true, CodeEditor: host.widgets.CodeEditor }
    : { native: false, CodeEditor: FallbackCodeEditor };
}
