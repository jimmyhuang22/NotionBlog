import type { StoredMedia } from "../../contracts/sync.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { studyOverride } from "../../src/server/notion/automatic-study.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { canonicalJson, configDigest } from "../../src/server/database/website-validation.ts";
import type { WebsiteStudyCollection } from "../../src/server/notion/website-repository.ts";
import { readCollectionCaptureForRevalidation, type CaptureIdentity } from "../website-sync/collection-capture.ts";
import { createCollectionReadSession } from "../website-sync/collection-source-proof.ts";
import { captureDirectoryMetadata } from "./discovery-baseline.ts";
import { validateStudyBaselineCollection } from "./study-baseline.ts";
import type { PreparedFullBaseline } from "./full-baseline-artifact.ts";
import { readPrivateFile } from "../notion-sync/state.ts";
import { join } from "node:path";

function fail(code: string): never { throw Object.assign(Error(code), {code}); }
/** Reuse the SAME complete capture. Only bounded ordering metadata may be read;
 * this is neither a publisher nor a second content/media collection. The normal
 * independent-reader seal and full host verification remain mandatory. */
export async function prepareCapturedBaseline(options: {
  directory: string; identity: CaptureIdentity; config: WebsiteNotionConfig; deniedPageIds: readonly string[];
  client: Pick<NotionReadClient, "getPage">; maxMetadataReads?: number;
}, signal: AbortSignal): Promise<PreparedFullBaseline> {
  signal.throwIfAborted();
  const config = structuredClone(options.config), identity = structuredClone(options.identity);
  const limit = options.maxMetadataReads ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000 || configDigest(config) !== identity.configDigest) fail("CAPTURE_BASELINE_SCOPE_INVALID");
  const denied = [...new Set(options.deniedPageIds.map(normalizeId))].sort();
  const captured = await readCollectionCaptureForRevalidation(options.directory, identity); signal.throwIfAborted();
  if (!captured.collectionComplete) fail("CAPTURE_BASELINE_INCOMPLETE");
  const index = JSON.parse(await readPrivateFile(join(options.directory, "index-private.json"), 8 * 1024 * 1024));
  const byId = new Map(captured.pages.map(page => [page.record.detail.item.id, page]));
  if (index.format !== "website-collection-capture-v1" || index.collectionComplete !== true || index.publicationEvidence !== false ||
      Object.entries(identity).some(([key, value]) => index[key] !== value) || !Array.isArray(index.order) ||
      index.order.length !== byId.size || new Set(index.order).size !== byId.size || index.order.some((id: unknown) => typeof id !== "string" || !byId.has(id))) fail("CAPTURE_BASELINE_ORDER_CHANGED");
  const pages = (index.order as string[]).map(id => byId.get(id)!);
  const records = pages.map(page => page.record);
  const rootPages = pages.filter(p => p.record.detail.item.kind === "course" || p.record.detail.item.kind === "study-note" && p.record.detail.item.parentId === null);
  if (rootPages.length > limit) fail("CAPTURE_BASELINE_METADATA_BUDGET");
  const noOtherReads = async (): Promise<never> => fail("CAPTURE_BASELINE_UNEXPECTED_READ");
  const directory = captureDirectoryMetadata({getPage: options.client.getPage.bind(options.client),
    getDataSource: noOtherReads, getBlock: noOtherReads, listBlocks: noOtherReads}, config);
  const reads = createCollectionReadSession(directory.client, () => signal.throwIfAborted());
  const overrides = new Map<string, number | null>();
  for (const page of rootPages) {
    signal.throwIfAborted();
    const id = page.record.detail.item.id, proof = page.sourceReads?.find(p => p.method === "getPage" && p.id === id);
    if (!proof) fail("CAPTURE_BASELINE_ORDERING_PROOF_MISSING");
    if (!await reads.matches([proof])) fail("CAPTURE_BASELINE_ORDERING_CHANGED");
    const current = await reads.client.getPage(id); signal.throwIfAborted();
    if (!current || normalizeId(current.id) !== id || current.archived || current.in_trash || current.is_archived) fail("CAPTURE_BASELINE_ORDERING_CHANGED");
    const source = config.sources.find(s => s.key === page.record.evidence.sourceKey);
    if (!source) fail("CAPTURE_BASELINE_SCOPE_INVALID");
    overrides.set(id, studyOverride(current, source));
  }
  const entries = records.filter(r => ["course", "study-note"].includes(r.detail.item.kind)).map(record => ({record,
    override: overrides.get(record.detail.item.id) ?? null, position: record.detail.item.kind === "course" ? null : record.evidence.ordinal}));
  const collection: WebsiteStudyCollection = {records, baseline: {format: "study-baseline-v1", sourceDigest: identity.configDigest,
    recordsDigest: configDigest(records), entriesDigest: configDigest(entries), deniedDigest: configDigest(denied),
    sourceKeys: config.sources.filter(s => ["course", "study-note"].includes(s.kind)).map(s => s.key).sort(), entries}};
  validateStudyBaselineCollection(collection, config, new Set(denied));
  const media = new Map<string, StoredMedia>();
  for (const page of pages) for (const asset of page.media) {
    const previous = media.get(asset.assetId);
    if (previous && canonicalJson(previous) !== canonicalJson(asset)) fail("CAPTURE_BASELINE_MEDIA_CONFLICT");
    media.set(asset.assetId, asset);
  }
  return {format: "incremental-prepared-baseline-v1", fullRunId: identity.runId, configDigest: identity.configDigest,
    collection, media: [...media.values()], deniedPageIds: denied, directory: directory.seal(records)};
}
