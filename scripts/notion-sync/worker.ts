import { createHash, randomUUID } from "node:crypto";
import type { ContentBlock, ImageAsset } from "../../contracts/content.ts";
import type { PublicationReceipt, RunLease, StoredMedia, SyncWriter } from "../../contracts/sync.ts";
import { SYNC_PROTOCOL, SYNC_SCHEMA_DIGEST } from "../../contracts/sync.ts";
import type { ObjectStorage } from "../../src/server/database/storage.ts";
import { verifyMediaBytes } from "../../src/server/database/storage.ts";
import { configDigest, mediaIdentity, validateMedia, validateSyncRecord } from "../../src/server/database/validation.ts";
import { parseNotionSourcesConfig, normalizeId } from "../../src/server/notion/config.ts";
import { createNotionRepository } from "../../src/server/notion/repository.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { planCollection, evidence } from "./collect.ts";
import { createImageDownloader, type DownloadedImage } from "./download.ts";
import { WorkerError, checkSignal } from "./errors.ts";
import { sourceFingerprint, validateMediaSource, type MediaSourceBinding } from "../../src/server/media/notion-source.ts";

export type SyncMode = "dry-run" | "stage" | "publish";
export interface RunReport {
  protocol: string; schemaDigest: string; runId: string; mode: SyncMode;
  outcome: "dry-run" | "staged" | "published";
  sample?: true;
  records: number; media: number; uniqueObjects: number; mediaBytes: number;
  confirmedAbsent: number; excluded: number; partialDocuments: number;
  metadataReads: number; bodyReads: number; elapsedMs: number; peakRssBytes: number;
}
export interface WorkerOptions {
  client: NotionReadClient; config: unknown; mode: SyncMode;
  writer?: SyncWriter; storage?: ObjectStorage;
  /** Opt-in hybrid delivery. Ordinary originals stay at their source; converted images are stored. */
  mediaSources?: { stage(lease: RunLease, bindings: MediaSourceBinding[]): Promise<void> };
  download?: (url: string, signal?: AbortSignal) => Promise<DownloadedImage>;
  signal?: AbortSignal; runId?: string;
  /** Manual acceptance only: never publish a subset or emit removal evidence. */
  stagePageIds?: string[];
  leaseSeconds?: number; renewEveryMs?: number; maxRecords?: number;
  maxAssets?: number; maxMediaBytes?: number;
  checkpoint?: (lease: RunLease, report: RunReport) => Promise<void>;
}

function assertTraversal(blocks: ContentBlock[]): void {
  for (const block of blocks) {
    if (block.type === "unsupported") {
      if (["Content block limit reached", "Content nesting limit reached"].includes(block.label)) throw new WorkerError("LIMIT_EXCEEDED");
      if (["Content belongs to a different parent", "Repeated content block omitted"].includes(block.label)) throw new WorkerError("SCOPE_INCOMPLETE");
    }
    if (block.type === "list") for (const item of block.items) assertTraversal(item.children);
    else if (block.type === "columns") for (const column of block.columns) assertTraversal(column.blocks);
    else if (block.type === "toggle" || block.type === "callout") assertTraversal(block.children);
  }
}

