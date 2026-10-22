import type { ContentKind } from "../../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { readPublicationState, type PublicationState } from "../../src/server/database/incremental-publication.ts";
import { readPublishedRecord, type PublishedRecord, type PublishedRecordQuery } from "../../src/server/database/incremental-reader.ts";
import { publicationReader } from "../../src/server/database/publication.ts";
import { callSql, type SqlExecutor } from "../../src/server/database/sql.ts";
import { canonicalJson, validateMedia, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { contentCacheBaselineDigest, type ContentCacheBaseline, type ContentCacheStore } from "./content-cache.ts";

// Read every supported kind, including kinds absent from the supplied artifact.
// A caller-selected subset or a scrubbed DTO cannot prove complete membership.
const KINDS: ContentKind[] = ["post", "status", "album", "book", "movie", "game", "course", "study-note", "project", "page"];
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sorted = (ids: readonly string[]) => [...ids].sort();

export class ContentBaselineError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ContentBaselineError"; this.code = code; }
}
function fail(code: string): never { throw new ContentBaselineError(code); }
export interface ContentBaselineInventory {
  publicationRevision: string; schemaDigest: string; pageIds: string[]; mediaIds: string[]; readerVerified: true;
}
export interface ContentBaselineReader {
  state(signal: AbortSignal): Promise<PublicationState>;
  inventory(expectedRevision: string, signal: AbortSignal): Promise<ContentBaselineInventory>;
  read(input: PublishedRecordQuery, signal: AbortSignal): Promise<PublishedRecord | null>;
}
export interface ContentBaselineOptions {
  /** Records and descriptors from the SAME accepted full collection, never a second crawl. */
  baseline: ContentCacheBaseline;
  fullRunId: string;
  store: ContentCacheStore;
  /** The host obtains this connection from the verified independent reader binding. */
  reader: ContentBaselineReader;
  maxReads?: number;
}

/** Fixed, existing reader capabilities. Membership does not use the website's
 * compact projection, which deliberately removes unreferenced media IDs. Raw
 * private per-page reads prove content and descriptors, not merely DTOs. */
export function createDatabaseContentBaselineReader(reader: SqlExecutor): ContentBaselineReader {
  const published = publicationReader(reader, "published");
  return {
    async state(signal) {
      signal.throwIfAborted(); const state = await readPublicationState(reader); signal.throwIfAborted(); return state;
    },
    async inventory(expectedRevision, signal) {
      signal.throwIfAborted();
      const value = await callSql<{ runId: string; revision: string; schemaDigest: string;
        records: { item: { id: string; kind: ContentKind } }[]; links: string[]; mediaIds: string[] }>(published,
        "SELECT nb_v2_api.read_snapshot($1::text[],$2) AS result", [KINDS, false]);
      signal.throwIfAborted();
      try {
        if (!value || Object.keys(value).length !== 6 || `${value.runId}:${value.revision}` !== expectedRevision ||
          value.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !Array.isArray(value.records) || value.records.length > 20000 ||
          !Array.isArray(value.mediaIds) || value.mediaIds.length > 20000 || !Array.isArray(value.links) || value.links.length > 20000 ||
          Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024 ||
          value.records.some(r => !r?.item || typeof r.item.id !== "string" || !KINDS.includes(r.item.kind))) throw Error();
        const pageIds = value.records.map(r => r.item.id);
        if (new Set(pageIds).size !== pageIds.length || new Set(value.mediaIds).size !== value.mediaIds.length ||
          value.mediaIds.some(id => typeof id !== "string" || !/^a1\.[a-f0-9]{64}$/.test(id))) throw Error();
        return { publicationRevision: expectedRevision, schemaDigest: value.schemaDigest, pageIds,
          mediaIds: value.mediaIds, readerVerified: true };
      } catch { fail("CONTENT_BASELINE_INVENTORY_INVALID"); }
    },
    read: (input, signal) => readPublishedRecord(reader, input, signal),
  };
}

/** Baseline-only complete independent read and final unchanged state check.
 * No Source calls, object reads, SQL/store writes, queue acknowledgements or
 * scheduler changes. The caller installs the returned proof separately. */
