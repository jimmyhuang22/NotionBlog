import { ContentServiceError } from "../../contracts/repository.ts";
import type { StoredMedia } from "../../contracts/sync.ts";
import { createThumbnailRegistrar, readThumbnail, type ThumbnailProjection, type ThumbnailWidth } from "../../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import { canonicalJson, mediaIdentity, validateMedia } from "../../src/server/database/validation.ts";
import type { MediaSourceBinding, MediaSourceVersion } from "../../src/server/media/notion-source.ts";
import { safeMediaUrl } from "../../src/server/notion/media.ts";
import { createImageDownloader, type DownloadedImage } from "../notion-sync/download.ts";
import { generateThumbnails, thumbnailEncodingRecipe } from "./encode.ts";
import type { VerifiedThumbnailCache } from "./cache.ts";
import type { ThumbnailBudgetGuard } from "./budget.ts";
import { parseThumbnailWidthSelection, type ThumbnailWidthSelection } from "./widths.ts";

const WIDTHS = [400, 800] as const;
const MAX_ORIGINAL_BYTES = 1024 * 1024 * 1024;
const ASSET_ID = /^a1\.[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface ThumbnailBatchReport {
  /** Originals fully handled, including originals deliberately skipped. */
  processed: number;
  /** Requested and verified derivative registrations, counted per width cap. */
  registered: number;
  /** Existing derivative registrations whose actual bytes were verified. */
  alreadyPresent: number;
  /** Originals deliberately skipped by the encoder. */
  skipped: number;
  /** Fresh width-cap outputs omitted because they are not smaller than the original. */
  notSmaller: number;
  /** Sum per width-cap mapping, not unique Storage object bytes. */
  thumbnailBytes: number;
  /** Bodies supplied to Storage.put, including any immutable-object conflicts. */
  uploadAttemptBytes: number;
}

export interface ThumbnailBatchOptions {
  version: MediaSourceVersion;
  runId: string;
  assetIds: string[];
  /** Restricted reader connection; cannot register derivatives. */
  db: SqlExecutor;
  /** Restricted writer connection; cannot read the published projection. */
  registrationDb: SqlExecutor;
  storage: ObjectStorage;
  resolve(binding: MediaSourceBinding): Promise<{ url: string; sourceFingerprint: string } | null>;
  download?(url: string, signal?: AbortSignal, maxBytes?: number): Promise<DownloadedImage>;
  /** Optional verified local original input; does not replace derivative Storage. */
  readOriginal?(media: StoredMedia, signal?: AbortSignal): Promise<Uint8Array>;
  /** Only narrows the two existing caps for every selected parent. */
  widths?: ThumbnailWidthSelection;
  /** Total original bytes for this invocation; may only tighten the 1 GiB bound. */
  maxBytes?: number;
  /** Verified byte locators only; current SQL and live source checks still authorize every reuse. */
  cache?: VerifiedThumbnailCache;
  /** An already persisted execution allocation; never a planning-only budget. */
  budget?: ThumbnailBudgetGuard;
  onProgress?(report: Readonly<ThumbnailBatchReport>): void | Promise<void>;
}

function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "Thumbnail generation could not safely complete.");
}

function sourceIdentity(value: ThumbnailProjection): string {
  return canonicalJson({ version: value.version, runId: value.runId, source: value.source });
}

function sourceUrl(value: string): string {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/u.test(value)) return unavailable();
  const safe = safeMediaUrl(value);
  if (!safe) return unavailable();
  const url = new URL(safe);
  if (url.protocol !== "https:" || url.hash || (url.port && url.port !== "443") || url.hostname.endsWith(".")) return unavailable();
  return safe;
}

/**
 * Append previews for an explicitly selected, current published generation.
 * Does not acquire a publication lease, publish content, or extend eligibility.
 * A failed invocation may leave verified objects/mappings; retry is idempotent.
 */
