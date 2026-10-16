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

// Where a web frame's source lives — the ONE reader and the ONE writer.
//
// The host offers two homes with different rules:
//   · the metadata LABEL (`host.document.setMetadata`): undoable, IDML-
//     portable, capped at 64 KiB by the engine;
//   · the container PART (`host.parts`): uncapped, travels with the
//     `.paged` file, but NOT undoable.
//
// A source that fits stays inline in the label. A larger one is written to
// a CONTENT-ADDRESSED part (`sources/<hash>.json`) and the label carries a
// pointer `{ ref: { hash, bytes } }`. Because a new save writes a new part
// path and never overwrites one, undo of the label returns to a pointer
// whose part still exists — the label, which undo restores, always names
// the live source, and every reader (panel, render, flow, bake) goes
// through `loadWebSource`.
//
// Legacy documents wrote the source to BOTH homes, the part at
// `<frame-id>/source.json`. That part is read only for a label the earlier
// writer wrote (one without the single writer's `legacyPart: false` marker,
// web-model `NO_LEGACY_PART`), and wins only when it cannot have been
// mirrored by the label (its envelope is over the label cap, so the label
// write was refused), or when there is no label source at all. A label this
// writer wrote costs no part read. (Mixed versions: an older plugin saving a
// source over 64 KiB onto a marked label writes only the legacy part — its
// label write is refused — and that edit stays invisible here, as it was
// "unsaved" for the older plugin itself.)
//
// Content-addressed parts accumulate: one per saved version of a large
// source. The ones no label and no undo step can reach are dropped on save
// by parts-gc.ts (ADR 410).

