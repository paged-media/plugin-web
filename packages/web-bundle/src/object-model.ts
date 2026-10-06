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

// paged.web's OBJECT MODEL (ADR 323): what scripts, the Node CLI, data
// bindings and schema-driven panel fields reach through `host.objects`.
//
//   plugin:media.paged.web/webFrame/<frame id>          the source of a web frame
//   plugin:media.paged.web/templateVar/doc.<key>        a bound value — doc.title,
//   plugin:media.paged.web/templateVar/data.<field>     doc.pages, the document
//                                                       value map, a provider field
//   plugin:media.paged.web/cssVar/<frame id>/--<name>   a CSS custom property of a
//                                                       frame's css lane
//
// The rows are the manifest's (`contributes.objectModel`): ONE declaration,
// read here, so the runtime registration cannot drift from what plugin-cli
// validates. Every handler is headless — host document doors and parts
// only, no DOM, no selection, no edit context.
//
// Persistence follows the source rules (source-part.ts): a web frame's
// source is its LABEL (inline, or a pointer to a content-addressed part), so
// a write is the label-hash pattern — the parts the label needs plus the
// label, committed by the registry inside ONE engine batch (one undo step;
// undo reverts the label, which names the previous source). Document values
// live in the document label (designmap) — one more mutation in the same
// batch.
//
// Writes are planned by ONE plugin-level planner (`planWebOps`), so a batch
// that writes a frame through two kinds (`webFrame.css` and a `cssVar` of
// the same frame) composes both from one state.

import type {
  Address,
  BundleHost,
  ElementId,
  MutationInput,
  ObjectKindContribution,
  ObjectModelContribution,
  ObjectModelHandle,
  ObjectOp,
  ObjectQuery,
  ObjectValue,
  ObjectWrite,
  PartChange,
  PropertySchema,
  TypedCommandContribution,
} from "@paged-media/plugin-api";
import { escapeLabelValue, fromElementId, parseAddress } from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";
import {
  boundNamesIn,
  cssVarNames,
  DEFAULT_SOURCE,
  isCssVarName,
  normalizeFlowChain,
  normalizeTemplateVars,
  OVERFLOW_POLICIES,
  parseFlowInto,
  scanCssVars,
  setCssVar,
  sourceRefOf,
  withRecipient,
  type WebFrameSource,
  type WebSourceEnvelope,
} from "../../web-model/src";
import { discoverWebFrames } from "./auto-render";
import { bakeWebFrame, bakeWebFlows, bakeWebFlow } from "./bake";
import { bakeWebFlowToDocument, bakeWebFrameToDocument } from "./bake-to-document";
import { resolveDocumentVars } from "./bindings";
import { loadWebEngine } from "./engine-loader";
import {
  DOCUMENT_VALUE_KEY,
  documentValuesMutation,
  loadWebSource,
  planSourceWrite,
  readDocumentValues,
  readWebLabel,
} from "./source-part";

export const PLUGIN_ID = manifest.id;
const LABEL_KEY = `x-paged:${PLUGIN_ID}`;

/** Default bounds of an inserted web frame, page-local pt. */
const DEFAULT_BOUNDS: [number, number, number, number] = [60, 60, 240, 300];

type KindName = "webFrame" | "templateVar" | "cssVar";

/** The schema rows the manifest declares for `kind`. */
export function schemaOf(kind: KindName): readonly PropertySchema[] {
  const k = manifest.contributes.objectModel.kinds.find((x) => x.kind === kind);
  if (!k) throw new Error(`paged.web: the manifest declares no object kind "${kind}"`);
  return k.schema as unknown as readonly PropertySchema[];
}

const decl = (id: string) => {
  const c = manifest.contributes.objectModel.commands.find((x) => x.id === id);
  if (!c) throw new Error(`paged.web: the manifest declares no typed command "${id}"`);
  return c as unknown as Pick<TypedCommandContribution, "id" | "title" | "args" | "result">;
};

/** The address of a plugin object of this bundle. */
export const webAddress = (kind: KindName, id: string): Address => `plugin:${PLUGIN_ID}/${kind}/${id}`;

/** The schema-driven panel fields (ADR 323 / Wave 4): the paths the web
 *  frame panel edits, in panel order, for the host's shared `PropertyField`.
 *  Every entry is a writable row of its kind (a spec holds it to that). */