export async function generateAndRegisterThumbnails(options: ThumbnailBatchOptions): Promise<ThumbnailBatchReport> {
  const maxBytes = options?.maxBytes ?? MAX_ORIGINAL_BYTES;
  if (!options || !["v1", "v2"].includes(options.version) || !RUN_ID.test(options.runId) ||
      !Array.isArray(options.assetIds) || options.assetIds.length < 1 || options.assetIds.length > 20_000 ||
      [...options.assetIds].some(id => typeof id !== "string" || !ASSET_ID.test(id)) ||
      new Set(options.assetIds).size !== options.assetIds.length ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ORIGINAL_BYTES ||
      typeof options.db?.query !== "function" || typeof options.registrationDb?.query !== "function" ||
      typeof options.storage?.read !== "function" || typeof options.storage?.put !== "function" ||
      typeof options.resolve !== "function" ||
      (options.cache !== undefined && (options.cache.recipe !== thumbnailEncodingRecipe() ||
        typeof options.cache.lookup !== "function" || typeof options.cache.record !== "function")) ||
      (options.download !== undefined && typeof options.download !== "function") ||
      (options.readOriginal !== undefined && typeof options.readOriginal !== "function") ||
      (options.budget !== undefined && (typeof options.budget.check !== "function" ||
        typeof options.budget.reserveOriginal !== "function" || typeof options.budget.reserveUpload !== "function" ||
        !(options.budget.signal instanceof AbortSignal))) ||
      (options.onProgress !== undefined && typeof options.onProgress !== "function")) {
    throw new ContentServiceError("MISCONFIGURED", "Thumbnail batch configuration is invalid.");
  }
  const selectedWidths = options.widths === undefined ? undefined :
    new Map(parseThumbnailWidthSelection(options.widths, options).assets.map(asset => [asset.assetId, asset.widthCaps]));
  const report: ThumbnailBatchReport = { processed: 0, registered: 0, alreadyPresent: 0, skipped: 0, notSmaller: 0, thumbnailBytes: 0, uploadAttemptBytes: 0 };
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    options.budget?.check();
    const result = await operation();
    options.budget?.check();
    return result;
  }
  function guardedDb(db: SqlExecutor): SqlExecutor {
    return {query: <T>(text: string, parameters?: unknown[]) => bounded(() => db.query<T>(text, parameters))};
  }
  const db = guardedDb(options.db);
  const registrar = createThumbnailRegistrar(guardedDb(options.registrationDb));
  const storage: ObjectStorage = {
    read: media => bounded(() => options.storage.read(media)),
    put: (media, bytes) => bounded(() => options.storage.put(media, bytes)),
  };
  const assetIds = [...options.assetIds];
  let originalBytes = 0;
  // Only cache successful byte verification within this invocation. Reuse still
  // reads the object again, so permission, deletion and bad-byte failures surface.
  const verifiedObjects = new Set<string>();
  try {
    for (const assetId of assetIds) {
      options.budget?.check();
      const widthCaps = selectedWidths?.get(assetId) ?? WIDTHS;
      const initial = await readThumbnail(db, options.version, assetId, widthCaps[0]);
      if (!initial || initial.runId !== options.runId) unavailable();
      for (const widthCap of widthCaps.slice(1)) {
        const second = await readThumbnail(db, options.version, assetId, widthCap);
        if (!second || sourceIdentity(initial) !== sourceIdentity(second)) unavailable();
      }
      const expected = sourceIdentity(initial);
      const rejectedCachedWidths = new Set<ThumbnailWidth>();
      async function guard(widthCap: ThumbnailWidth): Promise<{ projection: ThumbnailProjection; url: string }> {
        const current = await readThumbnail(db, options.version, assetId, widthCap);
        if (!current || sourceIdentity(current) !== expected) return unavailable();
        const live = await bounded(() => options.resolve(structuredClone(current.source.binding)));
        if (!live || live.sourceFingerprint !== current.source.binding.sourceFingerprint) return unavailable();
        const url = sourceUrl(live.url);
        // A source lookup is remote and can cross a publication/withdrawal boundary.
        const final = await readThumbnail(db, options.version, assetId, widthCap);
        if (!final || sourceIdentity(final) !== expected) return unavailable();
        return { projection: final, url };
      }
      async function existing(widthCap: ThumbnailWidth, thumbnail: StoredMedia): Promise<void> {
        verifyMediaBytes(thumbnail, await storage.read(thumbnail));
        const current = (await guard(widthCap)).projection;
        if (!current.thumbnail || canonicalJson(current.thumbnail) !== canonicalJson(thumbnail)) unavailable();
        // An existing SQL mapping has no encoder provenance. Only derivatives
        // generated by this recipe or reused from its verified cache are saved.
        verifiedObjects.add(thumbnail.objectKey);
        report.alreadyPresent++;
        report.thumbnailBytes += thumbnail.byteSize;
      }
      async function register(widthCap: ThumbnailWidth, thumbnail: StoredMedia): Promise<void> {
        const before = (await guard(widthCap)).projection;
        if (before.thumbnail) {
          await existing(widthCap, before.thumbnail);
          return;
        }
        await registrar.register({ version: options.version, runId: options.runId, assetId,
          sourceSha256: before.source.media.sha256, sourceFingerprint: before.source.binding.sourceFingerprint,
          widthCap, thumbnail });
        const registered = (await guard(widthCap)).projection;
        if (!registered.thumbnail || canonicalJson(registered.thumbnail) !== canonicalJson(thumbnail)) unavailable();
        options.budget?.check();
        // Keep the immutable cache entry intact when its candidate was rejected.
        // The new SQL mapping is still backed by fresh original/output checks.
        if (!rejectedCachedWidths.has(widthCap)) options.cache?.record(registered, widthCap, thumbnail);
        report.registered++;
        report.thumbnailBytes += thumbnail.byteSize;
      }
      const missing: ThumbnailWidth[] = [];
      for (const widthCap of widthCaps) {
        const current = (await guard(widthCap)).projection;
        if (current.thumbnail) await existing(widthCap, current.thumbnail);
        else {
          const cached = options.cache?.lookup(current, widthCap);
          if (cached && cached.byteSize < current.source.media.byteSize) {
            // A local descriptor never proves eligibility or object availability.
            // Missing, changed or denied objects fail; they are not cache misses.
            verifyMediaBytes(cached, await storage.read(cached));
            verifiedObjects.add(cached.objectKey);
            await register(widthCap, cached);
          } else {
            // An older equal/larger cached preview must not authorize either a
            // new mapping or a skip. Verify and encode the original normally.
            if (cached) rejectedCachedWidths.add(widthCap);
            missing.push(widthCap);
          }
        }
      }
      if (missing.length) {
        const current = await guard(missing[0]);
        const parent = current.projection.source.media;
        if (parent.byteSize > maxBytes - originalBytes || parent.byteSize > 20 * 1024 * 1024) unavailable();
        // Persist the entire expected read allowance before starting I/O. An
        // interrupted or rejected read is charged too, without a retry refund.
        await options.budget?.reserveOriginal(parent.byteSize);
        options.budget?.check();
        let bytes: Uint8Array;
        if (options.readOriginal) {
          bytes = await bounded(() => options.readOriginal!(structuredClone(parent), options.budget?.signal));
        } else if (current.projection.source.binding.delivery === "storage") {
          bytes = await storage.read(parent);
        } else {
          const download = options.download ?? createImageDownloader({maxBytes: parent.byteSize});
          const downloaded = await bounded(() => download(current.url, options.budget?.signal, parent.byteSize));
          if (downloaded.mime !== parent.mime) unavailable();
          bytes = downloaded.bytes;
        }
        if (bytes.byteLength > maxBytes - originalBytes) unavailable();
        originalBytes += bytes.byteLength;
        verifyMediaBytes(parent, bytes);
        const generated = await bounded(() => generateThumbnails(bytes, {widthCaps: missing}));
        if (!generated.length) {
          await guard(missing[0]);
          report.skipped++;
        } else {
          for (const widthCap of missing) {
            const before = (await guard(widthCap)).projection;
            if (before.thumbnail) {
              await existing(widthCap, before.thumbnail);
              continue;
            }
            const output = generated.find(value => value.widthCap === widthCap);
            if (!output) {
              if (widthCap === 1600 && generated.every(value => value.width < 1600)) { report.skipped++; continue; }
              unavailable();
            }
            const thumbnail: StoredMedia = {
              assetId: mediaIdentity(parent.ownerPageId, `thumbnail:${widthCap}:${assetId}`, output.sha256),
              ownerPageId: parent.ownerPageId,
              objectKey: `sha256/${output.sha256}`,
              sha256: output.sha256,
              byteSize: output.byteSize,
              mime: output.mime,
              width: output.width,
              height: output.height,
            };
            validateMedia(thumbnail);
            verifyMediaBytes(thumbnail, output.bytes);
            if (thumbnail.byteSize >= before.source.media.byteSize) {
              // A smaller resolution alone does not justify another object.
              // Recheck qualification even when this cap performs no writes.
              await guard(widthCap);
              report.notSmaller++;
              continue;
            }
            if (verifiedObjects.has(thumbnail.objectKey)) {
              verifyMediaBytes(thumbnail, await storage.read(thumbnail));
            } else {
              // Charge before the immutable PUT adapter can issue its POST.
              // Conflicts, errors and uncertain outcomes retain this charge.
              await options.budget?.reserveUpload(output.byteSize);
              options.budget?.check();
              report.uploadAttemptBytes += output.byteSize;
              await storage.put(thumbnail, output.bytes);
              verifyMediaBytes(thumbnail, await storage.read(thumbnail));
              verifiedObjects.add(thumbnail.objectKey);
            }
            await register(widthCap, thumbnail);
          }
        }
      }
      report.processed++;
      options.budget?.check();
      if (options.onProgress) await bounded(async () => options.onProgress!(Object.freeze({ ...report })));
    }
    return { ...report };
  } catch {
    // Native decoders, injected transports and SQL errors can contain private
    // IDs/URLs. Keep operator errors safe while preserving the failed outcome.
    return unavailable();
  }
}