import type {
  BundleHost,
  ElementId,
  MutationInput,
  PartChange,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import {
  contentHash,
  isWebFrameEnvelope,
  LABEL_INLINE_MAX_BYTES,
  sourceFromEnvelope,
  sourceFromPartText,
  sourcePartPath,
  hasNoLegacyPart,
  sourceRefOf,
  storeSource,
  utf8Length,
  type WebFrameSource,
  type WebSourceEnvelope,
} from "../../web-model/src";

type PersistHost = Pick<BundleHost, "document" | "parts" | "supports">;

const decoder = new TextDecoder();

/** Source parts this bundle wrote in this session, per host. An undo can
 *  return to any of them, so the collector (parts-gc.ts) never drops one. */
const written = new WeakMap<object, Set<string>>();

export function partsWrittenThisSession(host: object): Set<string> {
  let set = written.get(host);
  if (!set) {
    set = new Set();
    written.set(host, set);
  }
  return set;
}

/** The legacy (pre-pointer) part path for a frame's source. */
function legacyPartPath(id: ElementId): string | null {
  const raw = (id as { id?: unknown }).id;
  return typeof raw === "string" ? `${raw}/source.json` : null;
}

async function readPartText(host: PersistHost, path: string): Promise<string | null> {
  if (!host.supports("storage.parts@1")) return null;
  const bytes = await host.parts.read(path);
  return bytes ? decoder.decode(bytes) : null;
}

/** THE reader: a frame's web source as every surface (panel, render, flow,
 *  bake) sees it, or `null` when the frame is not a web frame (or its
 *  pointer names a part this document does not carry). */
export async function loadWebSource(
  host: PersistHost,
  id: ElementId,
): Promise<WebFrameSource | null> {
  const label = (await host.document.getMetadata(id)) as WebSourceEnvelope | null;
  const ref = sourceRefOf(label);
  if (ref) {
    const text = await readPartText(host, sourcePartPath(ref));
    return text === null ? null : sourceFromPartText(text, ref);
  }
  const inline = sourceFromEnvelope(label);
  if (inline && hasNoLegacyPart(label)) return inline;
  const legacyPath = legacyPartPath(id);
  const legacyText = legacyPath ? await readPartText(host, legacyPath) : null;
  if (legacyText !== null && (!inline || utf8Length(legacyText) > LABEL_INLINE_MAX_BYTES)) {
    try {
      const legacy = sourceFromEnvelope(JSON.parse(legacyText) as WebSourceEnvelope);
      if (legacy) return legacy;
    } catch {
      // a corrupt legacy part reads as absent
    }
  }
  return inline;
}

/** A frame's web label as text — what names its source (inline, or a
 *  pointer by content hash) — or `null` when the frame is not a web frame.
 *  For change detection (auto-render.ts); the source itself is read with
 *  {@link loadWebSource}. */
export async function readWebLabel(host: PersistHost, id: ElementId): Promise<string | null> {
  const label = (await host.document.getMetadata(id)) as WebSourceEnvelope | null;
  return label && isWebFrameEnvelope(label) ? JSON.stringify(label) : null;
}

/** A readable reason from a refused mutation's `error` (any shape). */
export function describeRefusal(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return error;
  if (error && typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return "the document refused the change";
}

/** The outcome of a source write. `reason` is set when it was refused. */
export interface WriteOutcome {
  applied: boolean;
  reason?: string;
}

/** Prepare a source for a label write: writes the content-addressed part
 *  first when the source is too large for a label, and answers the label
 *  envelope to set — or a refusal when it cannot be stored. Used directly
 *  by the insert batch (which sets the label itself). */
export async function prepareSourceLabel(
  host: PersistHost,
  source: WebFrameSource,
): Promise<{ label: WebSourceEnvelope } | { refused: string }> {
  const stored = storeSource(source);
  if (stored.kind === "inline") return { label: stored.label };
  const kib = Math.ceil(stored.ref.bytes / 1024);
  if (!host.supports("storage.parts@1")) {
    return {
      refused:
        `the web source is ${kib} KiB; a document label holds at most 64 KiB ` +
        "and this host has no container parts to store it in",
    };
  }
  try {
    const path = sourcePartPath(stored.ref);
    await host.parts.write(path, new TextEncoder().encode(stored.partText));
    partsWrittenThisSession(host).add(path);
  } catch (err) {
    return { refused: `the web source (${kib} KiB) could not be stored: ${String(err)}` };
  }
  return { label: stored.label };
}

/** THE writer: persist a source for a frame — one undoable label write
 *  (inline, or a pointer to a part written just before). */
export async function writeWebSource(
  host: PersistHost,
  id: ElementId,
  source: WebFrameSource,
): Promise<WriteOutcome> {
  const prepared = await prepareSourceLabel(host, source);
  if ("refused" in prepared) return { applied: false, reason: prepared.refused };
  const outcome = await host.document.setMetadata(id, prepared.label);
  return outcome.applied
    ? { applied: true }
    : { applied: false, reason: describeRefusal(outcome.error) };
}

/** A source write PLANNED, not applied — what the object model (ADR 323)
 *  hands the object registry, which commits the label inside ONE engine
 *  batch with everything else the batch carries. `parts` are the
 *  content-addressed parts the label points at (empty for an inline
 *  source); the registry writes them first, and they are recorded as
 *  written this session so the collector keeps every state an undo can
 *  return to. */
export interface PlannedSourceWrite {
  /** The label value (`JSON.stringify` of the envelope). */
  labelValue: string;
  parts: PartChange[];
}

export function planSourceWrite(
  host: PersistHost,
  source: WebFrameSource,
): PlannedSourceWrite | { refused: string } {
  const stored = storeSource(source);
  if (stored.kind === "inline") return { labelValue: JSON.stringify(stored.label), parts: [] };
  if (!host.supports("storage.parts@1")) {
    const kib = Math.ceil(stored.ref.bytes / 1024);
    return {
      refused:
        `the web source is ${kib} KiB; a document label holds at most 64 KiB ` +
        "and this host has no container parts to store it in",
    };
  }
  const path = sourcePartPath(stored.ref);
  partsWrittenThisSession(host).add(path);
  return {
    labelValue: JSON.stringify(stored.label),
    parts: [{ path, bytes: new TextEncoder().encode(stored.partText) }],
  };
}

// ------------------------------------------------- document values

/** The document's own value map for templates (`{{doc.<key>}}`): one object
 *  of strings in this plugin's DOCUMENT metadata (`document.documentMetadata@1`,
 *  envelope `{ v: 1, data: { documentValues } }`) — one undoable step per
 *  write, a document change every reader sees, kept by `.paged` and `.idml`.
 *  It is the document's Label, not a frame's: frame sources live on the
 *  frames' own labels under the same key, so the two never meet.
 *
 *  Before the door existed the map was a container part (not undoable, no
 *  change event). That part is read only while the document has no metadata
 *  for this plugin — a one-time migration: the first write carries its values
 *  into the metadata, and from then on the part is never read. The part
 *  itself is dropped by the collector (parts-gc.ts) on the save of a later
 *  session — one that opened the document already migrated, so no undo can
 *  return to the part. A host without the door keeps using the part. */
export const DOCUMENT_VALUES_PART = "web/document-values.json";

/** The version of this plugin's document metadata envelope. */
export const DOCUMENT_METADATA_VERSION = 1;

/** This plugin's metadata key — the host derives the same (`x-paged:<id>`). */
const LABEL_KEY = "x-paged:media.paged.web";
const PLUGIN_ID = "media.paged.web";

/** A valid document-value key (`{{doc.<key>}}`). */
export const DOCUMENT_VALUE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function hasDocumentMetadata(host: PersistHost): boolean {
  return host.supports("document.documentMetadata@1");
}

/** The valid entries of a stored value map (names a template can write,
 *  string or number values). */
function valueMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (DOCUMENT_VALUE_KEY.test(k) && (typeof v === "string" || typeof v === "number")) {
      out[k] = String(v);
    }
  }
  return out;
}