export const PANEL_FIELDS: ReadonlyArray<{ kind: KindName; path: string; group: string }> = [
  { kind: "webFrame", path: "html", group: "Source" },
  { kind: "webFrame", path: "css", group: "Source" },
  { kind: "webFrame", path: "media", group: "Render" },
  { kind: "webFrame", path: "overflow", group: "Render" },
  { kind: "webFrame", path: "vars", group: "Template" },
  { kind: "webFrame", path: "flow", group: "Flow" },
  { kind: "templateVar", path: "value", group: "Bound values" },
  { kind: "cssVar", path: "value", group: "CSS variables" },
];

// ------------------------------------------------------------ helpers

const val = (value: unknown): ObjectValue => ({ kind: "value", value });
const ABSENT: ObjectValue = { kind: "absent" };
const refuse = (code: "unknownAddress" | "unknownPath" | "badAddress", reason: string): ObjectValue => ({
  kind: "refused",
  code,
  reason,
});

/** The object id of one of this bundle's addresses for `kind`, or null. */
function idOf(address: Address, kind: KindName): string | null {
  const a = parseAddress(address);
  return a && a.kind === "plugin" && a.plugin === PLUGIN_ID && a.objectKind === kind ? a.id : null;
}

/** Every web frame: its id → the page item `ElementId`. One tree read. */
async function webFrames(host: BundleHost): Promise<{ frames: Map<string, ElementId>; items: Map<string, ElementId> }> {
  const { items, found } = await discoverWebFrames(host);
  const byId = (list: readonly ElementId[]) => new Map(list.map((e) => [(e as { id: string }).id, e]));
  return { frames: byId(found.map((f) => f.id)), items: byId(items) };
}

/** A frame reference (a core item address, `frame:<id>`, or a webFrame
 *  address) → the page item's `ElementId`, or null. */
function resolveFrameRef(ref: string, items: Map<string, ElementId>): ElementId | null {
  const a = parseAddress(ref);
  if (!a) return null;
  if (a.kind === "item" || a.kind === "frame") return items.get(a.id) ?? null;
  if (a.kind === "plugin" && a.plugin === PLUGIN_ID && a.objectKind === "webFrame") return items.get(a.id) ?? null;
  return null;
}

/** A page reference (`page:<id>` or `page:#<n>`) → the page id, or null. */
async function resolvePage(host: BundleHost, ref: string): Promise<string | null> {
  const a = parseAddress(ref);
  if (!a) return null;
  if (a.kind !== "page" && a.kind !== "pageIndex") return null;
  const pages = await host.document.collection<{ selfId: string; index: number }>("pages");
  if (a.kind === "page") return pages.some((p) => p.selfId === a.id) ? a.id : null;
  return pages[a.index - 1]?.selfId ?? null;
}

/** Where a frame's source lives, from its label. */
async function storageOf(host: BundleHost, id: ElementId): Promise<"inline" | "part"> {
  const text = await readWebLabel(host, id);
  if (!text) return "inline";
  try {
    return sourceRefOf(JSON.parse(text) as WebSourceEnvelope) ? "part" : "inline";
  } catch {
    return "inline";
  }
}

class Rejected extends Error {}

/** Apply one `set` of a webFrame path to a source; throws `Rejected`. */
function applyFramePath(
  source: WebFrameSource,
  path: string,
  value: unknown,
  frameTarget: { kind: string; id: string },
  items: Map<string, ElementId>,
): WebFrameSource {
  switch (path) {
    case "html":
    case "content":
      return { ...source, html: value as string };
    case "css":
      return { ...source, css: value as string };
    case "media":
      return { ...source, options: { ...source.options, media: value as "print" | "screen" } };
    case "overflow":
      return { ...source, options: { ...source.options, overflow: value as (typeof OVERFLOW_POLICIES)[number] } };
    case "vars": {
      if (value === null) {
        const { vars: _drop, ...rest } = source;
        return rest;
      }
      return { ...source, vars: normalizeTemplateVars(value) ?? {} };
    }
    case "flow": {
      const list = value as Array<{ frame: string; flow: string }>;
      let next: WebFrameSource = { ...source };
      delete next.flow;
      for (const r of list) {
        const target = resolveFrameRef(r.frame, items);
        if (!target) throw new Rejected(`flow: ${r.frame} is not a page item of this document`);
        const t = { kind: target.kind, id: (target as { id: string }).id };
        if (t.id === frameTarget.id) throw new Rejected("flow: a web frame cannot thread into itself");
        next = withRecipient(next, frameTarget, t, r.flow.length > 0 ? r.flow : undefined);
      }
      const chain = normalizeFlowChain(next.flow);
      if (chain) next.flow = chain;
      else delete next.flow;
      return next;
    }
    default:
      throw new Rejected(`webFrame.${path} is not writable`);
  }
}

