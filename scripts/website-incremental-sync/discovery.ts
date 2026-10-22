import { createHash } from "node:crypto";
import { isFullPage, type Client, type DataSourceObjectResponse, type PageObjectResponse } from "@notionhq/client";
import { normalizeId } from "../../src/server/notion/config.ts";
import { canonicalJson, configDigest } from "../../src/server/database/website-validation.ts";
import { assertWebsiteSourceSchema, type WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { IncrementalQueueError, type DirectoryMember, type DiscoveryScan, type IncrementalQueue } from "./queue.ts";

type QueryParameters = Parameters<Client["dataSources"]["query"]>[0];
type QueryResponse = Awaited<ReturnType<Client["dataSources"]["query"]>>;
export interface DirectoryNotionClient {
  getDataSource(id: string, signal: AbortSignal): Promise<DataSourceObjectResponse>;
  queryDataSource(input: QueryParameters, signal: AbortSignal): Promise<QueryResponse>;
}
export interface DirectorySource {
  scopeDigest: string;
  validate(sourceKey: string, signal: AbortSignal): Promise<void>;
  read(sourceKey: string, scan: DiscoveryScan, signal: AbortSignal): Promise<{ members: DirectoryMember[]; nextCursor: string | null; unavailablePageKeys?: string[] }>;
}
export class DirectoryDiscoveryError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "DirectoryDiscoveryError"; this.code = code; }
}
function fail(code: string): never { throw new DirectoryDiscoveryError(code); }
function guard(signal: AbortSignal) { if (signal.aborted) fail("DISCOVERY_CANCELLED"); }
function identity(value: string) { try { return normalizeId(value); } catch { return fail("DISCOVERY_RESPONSE_INVALID"); } }
function timestamp(value: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) fail("DISCOVERY_RESPONSE_INVALID");
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0) fail("DISCOVERY_RESPONSE_INVALID");
  return time;
}
function fingerprint(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
/** Hash property values without persisting them; Notion file signatures are transient. */
function stableMetadata(value: unknown, depth = 0): unknown {
  if (depth > 24) fail("DISCOVERY_RESPONSE_INVALID");
  if (Array.isArray(value)) return value.map(v => stableMetadata(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.type === "file" && object.file && typeof object.file === "object") {
    const file = object.file as { url?: unknown };
    if (typeof file.url !== "string") fail("DISCOVERY_RESPONSE_INVALID");
    let url: URL; try { url = new URL(file.url); } catch { return fail("DISCOVERY_RESPONSE_INVALID"); }
    return { ...object, file: { url: url.origin + url.pathname } };
  }
  return Object.fromEntries(Object.entries(object).map(([key, v]) => [key, stableMetadata(v, depth + 1)]));
}
export function directoryPageMember(page: PageObjectResponse, nativeCover: boolean): DirectoryMember {
  const pageKey = identity(page.id), lastEditedAt = timestamp(page.last_edited_time);
  return { pageKey, lastEditedAt, fingerprint: fingerprint(["page-metadata-v2", pageKey, lastEditedAt, page.parent,
    page.archived, page.in_trash, page.is_archived ?? false, stableMetadata(page.properties), nativeCover ? stableMetadata(page.cover) : null]) };
}

/** Metadata only. The caller supplies a budgeted, cancellable SDK transport; no token/env defaults. */
export function createNotionDirectorySource(client: DirectoryNotionClient, config: WebsiteNotionConfig, expectedDigest: string): DirectorySource {
  function source(sourceKey: string) {
    if (configDigest(config) !== expectedDigest) fail("DISCOVERY_SCOPE_CHANGED");
    const s = config.sources.find(s => s.key === sourceKey);
    if (!s?.dataSourceId || s.kind === "page" || s.publication.mode === "course-descendants") fail("DISCOVERY_SOURCE_UNSUPPORTED");
    return s;
  }
  const validate = async (sourceKey: string, signal: AbortSignal) => {
    guard(signal); const s = source(sourceKey);
    const schema = await client.getDataSource(s.dataSourceId!, signal); guard(signal);
    if (!schema || identity(schema.id) !== s.dataSourceId) fail("DISCOVERY_SCOPE_CHANGED");
    try { assertWebsiteSourceSchema(s, schema); } catch { fail("DISCOVERY_SCHEMA_INVALID"); }
  };
  return {
    scopeDigest: expectedDigest,
    validate,
    async read(sourceKey, scan, signal) {
      await validate(sourceKey, signal); const s = source(sourceKey);
      const result = await client.queryDataSource({ data_source_id: s.dataSourceId!, page_size: 100,
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        ...(scan.cursor ? { start_cursor: scan.cursor } : {}),
        // Membership must include pages edited during pagination; do not use the changes cutoff here.
        ...(scan.mode === "changes" ? { filter: { and: [
          { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(scan.since!).toISOString() } },
          { timestamp: "last_edited_time", last_edited_time: { on_or_before: new Date(scan.startedAt).toISOString() } },
        ] } } : {}),
      }, signal);
      guard(signal);
      if (!result || result.object !== "list" || !Array.isArray(result.results) || result.results.length > 100 ||
        typeof result.has_more !== "boolean" || (result.request_status !== undefined && result.request_status?.type !== "complete")) fail("DISCOVERY_RESPONSE_INCOMPLETE");
      if ((result.has_more && (typeof result.next_cursor !== "string" || !result.next_cursor)) || (!result.has_more && result.next_cursor !== null)) fail("DISCOVERY_RESPONSE_INVALID");
      const members: DirectoryMember[] = [], keys = new Set<string>();
      for (const page of result.results) {
        if (!isFullPage(page) || !page.parent || page.parent.type !== "data_source_id" || identity(page.parent.data_source_id) !== s.dataSourceId) fail("DISCOVERY_RESPONSE_INVALID");
        const pageKey = identity(page.id), lastEditedAt = timestamp(page.last_edited_time);
        if (keys.has(pageKey)) fail("DISCOVERY_RESPONSE_INVALID"); keys.add(pageKey);
        if (scan.mode === "changes" && (lastEditedAt < scan.since! || lastEditedAt > scan.startedAt)) fail("DISCOVERY_WINDOW_INVALID");
        if (s.publication.mode === "allowlist" && !s.publication.allowlistPageIds.includes(pageKey)) continue;
        members.push(directoryPageMember(page, s.cover.strategy === "native-page-cover"));
      }
      return { members, nextCursor: result.next_cursor };
    },
  };
}

export interface KnownPageCatalog {
  sourceKey: string; pageKeys: readonly string[]; configDigest: string; publicationRevision: string; readerVerified: true;
}
export interface PageProbeNotionClient {
  getPage(id: string, signal: AbortSignal): Promise<PageObjectResponse | null>;
  getDataSource(id: string, signal: AbortSignal): Promise<DataSourceObjectResponse>;
}
/** Probe already verified ordinary pages/deep learning IDs, never arbitrary webhook IDs. */
export function createKnownPageDirectorySource(client: PageProbeNotionClient, config: WebsiteNotionConfig,
  state: { configDigest: string; publicationRevision: string }, catalog: KnownPageCatalog, batchSize = 20): DirectorySource {
  if (!catalog || catalog.readerVerified !== true || catalog.configDigest !== state.configDigest || catalog.publicationRevision !== state.publicationRevision ||
    !Array.isArray(catalog.pageKeys) || catalog.pageKeys.length > 20_000 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) fail("DISCOVERY_CATALOG_INVALID");
  const keys = catalog.pageKeys.map(identity).sort();
  if (new Set(keys).size !== keys.length) fail("DISCOVERY_CATALOG_INVALID");
  if (keys.length > batchSize * 200) fail("DISCOVERY_LIMIT_EXCEEDED");
  const catalogDigest = fingerprint([state.configDigest, catalog.sourceKey, keys]);
  function source(sourceKey: string) {
    if (configDigest(config) !== state.configDigest || sourceKey !== catalog.sourceKey) fail("DISCOVERY_SCOPE_CHANGED");
    const s = config.sources.find(s => s.enabled && s.key === sourceKey);
    if (!s || (s.kind !== "page" && !(s.kind === "study-note" && s.publication.mode === "course-descendants"))) fail("DISCOVERY_SOURCE_UNSUPPORTED");
    if (s.kind === "page" && keys.some(id => id !== s.pageId || !s.publication.allowlistPageIds.includes(id))) fail("DISCOVERY_CATALOG_INVALID");
    return s;
  }
  const validate = async (sourceKey: string, signal: AbortSignal) => {
    guard(signal); const s = source(sourceKey);
    if (s.kind === "study-note") {
      const root = config.sources.find(c => c.kind === "course" && c.dataSourceId === s.dataSourceId && c.publication.mode === "all");
      if (!root?.dataSourceId) fail("DISCOVERY_SCOPE_CHANGED");
      const schema = await client.getDataSource(root.dataSourceId, signal); guard(signal);
      if (identity(schema.id) !== root.dataSourceId) fail("DISCOVERY_SCOPE_CHANGED");
      try { assertWebsiteSourceSchema(root, schema); } catch { fail("DISCOVERY_SCHEMA_INVALID"); }
    }
  };
  return {
    scopeDigest: state.configDigest, validate,
    async read(sourceKey, scan, signal) {
      await validate(sourceKey, signal); const s = source(sourceKey);
      let offset = 0;
      if (scan.cursor !== null) {
        let cursor: { digest?: unknown; offset?: unknown };
        try { cursor = JSON.parse(scan.cursor); } catch { return fail("DISCOVERY_CURSOR_INVALID"); }
        if (!cursor || Object.keys(cursor).length !== 2 || cursor.digest !== catalogDigest) fail("DISCOVERY_CATALOG_CHANGED");
        if (!Number.isInteger(cursor.offset) || Number(cursor.offset) < 1 || Number(cursor.offset) >= keys.length) fail("DISCOVERY_CURSOR_INVALID");
        offset = Number(cursor.offset);
      }
      const selected = keys.slice(offset, offset + batchSize), members: DirectoryMember[] = [], unavailablePageKeys: string[] = [];
      for (const id of selected) {
        guard(signal); const page = await client.getPage(id, signal); guard(signal);
        if (page === null) { unavailablePageKeys.push(id); continue; }
        if (!isFullPage(page) || identity(page.id) !== id || !page.parent) fail("DISCOVERY_RESPONSE_INVALID");
        members.push(directoryPageMember(page, s.cover.strategy === "native-page-cover"));
      }
      const next = offset + selected.length;
      return { members, unavailablePageKeys, nextCursor: next < keys.length ? JSON.stringify({ digest: catalogDigest, offset: next }) : null };
    },
  };
}

function bounded<T>(call: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  guard(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DirectoryDiscoveryError("DISCOVERY_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { guard(signal); return call(signal); }).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new DirectoryDiscoveryError("DISCOVERY_CANCELLED")); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
export interface DirectoryDiscoveryOptions {
  queue: IncrementalQueue; sourceKey: string; signal?: AbortSignal; now?: () => number;
  mode?: DiscoveryScan["mode"]; maxSteps?: number; maxDurationMs?: number;
  overlapMs?: number; reconcileEveryMs?: number;
}

/** Resume a scan before starting another. No body/image reads or publication operations. */
export async function runDirectoryDiscovery(options: DirectoryDiscoveryOptions, source: DirectorySource) {
  const maxSteps = options.maxSteps ?? 10, duration = options.maxDurationMs ?? 120_000;
  const overlap = options.overlapMs ?? 300_000, interval = options.reconcileEveryMs ?? 86_400_000;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200 || !Number.isInteger(duration) || duration < 10 || duration > 899_000 ||
    !Number.isInteger(overlap) || overlap < 0 || overlap > 86_400_000 || !Number.isInteger(interval) || interval < 1 || interval > 2_592_000_000 ||
    (options.mode !== undefined && options.mode !== "changes" && options.mode !== "membership")) fail("DISCOVERY_INPUT_INVALID");
  const controller = new AbortController(), cancel = () => controller.abort(), signal = controller.signal;
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, duration);
  const result = { outcome: "partial" as "partial" | "completed" | "retry" | "needs_review" | "cancelled", pages: 0, hints: 0, errorCode: null as string | null };
  try {
    guard(signal);
    if (source.scopeDigest !== options.queue.scopeDigest) fail("DISCOVERY_SCOPE_CHANGED");
    let state = options.queue.discoveryState(options.sourceKey);
    if (!state.scan) {
      await bounded(s => source.validate(options.sourceKey, s), signal);
      const now = (options.now ?? Date.now)();
      const mode = options.mode === "membership" || state.lastReconciledAt === null || now - state.lastReconciledAt >= interval ? "membership" : "changes";
      state = options.queue.beginDiscovery(options.sourceKey, state.revision, { mode, startedAt: now, overlapMs: overlap });
    }
    for (let step = 0; step < maxSteps && state.scan; step++) {
      guard(signal);
      const committed = state.scan.phase === "missing" ? options.queue.reconcileDirectoryAbsences(options.sourceKey, state.revision) :
        await (async () => {
          const page = await bounded(s => source.read(options.sourceKey, state.scan!, s), signal); guard(signal);
          const committed = options.queue.commitDirectoryPage(options.sourceKey, state.revision, page.members, page.nextCursor, page.unavailablePageKeys);
          result.pages++; return committed;
        })();
      result.hints += committed.inserted; state = committed.state;
    }
    if (!state.scan) result.outcome = "completed";
  } catch (error) {
    const code = error instanceof DirectoryDiscoveryError || error instanceof IncrementalQueueError ? error.code : "DISCOVERY_UNAVAILABLE";
    result.errorCode = signal.aborted ? "DISCOVERY_CANCELLED" : code;
    result.outcome = signal.aborted ? "cancelled" : ["DISCOVERY_SCOPE_CHANGED", "DISCOVERY_SCHEMA_INVALID", "DISCOVERY_SOURCE_UNSUPPORTED",
      "DISCOVERY_RESPONSE_INCOMPLETE", "DISCOVERY_RESPONSE_INVALID", "DISCOVERY_WINDOW_INVALID", "DISCOVERY_CURSOR_LOOP",
      "DISCOVERY_LIMIT_EXCEEDED", "DISCOVERY_CLOCK_INVALID", "DISCOVERY_CATALOG_CHANGED", "DISCOVERY_CATALOG_INVALID",
      "DISCOVERY_CURSOR_INVALID", "QUEUE_SCOPE_MISMATCH"].includes(code) ? "needs_review" : "retry";
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  return result;
}
