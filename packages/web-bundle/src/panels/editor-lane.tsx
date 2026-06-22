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

import { forwardRef, type ComponentType, type ReactElement, type Ref } from "react";

import type { CodeEditorProps } from "@paged-media/plugin-api";

/** The bundle's honest plain-textarea fallback. Same props CONTRACT as
 *  the host widget so the panel wires both lanes identically; the
 *  `diagnostics` prop is accepted but renders no gutter (the panel's
 *  diagnostics list below the preview still shows every finding).
 *
 *  Forwards a ref to its underlying <textarea> so the "Find in source"
 *  affordance can drive the caret in THIS lane (the host widget lane has
 *  no selection prop — see find-in-source.ts's seam note). */
export const FallbackCodeEditor = forwardRef(function FallbackCodeEditor(
  props: CodeEditorProps,
  ref: Ref<HTMLTextAreaElement>,
): ReactElement {
  return (
    <textarea
      ref={ref}
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
});

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