/** What a set of label writes commits as: the label-hash pattern for one
 *  frame (`state`), `both` when the batch carries more. */
function writeOf(
  labels: ReadonlyArray<{ id: ElementId; labelValue: string }>,
  parts: readonly PartChange[],
  extra: readonly MutationInput[],
): ObjectWrite {
  const labelMutation = (l: { id: ElementId; labelValue: string }): MutationInput =>
    ({
      op: "setPluginMetadata",
      args: { elementId: l.id, key: LABEL_KEY, value: escapeLabelValue(l.labelValue), caller: PLUGIN_ID },
    }) as MutationInput;
  if (labels.length === 0) return { kind: "mutations", mutations: [...extra] };
  const [first, ...rest] = labels;
  const host = fromElementId(first!.id);
  if (rest.length === 0 && extra.length === 0) {
    return { kind: "state", parts: [...parts], host, labelKey: LABEL_KEY, labelValue: first!.labelValue };
  }
  return {
    kind: "both",
    mutations: [...extra, ...rest.map(labelMutation)],
    parts: [...parts],
    host,
    labelKey: LABEL_KEY,
    labelValue: first!.labelValue,
  };
}

// ------------------------------------------------------------- kinds

function webFrameKind(host: BundleHost): ObjectKindContribution {
  return {
    kind: "webFrame",
    title: "Web frame",
    schema: schemaOf("webFrame"),
    content: { kind: "html", mime: ["text/html"] },
    hostOf: (address) => {
      const id = idOf(address, "webFrame");
      return id ? `frame:${id}` : null;
    },
    async list(query: ObjectQuery) {
      const { frames } = await webFrames(host);
      let ids = [...frames.keys()];
      const within = query.within ? parseAddress(query.within) : null;
      if (within && within.kind !== "doc") {
        const pageId =
          within.kind === "page" ? within.id : within.kind === "pageIndex" ? await resolvePage(host, query.within!) : null;
        if (pageId === null) return [];
        const geo = await host.document.elementGeometry(ids.map((id) => frames.get(id)!));
        ids = ids.filter((_, i) => geo[i]?.pageId === pageId);
      }
      return ids.map((id) => webAddress("webFrame", id));
    },
    async get(address, path) {
      const id = idOf(address, "webFrame");
      if (!id) return refuse("badAddress", `${address} is not a web frame address`);
      const { frames } = await webFrames(host);
      const elementId = frames.get(id);
      if (!elementId) return refuse("unknownAddress", `${address}: no web frame ${id} in this document`);
      if (path === "frame") return val(fromElementId(elementId));
      if (path === "storage") return val(await storageOf(host, elementId));
      const source = await loadWebSource(host, elementId);
      if (!source) return refuse("unknownAddress", `${address}: the frame's source part is missing`);
      switch (path) {
        case "html":
        case "content":
          return val(source.html);
        case "css":
          return val(source.css);
        case "media":
          return val(source.options.media);
        case "overflow":
          return val(source.options.overflow);
        case "viewportWidth":
          return val(source.options.viewportWidth ?? null);
        case "vars":
          return val(source.vars ?? null);
        case "flow":
          return val(
            (source.flow?.recipients ?? []).map((r) => ({
              frame: fromElementId({ kind: r.kind, id: r.id } as ElementId),
              flow: r.flow ?? "",
            })),
          );
        case "boundNames":
          return val(boundNamesIn(source));
        case "cssVars":
          return val(cssVarNames(source.css));
        default:
          return refuse("unknownPath", `webFrame has no path "${path}"`);
      }
    },
  };
}

/** A web frame create: `insertFrame` on the page + its label on the frame
 *  the insert mints (the batch-created sentinel), as the insert command. */