/** Full reconcile on every invocation; last_edited_time is never an incremental gate. */
export async function runSync(options: WorkerOptions): Promise<RunReport> {
  const started = Date.now(), runId = options.runId ?? randomUUID();
  const config = parseNotionSourcesConfig(options.config), digest = configDigest(config);
  if (!["dry-run", "stage", "publish"].includes(options.mode) ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(runId)) throw new WorkerError("MISCONFIGURED");
  if (options.mode !== "dry-run" && (!options.writer || !options.storage)) throw new WorkerError("MISCONFIGURED");
  const leaseSeconds = options.leaseSeconds ?? 300;
  const renewEveryMs = options.renewEveryMs ?? 30_000;
  const maxRecords = options.maxRecords ?? 10_000;
  const maxAssets = options.maxAssets ?? 20_000, maxMediaBytes = options.maxMediaBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900 ||
      !Number.isSafeInteger(renewEveryMs) || renewEveryMs < 1 || renewEveryMs >= leaseSeconds * 500 ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000 ||
      !Number.isSafeInteger(maxAssets) || maxAssets < 1 || maxAssets > 100_000 ||
      !Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1 || maxMediaBytes > 10 * 1024 * 1024 * 1024) throw new WorkerError("MISCONFIGURED");
  let sampleIds: Set<string> | undefined;
  if (options.stagePageIds !== undefined) {
    if (options.mode !== "stage" || !Array.isArray(options.stagePageIds) ||
        options.stagePageIds.length < 1 || options.stagePageIds.length > 100 ||
        options.stagePageIds.some(id => typeof id !== "string")) throw new WorkerError("MISCONFIGURED");
    sampleIds = new Set(options.stagePageIds.map(normalizeId));
    if (sampleIds.size !== options.stagePageIds.length) throw new WorkerError("MISCONFIGURED");
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  let lease: RunLease | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | undefined, renewalFailed = false, promoted = false;
  const verify = () => { if (renewalFailed) throw new WorkerError("LEASE_INVALID"); checkSignal(signal); };
  const stopHeartbeat = async () => { if (timer) clearInterval(timer); timer = undefined; await renewal; verify(); };
  const report: RunReport = { protocol: SYNC_PROTOCOL, schemaDigest: SYNC_SCHEMA_DIGEST, runId, mode: options.mode,
    outcome: "dry-run", records: 0, media: 0, uniqueObjects: 0, mediaBytes: 0, confirmedAbsent: 0,
    excluded: 0, partialDocuments: 0, metadataReads: 0, bodyReads: 0, elapsedMs: 0, peakRssBytes: 0 };
  const sample = () => { report.peakRssBytes = Math.max(report.peakRssBytes, process.memoryUsage().rss); };
  sample();
  try {
    verify();
    if (options.mode !== "dry-run") {
      lease = await options.writer!.begin(runId, digest, leaseSeconds);
      if (lease.runId !== runId || lease.configDigest !== digest || !/^\d+$/.test(lease.fence) ||
          !/^\d+$/.test(lease.revision) || !Array.isArray(lease.deniedPageIds)) throw new WorkerError("LEASE_INVALID");
      timer = setInterval(() => {
        if (renewal) return;
        renewal = options.writer!.renew(lease!, leaseSeconds).catch(() => {
          renewalFailed = true; controller.abort();
        }).finally(() => { renewal = undefined; });
      }, renewEveryMs);
    }
    let bodyReads = 0;
    const raw: NotionReadClient = { ...options.client,
      listBlocks: async id => {
        verify(); bodyReads++; const result = await options.client.listBlocks(id); verify();
        for (const block of result) {
          const parent = block.parent;
          if (!block.archived && !block.in_trash &&
              !((parent.type === "page_id" && normalizeId(parent.page_id) === normalizeId(id)) ||
                (parent.type === "block_id" && normalizeId(parent.block_id) === normalizeId(id)))) throw new WorkerError("SCOPE_INCOMPLETE");
        }
        return result;
      } };
    const plan = await planCollection(raw, config, lease?.deniedPageIds ?? [], signal, maxRecords);
    report.metadataReads = plan.metadataReads; report.excluded = plan.excluded; report.confirmedAbsent = sampleIds ? 0 : plan.absences.length;
    const ordered = sampleIds ? plan.ordered.filter(resolved => sampleIds.has(normalizeId(resolved.page.id))) : plan.ordered;
    if (sampleIds) {
      if (ordered.length !== sampleIds.size || ordered.some(resolved =>
        (resolved.course && !sampleIds.has(normalizeId(resolved.course.page.id))) ||
        resolved.ancestors.some(parent => !sampleIds.has(normalizeId(parent.id))))) throw new WorkerError("SCOPE_INCOMPLETE");
      report.sample = true;
    }
    const descriptors = new Map<string, StoredMedia>(), objects = new Set<string>(), storedObjects = new Set<string>();
    const downloader = options.download ?? createImageDownloader();
    let pageMedia = new Map<string, StoredMedia>(), pageSources = new Map<string, MediaSourceBinding>(), activeOwner = "";
    const repository = createNotionRepository({ client: plan.client, config: plan.config,
      registerImage: async input => {
        verify(); const owner = normalizeId(input.ownerPageId);
        if (owner !== activeOwner) throw new WorkerError("SCOPE_INCOMPLETE");
        if (input.expiryTime && (!Number.isFinite(Date.parse(input.expiryTime)) || Date.parse(input.expiryTime) <= Date.now())) throw new WorkerError("IMAGE_UNAVAILABLE");
        const downloaded = await downloader(input.url, signal); verify();
        const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
        const locator = input.blockId ? `block:${normalizeId(input.blockId)}` : input.property ? `property:${input.property}` : "cover";
        const assetId = mediaIdentity(owner, locator, sha256);
        const media: StoredMedia = { assetId, ownerPageId: owner, objectKey: `sha256/${sha256}`, sha256,
          byteSize: downloaded.bytes.length, mime: downloaded.mime, width: null, height: null };
        validateMedia(media); verifyMediaBytes(media, downloaded.bytes);
        if (options.mediaSources) {
          const binding: MediaSourceBinding = { assetId, ownerPageId: owner, sha256,
            locator: input.blockId ? { kind: "block", id: normalizeId(input.blockId) } : input.property ? { kind: "property", name: input.property } : { kind: "cover" },
            delivery: downloaded.transformed ? "storage" : "notion", sourceFingerprint: sourceFingerprint(input.url, input.expiryTime !== undefined) };
          validateMediaSource(binding, media); pageSources.set(assetId, binding);
        }
        if ((!descriptors.has(assetId) && descriptors.size >= maxAssets) ||
            (!objects.has(media.objectKey) && report.mediaBytes + media.byteSize > maxMediaBytes)) throw new WorkerError("LIMIT_EXCEEDED");
        // Bytes do not accumulate across pages. Only small descriptors survive.
        if ((!options.mediaSources || downloaded.transformed) && !storedObjects.has(media.objectKey) && options.mode !== "dry-run") {
          await options.storage!.put(media, downloaded.bytes); verify(); storedObjects.add(media.objectKey);
        }
        if (!objects.has(media.objectKey)) {
          objects.add(media.objectKey); report.mediaBytes += media.byteSize;
        }
        descriptors.set(assetId, media); pageMedia.set(assetId, media); sample();
        return { id: assetId, src: `/media/${assetId}`, alt: sanitizePublicText(input.alt), width: null, height: null } satisfies ImageAsset;
      } });
    for (const [ordinal, resolved] of ordered.entries()) {
      verify(); activeOwner = normalizeId(resolved.page.id); pageMedia = new Map(); pageSources = new Map();
      const detail = await repository.get(resolved.source.kind, activeOwner);
      verify();
      if (!detail?.document) throw new WorkerError("SCOPE_INCOMPLETE");
      assertTraversal(detail.document.blocks);
      // Frozen v1 accepts content routes only. Keep the course and all note ancestors;
      // the generic /study landing breadcrumb is navigation, not a content identity.
      if (detail.item.kind === "study-note") detail.item.breadcrumbs = detail.item.breadcrumbs.filter(link => link.href !== "/study");
      const record = { detail, evidence: evidence(resolved, plan, ordinal) };
      validateSyncRecord(record);
      // Stage the owner first, then at most 100 descriptors per call.
      if (options.mode !== "dry-run") {
        await options.writer!.stage(lease!, [record]); verify();
        const media = [...pageMedia.values()];
        for (let offset = 0; offset < media.length; offset += 100) {
          await options.writer!.stage(lease!, [], media.slice(offset, offset + 100)); verify();
        }
        const bindings = [...pageSources.values()];
        for (let offset = 0; offset < bindings.length; offset += 100) {
          await options.mediaSources!.stage(lease!, bindings.slice(offset, offset + 100)); verify();
        }
      }
      report.records++; if (detail.document.completeness === "partial") report.partialDocuments++;
      sample();
    }
    if (options.mode !== "dry-run" && !sampleIds) {
      for (let offset = 0; offset < plan.absences.length; offset += 100) {
        verify(); await options.writer!.stage(lease!, [], [], plan.absences.slice(offset, offset + 100));
      }
    }
    report.bodyReads = bodyReads; report.media = descriptors.size; report.uniqueObjects = objects.size;
    await stopHeartbeat();
    if (options.mode === "publish") {
      const receipt: PublicationReceipt = { records: report.records, media: report.media, complete: true, confirmedAbsent: report.confirmedAbsent };
      verify(); await options.writer!.promote(lease!, receipt); promoted = true;
      report.outcome = "published";
    } else if (options.mode === "stage") {
      // v1 has no finish-stage RPC. fail releases the lease; staged rows remain for operator inspection.
      await options.writer!.fail(lease!); report.outcome = "staged";
    }
    report.elapsedMs = Date.now() - started; sample();
    if (promoted && options.checkpoint) {
      try { await options.checkpoint(lease!, report); } catch { throw new WorkerError("CHECKPOINT_FAILED"); }
    }
    return report;
  } catch (error) {
    if (timer) clearInterval(timer);
    await renewal;
    if (lease && !promoted) await options.writer!.fail(lease).catch(() => {});
    if (renewalFailed) throw new WorkerError("LEASE_INVALID");
    throw error;
  } finally { if (timer) clearInterval(timer); controller.abort(); }
}
