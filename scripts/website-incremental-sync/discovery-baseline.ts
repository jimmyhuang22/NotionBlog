import { isFullPage, type PageObjectResponse } from "@notionhq/client";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../../contracts/website-sync.ts";
import type { PublicationState } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson, configDigest, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { contentCacheBaselineDigest, type ContentCacheBaseline, type ContentCacheBaselineProof } from "./content-cache.ts";
import { directoryPageMember } from "./discovery.ts";
import type { DirectoryBaselineSeed, DirectoryMember, IncrementalQueue } from "./queue.ts";

export class DiscoveryBaselineError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "DiscoveryBaselineError"; this.code = code; }
}
const fail = (code = "DISCOVERY_BASELINE_INVALID"): never => { throw new DiscoveryBaselineError(code); };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const recordsDigest = (records: WebsiteRecord[]) => configDigest([...records].sort((a, b) => a.detail.item.id.localeCompare(b.detail.item.id)));
type Observation = { plain: DirectoryMember; cover: DirectoryMember; usable: boolean };
/** Private companion to the same full collection, not a public DTO or a
 * publication proof. Missing/ambiguous metadata must be discovered normally. */
export interface DirectoryBaselineCapture {
  format: "directory-baseline-v1";
  configDigest: string;
  recordsDigest: string;
  sources: DirectoryBaselineSeed["sources"];
  skipped: number;
}

/** Observe the collector's existing calls. No extra source requests, body
 * traversal, raw metadata persistence, media downloads or SQL operations. */
export function captureDirectoryMetadata(client: NotionReadClient, config: WebsiteNotionConfig) {
  const scope = configDigest(config), observed = new Map<string, Observation | null>();
  let sealed = false;
  const guard = () => { if (sealed) fail("DISCOVERY_CAPTURE_SEALED"); };
  const remember = (id: string, page: PageObjectResponse | null) => {
    const key = normalizeId(id);
    if (!observed.has(key) && observed.size >= 20_000) fail("DISCOVERY_CAPTURE_LIMIT_EXCEEDED");
    if (!page || !isFullPage(page) || normalizeId(page.id) !== key) { observed.set(key, null); return; }
    let next: Observation;
    try {
      next = { plain: directoryPageMember(page, false), cover: directoryPageMember(page, true),
        usable: !page.archived && !page.in_trash && !page.is_archived };
    } catch { observed.set(key, null); return; }
    const old = observed.get(key);
    if (observed.has(key) && (!old || canonicalJson(old) !== canonicalJson(next))) next.usable = false;
    observed.set(key, next);
  };
  const wrapped: NotionReadClient = {
    async getPage(id) { guard(); const page = await client.getPage(id); guard(); remember(id, page); return page; },
    getDataSource: id => client.getDataSource(id),
    getBlock: id => client.getBlock(id),
    listBlocks: id => client.listBlocks(id),
    ...(client.getDatabase ? { getDatabase: (id: string) => client.getDatabase!(id) } : {}),
    ...(client.listPages ? { listPages: async (id: string) => {
      guard(); const pages = await client.listPages!(id); guard();
      for (const page of pages) remember(page.id, page);
      return pages;
    } } : {}),
  };
  return {
    client: wrapped,
    seal(records: WebsiteRecord[]): DirectoryBaselineCapture {
      guard();
      if (configDigest(config) !== scope) fail("DISCOVERY_BASELINE_SCOPE_MISMATCH");
      if (!Array.isArray(records) || records.length > 20_000) fail();
      const sources = config.sources.map(s => ({ sourceKey: s.key, members: [] as DirectoryMember[] }));
      const seen = new Set<string>(); let skipped = 0;
      for (const record of records) {
        validateWebsiteRecord(record);
        const id = record.detail.item.id, source = config.sources.find(s => s.key === record.evidence.sourceKey) ?? fail();
        if (seen.has(id) || source.kind !== record.detail.item.kind || normalizeId(id) !== id) fail();
        seen.add(id);
        const observation = observed.get(id), member = source.cover.strategy === "native-page-cover" ? observation?.cover : observation?.plain;
        if (!observation?.usable || !member || !record.detail.item.updatedAt || Date.parse(record.detail.item.updatedAt) !== member.lastEditedAt) { skipped++; continue; }
        sources.find(s => s.sourceKey === source.key)!.members.push({ ...member });
      }
      sealed = true;
      const capture: DirectoryBaselineCapture = { format: "directory-baseline-v1", configDigest: scope, recordsDigest: recordsDigest(records), sources, skipped };
      observed.clear();
      return capture;
    },
  };
}