async function planCreate(
  host: BundleHost,
  within: Address | undefined,
  props: Record<string, unknown>,
): Promise<MutationInput[]> {
  const meta = await host.document.meta();
  const pageId = within ? await resolvePage(host, within) : (meta.activePage ?? (await resolvePage(host, "page:#1")));
  if (!pageId) throw new Rejected(`create webFrame: ${within ?? "the document"} names no page`);
  let source: WebFrameSource = { ...DEFAULT_SOURCE };
  for (const [path, value] of Object.entries(props)) {
    source = applyFramePath(source, path, value, { kind: "rectangle", id: "$created" }, new Map());
  }
  const plan = planSourceWrite(host, source);
  if ("refused" in plan) throw new Rejected(plan.refused);
  if (plan.parts.length > 0) {
    // A create's label rides the batch as a plain mutation (the frame has
    // no address yet), so its part is written here, ahead of the commit —
    // content-addressed, harmless if the commit is refused.
    for (const p of plan.parts) await host.parts.write(p.path, p.bytes!);
  }
  return [
    { op: "insertFrame", args: { pageId, bounds: DEFAULT_BOUNDS } } as MutationInput,
    {
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "rectangle", id: "$created" },
        key: LABEL_KEY,
        value: escapeLabelValue(plan.labelValue),
        caller: PLUGIN_ID,
      },
    } as MutationInput,
  ];
}

/** `doc.<key>` / `data.<…>` names: what `templateVar` addresses. */
const TEMPLATE_VAR = /^(doc|data)\.[A-Za-z0-9_.-]+$/;
const DERIVED_DOC = new Set(["doc.title", "doc.pages"]);

function templateVarKind(host: BundleHost): ObjectKindContribution {
  /** Every web frame's bound names, by frame id. */
  const usage = async (): Promise<Map<string, string[]>> => {
    const { frames } = await webFrames(host);
    const out = new Map<string, string[]>();
    for (const [id, e] of frames) {
      const s = await loadWebSource(host, e);
      if (s) out.set(id, boundNamesIn(s));
    }
    return out;
  };
  return {
    kind: "templateVar",
    title: "Template value",
    schema: schemaOf("templateVar"),
    hostOf: () => "doc",
    async list() {
      const { vars } = await resolveDocumentVars(host);
      const names = new Set(Object.keys(vars));
      for (const used of (await usage()).values()) {
        for (const n of used) if (TEMPLATE_VAR.test(n)) names.add(n);
      }
      return [...names].sort().map((n) => webAddress("templateVar", n));
    },
    async get(address, path) {
      const name = idOf(address, "templateVar");
      if (!name || !TEMPLATE_VAR.test(name)) {
        return refuse("badAddress", `${address}: a template value is doc.<key> or data.<field>`);
      }
      const scope = name.startsWith("doc.") ? "doc" : "data";
      switch (path) {
        case "name":
          return val(name);
        case "scope":
          return val(scope);
        case "writable":
          return val(scope === "doc" && !DERIVED_DOC.has(name));
        case "value": {
          const { vars } = await resolveDocumentVars(host);
          return Object.prototype.hasOwnProperty.call(vars, name) ? val(vars[name]) : val(null);
        }
        case "usedBy": {
          const out: string[] = [];
          for (const [id, names] of await usage()) if (names.includes(name)) out.push(webAddress("webFrame", id));
          return val(out);
        }
        default:
          return refuse("unknownPath", `templateVar has no path "${path}"`);
      }
    },
  };
}

/** A cssVar address (`<frame id>/--name`) → its parts, or null. */
function split(address: Address): { frame: string; name: string } | null {
  const id = idOf(address, "cssVar");
  const slash = id ? id.lastIndexOf("/") : -1;
  if (!id || slash <= 0) return null;
  const name = id.slice(slash + 1);
  return isCssVarName(name) ? { frame: id.slice(0, slash), name } : null;
}

