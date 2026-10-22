import { createHash } from "node:crypto";
import sharp from "sharp";
import type { StoredMedia } from "../../contracts/sync.ts";
import { mediaIdentity } from "../../src/server/database/validation.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import { coverOwner, validateCoverFiles, type CoverFiles, type CoverMode } from "../../src/server/social/covers.ts";
import { generateThumbnails, thumbnailEncodingRecipe } from "../media-thumbnails/encode.ts";
import { SocialSyncError } from "../social-sync/model.ts";
import { sourceDigest, validateCoverSource, type CoverSource } from "./sources.ts";

export interface CoverCache {
  read(source: CoverSource, recipe: string): Promise<CoverFiles | null>;
  previous(source: CoverSource, recipe: string): Promise<{ sourceSha256: string; files: CoverFiles } | null>;
  save(source: CoverSource, recipe: string, files: CoverFiles, bodies: ReadonlyMap<string, Uint8Array>): Promise<void>;
  bytes(media: StoredMedia): Promise<Uint8Array>;
}
export interface CoverWriter {
  refreshUnchangedCollections?(sources: CoverSource[], mode: CoverMode): Promise<string[]>;
  /** Returns the current eligible digest; null source and ineligible are distinct. */
  source(source: CoverSource, mode: CoverMode): Promise<{ sha256: string | null } | null>;
  collectionSource(source: CoverSource, mode: CoverMode): Promise<void>;
  read(source: CoverSource, mode: CoverMode): Promise<{ sourceSha256: string; files: CoverFiles } | null>;
  register(source: CoverSource, mode: CoverMode, files: CoverFiles): Promise<void>;
}
export function sourcePlan(sources: CoverSource[]) {
  if (!Array.isArray(sources) || sources.length > 20) throw new SocialSyncError("COVER_BATCH_INVALID");
  const seen = new Set<string>();
  for (const source of sources) {
    validateCoverSource(source); const key = `${source.kind}:${source.key}`;
    if (seen.has(key)) throw new SocialSyncError("COVER_BATCH_INVALID"); seen.add(key);
  }
  return { sources: sources.length, downloadable: sources.filter(s => s.url !== null).length,
    maxSourceBytes: 80 * 1024 * 1024, maxObjectOperations: 120, maxDurationMs: 180000, concurrency: 1 };
}
/** Only reviewed fixed platform image hosts, no redirects, credentials or visitor-side source requests. */
export async function downloadCover(source: CoverSource, signal: AbortSignal, request: typeof fetch = fetch): Promise<Uint8Array> {
  validateCoverSource(source); if (!source.url) throw new SocialSyncError("COVER_MISSING");
  const abort = AbortSignal.any([signal, AbortSignal.timeout(20000)]); abort.throwIfAborted();
  const response = await request(source.url, { redirect: "error", cache: "no-store", signal: abort,
    headers: { Accept: "image/jpeg,image/png,image/webp,image/avif,image/gif", Referer: source.platform === "bilibili" ? "https://www.bilibili.com/" : "https://www.xiaohongshu.com/" } });
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (!response.ok || !response.body || !["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(mime ?? "") ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > 20 * 1024 * 1024))) {
    await response.body?.cancel(); throw new SocialSyncError("COVER_DOWNLOAD_FAILED");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      abort.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 20 * 1024 * 1024) throw new SocialSyncError("COVER_TOO_LARGE"); chunks.push(value);
    }
    abort.throwIfAborted();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const digest = createHash("sha256").update(bytes).digest("hex");
  verifyMediaBytes({ assetId: `a1.${digest}`, ownerPageId: "cover-validation", objectKey: `sha256/${digest}`, sha256: digest,
    byteSize: size, mime: mime as StoredMedia["mime"], width: null, height: null }, bytes);
  return bytes;
}
export async function prepareCover(source: CoverSource, bytes: Uint8Array): Promise<{ files: CoverFiles; bodies: Map<string, Uint8Array> }> {
  validateCoverSource(source);
  const owner = coverOwner(source.kind, source.key);
  const metadata = await sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000, animated: true }).metadata();
  const formats: Partial<Record<string, StoredMedia["mime"]>> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heif: "image/avif" };
  const mime = formats[metadata.format];
  if (!mime || (metadata.format === "heif" && metadata.compression !== "av1") || !metadata.width || !metadata.height) throw new SocialSyncError("COVER_FORMAT_UNSUPPORTED");
  const orientation = metadata.orientation ?? 1, frameHeight = metadata.pageHeight ?? metadata.height;
  const width = orientation >= 5 ? frameHeight : metadata.width, height = orientation >= 5 ? metadata.width : frameHeight;
  const stored = (data: Uint8Array, mime: StoredMedia["mime"], width: number, height: number, locator: string): StoredMedia => {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const media: StoredMedia = { assetId: mediaIdentity(owner, locator, sha256), ownerPageId: owner, objectKey: `sha256/${sha256}`, sha256, byteSize: data.byteLength, mime, width, height };
    verifyMediaBytes(media, data); return media;
  };
  const original = stored(bytes, mime, width, height, "social-cover"), bodies = new Map([[original.sha256, bytes]]);
  const previews = {} as CoverFiles["previews"];
  const generated = await generateThumbnails(bytes);
  for (const cap of [400, 800] as const) {
    const candidate = generated.find(p => p.widthCap === cap);
    // Already-small originals are valid bounded previews; never upload a larger encoding.
    if (original.width! <= cap && (!candidate || candidate.byteSize >= original.byteSize)) previews[String(cap) as "400" | "800"] = original;
    else {
      if (!candidate || candidate.byteSize >= original.byteSize) throw new SocialSyncError("COVER_PREVIEW_UNAVAILABLE");
      const file = stored(candidate.bytes, candidate.mime, candidate.width, candidate.height, `social-cover-${cap}`);
      bodies.set(file.sha256, candidate.bytes); previews[String(cap) as "400" | "800"] = file;
    }
  }
  const files = { original, previews }; validateCoverFiles(files, source.kind, source.key); return { files, bodies };
}
/** Sequential, bounded, no implicit retry. Publish a binding only after independent private-store reads. */
export async function syncCovers(sources: CoverSource[], mode: CoverMode, ports: {
  writer: CoverWriter; storage: ObjectStorage; cache: CoverCache;
  download?: (source: CoverSource, signal: AbortSignal) => Promise<Uint8Array>;
  prepare?: typeof prepareCover; signal?: AbortSignal;
  limits?: { maxSourceBytes: number; maxObjectOperations: number; maxDurationMs: number };
}) {
  if (!["trial", "retained"].includes(mode)) throw new SocialSyncError("COVER_BATCH_INVALID");
  const plan = sourcePlan(sources);
  if (ports.limits) for (const key of ["maxSourceBytes", "maxObjectOperations", "maxDurationMs"] as const) {
    const value = ports.limits[key];
    if (!Number.isSafeInteger(value) || value < (key === "maxDurationMs" ? 1 : 0) || value > plan[key]) throw new SocialSyncError("COVER_BATCH_INVALID");
    plan[key] = value;
  }
  const signal = AbortSignal.any([AbortSignal.timeout(plan.maxDurationMs), ...(ports.signal ? [ports.signal] : [])]);
  const report = { planned: sources.length, registered: 0, unchanged: 0, missing: 0, unprocessed: sources.length, downloaded: 0, sourceRequests: 0,
    sourceBytes: 0, encoded: 0, reusedEncodings: 0, uploads: 0, objectReads: 0, objectOperations: 0, failed: 0, failures: [] as { kind: string; key: string; code: string }[] };
  const recipe = thumbnailEncodingRecipe();
  for (const source of sources) {
    report.unprocessed--;
    try {
      signal.throwIfAborted();
      if (source.kind === "collection") await ports.writer.collectionSource(source, mode);
      const current = await ports.writer.source(source, mode), digest = sourceDigest(source);
      if (!current || current.sha256 !== digest) throw new SocialSyncError("COVER_SCOPE_CHANGED");
      if (!digest) { report.missing++; continue; }
      const existing = await ports.writer.read(source, mode);
      if (existing) validateCoverFiles(existing.files, source.kind, source.key);
      if (existing?.sourceSha256 === digest) { report.unchanged++; continue; }
      let files = await ports.cache.read(source, recipe);
      if (!files) {
        const previous = await ports.cache.previous(source, recipe);
        // Reserve the largest permitted source before dispatch; remaining bytes are never exceeded.
        if (report.sourceBytes + 20 * 1024 * 1024 > plan.maxSourceBytes) throw new SocialSyncError("COVER_BYTE_BUDGET");
        signal.throwIfAborted(); report.sourceRequests++;
        const bytes = await (ports.download ?? downloadCover)(source, signal); signal.throwIfAborted();
        report.downloaded++; report.sourceBytes += bytes.byteLength;
        if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024 || report.sourceBytes > plan.maxSourceBytes) throw new SocialSyncError("COVER_BYTE_BUDGET");
        if (previous && createHash("sha256").update(bytes).digest("hex") === previous.files.original.sha256) {
          files = previous.files; report.reusedEncodings++;
          const bodies = new Map<string, Uint8Array>();
          for (const media of [files.original, files.previews["400"], files.previews["800"]]) {
            signal.throwIfAborted(); bodies.set(media.sha256, await ports.cache.bytes(media));
          }
          await ports.cache.save(source, recipe, files, bodies);
        } else {
          report.encoded++;
          const prepared = await (ports.prepare ?? prepareCover)(source, bytes); signal.throwIfAborted();
          files = prepared.files; await ports.cache.save(source, recipe, files, prepared.bodies);
        }
      }
      validateCoverFiles(files, source.kind, source.key);
      const mediaTuple = (m: StoredMedia) => [m.assetId, m.ownerPageId, m.objectKey, m.sha256, m.byteSize, m.mime, m.width, m.height];
      const fileTuple = (f: CoverFiles) => [f.original, f.previews["400"], f.previews["800"]].map(mediaTuple);
      const registeredObjects = existing && JSON.stringify(fileTuple(existing.files)) === JSON.stringify(fileTuple(files));
      // Shared hashes, including small original previews, are uploaded only once per owner.
      for (const media of new Map([files.original, files.previews["400"], files.previews["800"]].map(m => [m.sha256, m])).values()) {
        signal.throwIfAborted(); if (report.objectOperations + (registeredObjects ? 1 : 2) > plan.maxObjectOperations) throw new SocialSyncError("COVER_OBJECT_BUDGET");
        const bytes = await ports.cache.bytes(media); verifyMediaBytes(media, bytes);
        signal.throwIfAborted();
        if (!registeredObjects) { report.objectOperations++; report.uploads++; await ports.storage.put(media, bytes); signal.throwIfAborted(); }
        report.objectOperations++; report.objectReads++; verifyMediaBytes(media, await ports.storage.read(media)); signal.throwIfAborted();
      }
      const latest = await ports.writer.source(source, mode);
      if (!latest || latest.sha256 !== digest) throw new SocialSyncError("COVER_SCOPE_CHANGED");
      signal.throwIfAborted(); await ports.writer.register(source, mode, files); report.registered++;
    } catch (error) {
      const code = error instanceof SocialSyncError ? error.code : signal.aborted ? "COVER_CANCELLED" : "COVER_SYNC_FAILED";
      report.failed++; report.failures.push({ kind: source.kind, key: source.key, code });
      break; // A partial run is visible and cannot dispatch the rest silently.
    }
  }
  return report;
}