export async function readContentBaselineProof(options: ContentBaselineOptions, signal: AbortSignal) {
  signal.throwIfAborted();
  let baseline: ContentCacheBaseline;
  const maximum = options.maxReads ?? 2000;
  try {
    if (!uuid(options.fullRunId) || !Number.isInteger(maximum) || maximum < 1 || maximum > 20000 ||
      !options.baseline || !Array.isArray(options.baseline.records) || !Array.isArray(options.baseline.media) ||
      options.baseline.records.length > maximum || options.baseline.media.length > 20000 ||
      Buffer.byteLength(JSON.stringify(options.baseline)) > 32 * 1024 * 1024) fail("CONTENT_BASELINE_BUDGET_EXCEEDED");
    // Freeze caller-owned input before asynchronous reader calls.
    baseline = structuredClone(options.baseline);
    const { state } = baseline;
    if (!state || Object.keys(state).length !== 4 || state.configDigest !== options.store.sourceDigest ||
      state.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !/^[a-f0-9]{64}$/.test(state.configDigest) ||
      !/^[0-9]+$/.test(state.policyEpoch) || typeof state.publicationRevision !== "string" ||
      !state.publicationRevision.startsWith(`${options.fullRunId}:`) ||
      !/^[0-9]+$/.test(state.publicationRevision.slice(options.fullRunId.length + 1))) fail("CONTENT_BASELINE_SCOPE_MISMATCH");
    const owners = new Set<string>(), assets = new Set<string>();
    for (const record of baseline.records) {
      validateWebsiteRecord(record);
      if (!record.detail.document || owners.has(record.detail.item.id)) fail("CONTENT_BASELINE_INVALID");
      owners.add(record.detail.item.id);
    }
    for (const media of baseline.media) {
      validateMedia(media);
      if (assets.has(media.assetId) || !owners.has(media.ownerPageId)) fail("CONTENT_BASELINE_INVALID");
      assets.add(media.assetId);
    }
  } catch (error) {
    if (error instanceof ContentBaselineError) throw error;
    fail("CONTENT_BASELINE_INVALID");
  }
  const { reader, store } = options, expected = baseline.state.publicationRevision;
  const before = await reader.state(signal); signal.throwIfAborted();
  if (!same(before, baseline.state)) fail("CONTENT_BASELINE_PUBLICATION_CHANGED");
  const inventory = await reader.inventory(expected, signal); signal.throwIfAborted();
  if (!inventory || inventory.readerVerified !== true || inventory.publicationRevision !== expected ||
    inventory.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !Array.isArray(inventory.pageIds) || !Array.isArray(inventory.mediaIds) ||
    inventory.pageIds.length > 20000 || inventory.mediaIds.length > 20000 ||
    new Set(inventory.pageIds).size !== inventory.pageIds.length || new Set(inventory.mediaIds).size !== inventory.mediaIds.length ||
    !same(sorted(inventory.pageIds), sorted(baseline.records.map(r => r.detail.item.id))) ||
    !same(sorted(inventory.mediaIds), sorted(baseline.media.map(m => m.assetId)))) fail("CONTENT_BASELINE_INVENTORY_MISMATCH");
  const owned = new Map<string, ContentCacheBaseline["media"]>();
  for (const media of baseline.media) {
    const group = owned.get(media.ownerPageId) ?? []; group.push(media); owned.set(media.ownerPageId, group);
  }
  let reads = 0;
  for (const record of baseline.records) {
    signal.throwIfAborted();
    const actual = await reader.read({ pageId: record.detail.item.id, sourceKey: record.evidence.sourceKey, expectedRevision: expected }, signal);
    signal.throwIfAborted(); reads++;
    if (!actual || actual.readerVerified !== true || actual.publicationRevision !== expected ||
      actual.schemaDigest !== baseline.state.schemaDigest || actual.configDigest !== baseline.state.configDigest ||
      !same(actual.record, record) || !Array.isArray(actual.media) ||
      !same([...actual.media].sort((a, b) => a.assetId.localeCompare(b.assetId)),
        [...(owned.get(record.detail.item.id) ?? [])].sort((a, b) => a.assetId.localeCompare(b.assetId)))) fail("CONTENT_BASELINE_READER_MISMATCH");
  }
  const after = await reader.state(signal); signal.throwIfAborted();
  if (!same(before, after)) fail("CONTENT_BASELINE_PUBLICATION_CHANGED");
  const contentDigest = contentCacheBaselineDigest(baseline);
  return { baseline, reads, proof: { ...after, readerVerified: true as const, complete: true as const,
    records: baseline.records.length, media: baseline.media.length, contentDigest } };
}

export async function initializeContentBaseline(options: ContentBaselineOptions, signal: AbortSignal) {
  const { baseline, reads, proof } = await readContentBaselineProof(options, signal);
  signal.throwIfAborted(); options.store.initialize(baseline, proof);
  return { publicationRevision: proof.publicationRevision, records: proof.records, media: proof.media, reads, contentDigest: proof.contentDigest };
}