/** Called only after the independent full-content reader proves the same
 * collection. No first-scan watermark, queue acknowledgement or publication. */
export function initializeDirectoryBaseline(input: {
  queue: IncrementalQueue; config: WebsiteNotionConfig; capture: DirectoryBaselineCapture;
  baseline: ContentCacheBaseline; proof: ContentCacheBaselineProof; currentState: PublicationState;
}) {
  const { queue, config, capture, baseline, proof, currentState } = input;
  const scope = configDigest(config);
  if (queue.scopeDigest !== scope || capture?.configDigest !== scope || baseline?.state?.configDigest !== scope) fail("DISCOVERY_BASELINE_SCOPE_MISMATCH");
  const state = baseline.state;
  if (!state || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[0-9]+$/.test(state.publicationRevision) ||
    state.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !/^[0-9]+$/.test(state.policyEpoch) ||
    !proof || proof.readerVerified !== true || proof.complete !== true ||
    [proof, currentState].some(p => !p || p.publicationRevision !== state.publicationRevision || p.configDigest !== scope ||
      p.schemaDigest !== state.schemaDigest || p.policyEpoch !== state.policyEpoch)) fail("DISCOVERY_BASELINE_READER_UNVERIFIED");
  if (!Array.isArray(baseline.records) || baseline.records.length > 20_000 || !Array.isArray(baseline.media) || baseline.media.length > 20_000 ||
    proof.records !== baseline.records.length || proof.media !== baseline.media.length || !hash(proof.contentDigest) ||
    contentCacheBaselineDigest(baseline) !== proof.contentDigest) fail("DISCOVERY_BASELINE_READER_UNVERIFIED");
  if (capture.format !== "directory-baseline-v1" || capture.recordsDigest !== recordsDigest(baseline.records) ||
    !Array.isArray(capture.sources) || capture.sources.length !== config.sources.length ||
    new Set(capture.sources.map(s => s.sourceKey)).size !== config.sources.length ||
    !Number.isSafeInteger(capture.skipped) || capture.skipped < 0) fail();
  const records = new Map<string, WebsiteRecord>();
  for (const record of baseline.records) {
    validateWebsiteRecord(record);
    const source = config.sources.find(s => s.key === record.evidence.sourceKey), id = record.detail.item.id;
    if (records.has(id) || !source || source.kind !== record.detail.item.kind || normalizeId(id) !== id || !record.detail.document) fail();
    records.set(id, record);
  }
  const seen = new Set<string>();
  for (const source of capture.sources) {
    if (!config.sources.some(s => s.key === source.sourceKey) || !Array.isArray(source.members) || source.members.length > records.size) fail();
    for (const member of source.members) {
      const record = records.get(member.pageKey);
      if (seen.has(member.pageKey) || !record || record.evidence.sourceKey !== source.sourceKey || !hash(member.fingerprint) ||
        !Number.isSafeInteger(member.lastEditedAt) || member.lastEditedAt < 0 ||
        !record.detail.item.updatedAt || Date.parse(record.detail.item.updatedAt) !== member.lastEditedAt) fail();
      seen.add(member.pageKey);
    }
  }
  if (seen.size + capture.skipped !== records.size) fail();
  return queue.seedDirectoryBaseline({ baselineDigest: configDigest({ state, contentDigest: proof.contentDigest, recordsDigest: capture.recordsDigest }), sources: capture.sources });
}