function cssVarKind(host: BundleHost): ObjectKindContribution {
  return {
    kind: "cssVar",
    title: "CSS variable",
    schema: schemaOf("cssVar"),
    hostOf: (address) => {
      const s = split(address);
      return s ? `frame:${s.frame}` : null;
    },
    async list(query) {
      const { frames } = await webFrames(host);
      const scoped = query.within ? parseAddress(query.within) : null;
      const only =
        scoped?.kind === "plugin" && scoped.objectKind === "webFrame"
          ? scoped.id
          : scoped?.kind === "item" || scoped?.kind === "frame"
            ? scoped.id
            : null;
      const out: Address[] = [];
      for (const [id, e] of frames) {
        if (only !== null && id !== only) continue;
        const s = await loadWebSource(host, e);
        for (const n of s ? cssVarNames(s.css) : []) out.push(webAddress("cssVar", `${id}/${n}`));
      }
      return out;
    },
    async get(address, path) {
      const s = split(address);
      if (!s) return refuse("badAddress", `${address}: a CSS variable is <frame id>/--<name>`);
      const { frames } = await webFrames(host);
      const e = frames.get(s.frame);
      if (!e) return refuse("unknownAddress", `${address}: no web frame ${s.frame}`);
      if (path === "name") return val(s.name);
      if (path === "frame") return val(webAddress("webFrame", s.frame));
      const source = await loadWebSource(host, e);
      const decls = source ? scanCssVars(source.css).filter((d) => d.name === s.name) : [];
      const first = decls[0];
      switch (path) {
        case "value":
          return first ? val(first.value) : ABSENT;
        case "declarations":
          return val(decls.length);
        case "context":
          return first ? val(first.context.join(" > ")) : ABSENT;
        case "important":
          return first ? val(first.important) : ABSENT;
        default:
          return refuse("unknownPath", `cssVar has no path "${path}"`);
      }
    },
  };
}

// ------------------------------------------------------- the planner

/**
 * The PLUGIN-level planner (ADR 323): every write op of a batch on any of
 * the three kinds, in batch order, planned from ONE state per frame — so a
 * `webFrame.css` set and a `cssVar` set on the same frame compose — and
 * answered as ONE write: each touched frame's label (the label-hash pattern;
 * the parts a large source needs), the document label when a document value
 * changed, plus creates and deletes.
 */
async function planWebOps(host: BundleHost, ops: readonly ObjectOp[]): Promise<ObjectWrite> {
  try {
    const { frames, items } = await webFrames(host);
    const planned = new Map<string, WebFrameSource>();
    const extra: MutationInput[] = [];
    let values: Record<string, string> | null = null;
    const sourceOf = async (id: string, address: string): Promise<WebFrameSource> => {
      const e = frames.get(id);
      if (!e) throw new Rejected(`${address}: no such web frame`);
      const current = planned.get(id) ?? (await loadWebSource(host, e));
      if (!current) throw new Rejected(`${address}: the frame's source part is missing`);
      return current;
    };
    for (const op of ops) {
      if (op.op === "invoke") throw new Rejected("invoke cannot share a batch with writes");
      if (op.op === "create") {
        if (op.kind !== `plugin:${PLUGIN_ID}/webFrame` && op.kind !== "webFrame") {
          throw new Rejected(`create ${op.kind}: only web frames are created`);
        }
        extra.push(...(await planCreate(host, op.within, op.props ?? {})));
        continue;
      }
      const a = parseAddress(op.address);
      const kind = a && a.kind === "plugin" ? (a.objectKind as KindName) : null;
      if (op.op === "delete") {
        const id = kind === "webFrame" ? idOf(op.address, "webFrame") : null;
        const e = id ? frames.get(id) : undefined;
        if (!e) throw new Rejected(`${op.address}: only a web frame can be deleted`);
        extra.push({ op: "deleteFrame", args: { frameId: (e as { id: string }).id } } as MutationInput);
        continue;
      }
      if (kind === "webFrame") {
        const id = idOf(op.address, "webFrame")!;
        const e = frames.get(id);
        const current = await sourceOf(id, op.address);
        planned.set(id, applyFramePath(current, op.path, op.value, { kind: e!.kind, id }, items));
      } else if (kind === "cssVar") {
        const s = split(op.address);
        if (!s) throw new Rejected(`${op.address} is not a CSS variable address`);
        if (op.path !== "value") throw new Rejected(`cssVar.${op.path} is not writable`);
        const current = await sourceOf(s.frame, op.address);
        const next = setCssVar(current.css, s.name, op.value as string);
        if ("refused" in next) throw new Rejected(`${s.name}: ${next.refused}`);
        planned.set(s.frame, { ...current, css: next.css });
      } else if (kind === "templateVar") {
        const name = idOf(op.address, "templateVar");
        if (!name || !TEMPLATE_VAR.test(name)) throw new Rejected(`${op.address} is not a template value`);
        if (op.path !== "value") throw new Rejected(`templateVar.${op.path} is not writable`);
        if (name.startsWith("data.")) {
          throw new Rejected(`${name} comes from a dataset provider's first record; set it at the source`);
        }
        if (DERIVED_DOC.has(name)) throw new Rejected(`${name} is read from the document`);
        const key = name.slice(4);
        if (!DOCUMENT_VALUE_KEY.test(key)) throw new Rejected(`"${key}" is not a document value key`);
        if (!host.supports("document.documentMetadata@1")) {
          throw new Rejected("this engine has no document label to keep document values in (protocol 69)");
        }
        values ??= { ...(await readDocumentValues(host)) };
        if (op.value === null) delete values[key];
        else values[key] = op.value as string;
      } else {
        throw new Rejected(`${op.address} is not a paged.web object`);
      }
    }
    if (values) extra.push(documentValuesMutation(values));
    const labels: Array<{ id: ElementId; labelValue: string }> = [];
    const parts: PartChange[] = [];
    for (const [id, source] of planned) {
      const plan = planSourceWrite(host, source);
      if ("refused" in plan) throw new Rejected(plan.refused);
      labels.push({ id: frames.get(id)!, labelValue: plan.labelValue });
      parts.push(...plan.parts);
    }
    return writeOf(labels, parts, extra);
  } catch (err) {
    if (err instanceof Rejected) return { kind: "rejected", reason: err.message };
    throw err;
  }
}