/** This plugin's document metadata envelope, or `null` (none yet, an older
 *  engine, or a read that failed). */
async function readDocumentEnvelope(host: PersistHost): Promise<PluginMetadataEnvelope | null> {
  try {
    return await host.document.getDocumentMetadata();
  } catch {
    return null;
  }
}

/** The value map the old container part holds (empty when absent or
 *  unreadable). */
async function readValuesPart(host: PersistHost): Promise<Record<string, string>> {
  const text = await readPartText(host, DOCUMENT_VALUES_PART).catch(() => null);
  if (!text) return {};
  try {
    return valueMap(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Read the document value map (empty when absent or unreadable). */
export async function readDocumentValues(host: PersistHost): Promise<Record<string, string>> {
  if (hasDocumentMetadata(host)) {
    const envelope = await readDocumentEnvelope(host);
    if (envelope) return valueMap(envelope.data?.documentValues);
  }
  return readValuesPart(host);
}

/** Whether the document has moved its values out of the old part: the
 *  host has the metadata door and this plugin's document metadata carries a
 *  value map, so {@link readDocumentValues} never reads the part. Only an
 *  undo of the write that created the metadata could make the part read
 *  again — so the collector (parts-gc.ts) drops the part only when this
 *  held when the document was opened and still holds at the save. */
export async function documentValuesMigrated(host: PersistHost): Promise<boolean> {
  if (!hasDocumentMetadata(host)) return false;
  const values = (await readDocumentEnvelope(host))?.data?.documentValues;
  return !!values && typeof values === "object" && !Array.isArray(values);
}

/** The document-metadata write that stores `values` — one mutation, for the
 *  object model (ADR 323) to commit inside its batch. The same envelope
 *  {@link writeDocumentValues} writes: the current one with its
 *  `documentValues` replaced, so other data in it is kept. */
export async function documentValuesMutation(
  host: PersistHost,
  values: Record<string, string>,
): Promise<MutationInput> {
  const current = await readDocumentEnvelope(host);
  const envelope: PluginMetadataEnvelope = {
    ...current,
    v: DOCUMENT_METADATA_VERSION,
    data: { ...current?.data, documentValues: values },
  };
  return {
    op: "setDocumentMetadata",
    args: { key: LABEL_KEY, value: JSON.stringify(envelope), caller: PLUGIN_ID },
  } as MutationInput;
}

/** Write the document value map: one undoable document-metadata write, or —
 *  on a host without that door — the container part. Refused (with the
 *  reason) when neither is available. */
export async function writeDocumentValues(
  host: PersistHost,
  values: Record<string, string>,
): Promise<WriteOutcome> {
  if (hasDocumentMetadata(host)) {
    const current = await readDocumentEnvelope(host);
    const envelope: PluginMetadataEnvelope = {
      ...current,
      v: DOCUMENT_METADATA_VERSION,
      data: { ...current?.data, documentValues: values },
    };
    try {
      const outcome = await host.document.setDocumentMetadata(envelope);
      return outcome.applied
        ? { applied: true }
        : { applied: false, reason: describeRefusal(outcome.error) };
    } catch (err) {
      return { applied: false, reason: describeRefusal(err) };
    }
  }
  if (!host.supports("storage.parts@1")) {
    return { applied: false, reason: "this host has no container parts to keep document values in" };
  }
  try {
    await host.parts.write(DOCUMENT_VALUES_PART, new TextEncoder().encode(JSON.stringify(values)));
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: describeRefusal(err) };
  }
}

/** Whether a document-value write raises a document change by itself (the
 *  metadata door). A part write does not: the writer then re-renders. */
export function documentValuesNotify(host: PersistHost): boolean {
  return hasDocumentMetadata(host);
}

// ------------------------------------------------------- source resources

/** Where a source's sub-resources (images, stylesheets, font files) live in
 *  the container: `resources/<path as the source writes it>`. Parts are this
 *  plugin's namespace; a source's relative URL `img/a.png` is the part
 *  `resources/img/a.png`. */
export const RESOURCE_PREFIX = "resources/";

/** The bytes of a source resource the container carries, or `null` (no
 *  parts door, or no such part). The one other part reader: resources are
 *  not sources, and never the label's truth. */
export async function readResourcePart(
  host: Pick<BundleHost, "supports" | "parts">,
  path: string,
): Promise<Uint8Array | null> {
  if (!host.supports("storage.parts@1")) return null;
  try {
    return await host.parts.read(RESOURCE_PREFIX + path);
  } catch {
    return null;
  }
}

/** Store a source resource in the container (`resources/<path>`). Parts are
 *  not undoable; a resource is content the source points at, like a linked
 *  image file. Answers whether it was written. */
export async function writeResourcePart(
  host: Pick<BundleHost, "supports" | "parts">,
  path: string,
  bytes: Uint8Array,
): Promise<boolean> {
  if (!host.supports("storage.parts@1")) return false;
  try {
    await host.parts.write(RESOURCE_PREFIX + path, bytes);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- baked faces

/** Where the faces a bake gave the document are kept (ADR 414): one
 *  content-addressed part per face, `faces/<hash>.json`, holding its family,
 *  its style and its bytes. A document face lives as long as the document it
 *  was given to and is never saved with it, while the baked text naming it
 *  is; the part is what gives it back when the document opens again. Never
 *  overwritten (the path is the hash of the text); the ones no text names
 *  are dropped on save by parts-gc.ts. */
export const FACE_PREFIX = "faces/";
export const FACE_PART = /^faces\/([0-9a-f]{16})\.json$/;

/** A face a bake gave the document. `style` is absent for a face without
 *  one (the bundled face, a weight range). */
export interface KeptFace {
  family: string;
  style?: string;
  bytes: Uint8Array;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** The family and style of every face part read, by path: the parts are
 *  content-addressed, so what a path holds never changes. */
const faceHeads = new WeakMap<object, Map<string, { family: string; style?: string }>>();

function faceHeadCache(host: object): Map<string, { family: string; style?: string }> {
  let cache = faceHeads.get(host);
  if (!cache) {
    cache = new Map();
    faceHeads.set(host, cache);
  }
  return cache;
}

/** Keep a face the bake gave the document. Writes nothing when the document
 *  already keeps it. Answers whether the document keeps it now. */
export async function keepFace(host: Pick<BundleHost, "supports" | "parts">, face: KeptFace): Promise<boolean> {
  if (!host.supports("storage.parts@1")) return false;
  const text = JSON.stringify({ v: 1, family: face.family, style: face.style ?? null, face: toBase64(face.bytes) });
  const path = `${FACE_PREFIX}${contentHash(text)}.json`;
  // Kept this session whether written now or before: the collector leaves it.
  partsWrittenThisSession(host).add(path);
  try {
    if ((await host.parts.list(path)).includes(path)) return true;
    await host.parts.write(path, new TextEncoder().encode(text));
    faceHeadCache(host).set(path, { family: face.family, ...(face.style ? { style: face.style } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** The paths of the face parts the document carries. */
export async function keptFacePaths(host: Pick<BundleHost, "supports" | "parts">): Promise<string[]> {
  if (!host.supports("storage.parts@1")) return [];
  try {
    return (await host.parts.list(FACE_PREFIX)).filter((p) => FACE_PART.test(p));
  } catch {
    return [];
  }
}

/** A kept face, or `null` when the part is gone or unreadable. */
export async function readKeptFace(
  host: Pick<BundleHost, "supports" | "parts">,
  path: string,
): Promise<KeptFace | null> {
  if (!host.supports("storage.parts@1")) return null;
  try {
    const bytes = await host.parts.read(path);
    if (!bytes) return null;
    const rec = JSON.parse(decoder.decode(bytes)) as { v?: unknown; family?: unknown; style?: unknown; face?: unknown };
    if (rec.v !== 1 || typeof rec.family !== "string" || !rec.family || typeof rec.face !== "string") return null;
    const style = typeof rec.style === "string" && rec.style ? rec.style : undefined;
    faceHeadCache(host).set(path, { family: rec.family, ...(style ? { style } : {}) });
    return { family: rec.family, ...(style ? { style } : {}), bytes: fromBase64(rec.face) };
  } catch {
    return null;
  }
}

/** The family a face part keeps a face for (read once per path), or `null`
 *  when the part is unreadable. */
export async function keptFaceFamily(
  host: Pick<BundleHost, "supports" | "parts">,
  path: string,
): Promise<string | null> {
  const cached = faceHeadCache(host).get(path);
  if (cached) return cached.family;
  return (await readKeptFace(host, path))?.family ?? null;
}