// ---------------------------------------------------------- commands

type FrameArgs = { frame: string };
type TargetArgs = FrameArgs & { targets: string[] };

/** A frame argument → the web frame's `ElementId` (refused when the frame
 *  is not a web frame). */
async function webFrameArg(host: BundleHost, ref: string): Promise<{ id: ElementId; items: Map<string, ElementId> }> {
  const { frames, items } = await webFrames(host);
  const e = resolveFrameRef(ref, items);
  if (!e || !frames.has((e as { id: string }).id)) throw new Error(`invalidValue: ${ref} is not a web frame`);
  return { id: e, items };
}

const messages = (d: ReadonlyArray<{ message: string }>) => d.map((x) => x.message);

function typedCommands(host: BundleHost): TypedCommandContribution[] {
  const cmd = <A, R>(id: string, handler: TypedCommandContribution<A, R>["handler"]): TypedCommandContribution =>
    ({ ...decl(id), handler }) as TypedCommandContribution;
  /** Thread / unthread through `objects.set(webFrame.flow)`: one undo step. */
  const editFlow = async (
    objects: { get: (a: Address, p: string) => Promise<ObjectValue>; set: (a: Address, p: string, v: unknown) => Promise<{ applied: boolean; reason?: string }> },
    args: TargetArgs,
    edit: (flow: Array<{ frame: string; flow: string }>, target: string) => boolean,
  ): Promise<number> => {
    const { id, items } = await webFrameArg(host, args.frame);
    const address = webAddress("webFrame", (id as { id: string }).id);
    const current = await objects.get(address, "flow");
    const flow = current.kind === "value" ? [...(current.value as Array<{ frame: string; flow: string }>)] : [];
    let changed = 0;
    for (const t of args.targets) {
      const e = resolveFrameRef(t, items);
      if (!e) throw new Error(`invalidValue: ${t} is not a page item`);
      if (edit(flow, fromElementId(e))) changed += 1;
    }
    if (changed === 0) return 0;
    const out = await objects.set(address, "flow", flow);
    if (!out.applied) throw new Error(`failed: ${out.reason ?? "the flow chain was not saved"}`);
    return changed;
  };
  /** Two frame references name the same page item. */
  const sameItem = (a: string, b: string) => {
    const id = (ref: string) => {
      const p = parseAddress(ref);
      return p && (p.kind === "item" || p.kind === "frame" || p.kind === "plugin") ? p.id : ref;
    };
    return id(a) === id(b);
  };
  return [
    cmd<{ page: string; bounds: number[]; html: string; css: string }, unknown>(
      "media.paged.web.command.insertWebFrame",
      async (_ctx, args) => {
        const pageId = await resolvePage(host, args.page);
        if (!pageId) throw new Error(`invalidValue: ${args.page} is not a page of this document`);
        const blank = args.html.length === 0 && args.css.length === 0;
        const source: WebFrameSource = blank ? DEFAULT_SOURCE : { ...DEFAULT_SOURCE, html: args.html, css: args.css };
        const plan = planSourceWrite(host, source);
        if ("refused" in plan) throw new Error(`failed: ${plan.refused}`);
        for (const p of plan.parts) await host.parts.write(p.path, p.bytes!);
        const outcome = await host.document.mutate({
          op: "batch",
          args: {
            ops: [
              { op: "insertFrame", args: { pageId, bounds: args.bounds as [number, number, number, number] } },
              {
                op: "setPluginMetadata",
                args: { elementId: { kind: "rectangle", id: "$created" }, key: LABEL_KEY, value: plan.labelValue },
              },
            ],
          },
        } as never);
        if (!outcome.applied || !outcome.createdId) throw new Error(`failed: the document created no frame`);
        return {
          webFrame: webAddress("webFrame", (outcome.createdId as { id: string }).id),
          frame: fromElementId(outcome.createdId),
        };
      },
    ),
    cmd<FrameArgs, unknown>("media.paged.web.command.renderWebFrame", async (_ctx, args) => {
      const { id } = await webFrameArg(host, args.frame);
      const out = await bakeWebFrame(host, id, await loadWebEngine(host));
      return { rendered: out.rendered, submitted: out.submitted, diagnostics: messages(out.diagnostics) };
    }),
    cmd<FrameArgs, unknown>("media.paged.web.command.renderWebFlow", async (_ctx, args) => {
      const { id } = await webFrameArg(host, args.frame);
      const engine = await loadWebEngine(host);
      const source = await loadWebSource(host, id);
      const out = source?.flow ? await bakeWebFlows(host, id, engine) : await bakeWebFlow(host, [id], engine);
      return {
        rendered: out.rendered,
        submitted: out.submittedCount,
        overset: out.overset,
        diagnostics: messages(out.diagnostics),
      };
    }),
    cmd<TargetArgs & { flow: string }, unknown>("media.paged.web.command.threadWebFlow", async (ctx, args) => {
      const added = await editFlow(ctx.objects, args, (flow, target) => {
        if (sameItem(target, args.frame) || flow.some((r) => sameItem(r.frame, target))) return false;
        flow.push({ frame: target, flow: args.flow });
        return true;
      });
      return { added };
    }),
    cmd<TargetArgs, unknown>("media.paged.web.command.unthreadWebFlow", async (ctx, args) => {
      const removed = await editFlow(ctx.objects, args, (flow, target) => {
        const i = flow.findIndex((r) => sameItem(r.frame, target));
        if (i < 0) return false;
        flow.splice(i, 1);
        return true;
      });
      return { removed };
    }),
    cmd<TargetArgs, unknown>("media.paged.web.command.threadWebFlowNamed", async (ctx, args) => {
      const { id } = await webFrameArg(host, args.frame);
      const source = await loadWebSource(host, id);
      const flows = source ? parseFlowInto(source.css) : [];
      if (flows.length < 2) throw new Error("failed: the source declares no secondary named flow (a second flow-into rule)");
      const name = flows[1]!.name;
      const added = await editFlow(ctx.objects, args, (flow, target) => {
        if (sameItem(target, args.frame) || flow.some((r) => sameItem(r.frame, target))) return false;
        flow.push({ frame: target, flow: name });
        return true;
      });
      return { flow: name, added };
    }),
    cmd<FrameArgs, unknown>("media.paged.web.command.bakeWebFrame", async (_ctx, args) => {
      const { id } = await webFrameArg(host, args.frame);
      const source = await loadWebSource(host, id);
      const recipients = source?.flow?.recipients ?? [];
      const out =
        recipients.length > 0
          ? await bakeWebFlowToDocument(host, [id, ...recipients.map((r) => ({ kind: r.kind, id: r.id }) as ElementId)])
          : await bakeWebFrameToDocument(host, id);
      return { baked: out.baked, created: out.createdCount, diagnostics: messages(out.diagnostics) };
    }),
  ];
}

// ------------------------------------------------------------ entry

/** The bundle's object model, over `host` (headless). */
export function createWebObjectModel(host: BundleHost): ObjectModelContribution {
  return {
    kinds: [webFrameKind(host), templateVarKind(host), cssVarKind(host)],
    commands: typedCommands(host),
    batch: (ops) => planWebOps(host, ops),
  };
}

/** Register the object model when the host has the door (plugin-api
 *  0.2.43); `null` on an older host. */
export function contributeObjectModel(host: BundleHost): ObjectModelHandle | null {
  if (!host.supports("contribute.objectModel@1")) return null;
  return host.contribute.objectModel(createWebObjectModel(host));
}
