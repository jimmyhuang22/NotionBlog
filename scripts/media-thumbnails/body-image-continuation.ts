import type { StoredMedia } from "../../contracts/sync.ts";
import { createThumbnailRegistrar, readThumbnail } from "../../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { canonicalJson, mediaIdentity, validateMedia } from "../../src/server/database/validation.ts";
import { validateMediaSource, type MediaSourceProjection } from "../../src/server/media/notion-source.ts";

/** Immutable byte evidence only. Current SQL, not this saved source, grants eligibility. */
export interface VerifiedBodyThumbnail {
  source: MediaSourceProjection;
  thumbnail: StoredMedia;
  proof: { independentReaderVerified: true; sha256: string; byteSize: number; mime: "image/webp" };
}
function invalid(): never { throw new Error("Body-image thumbnail continuation input is invalid."); }
function changed(): never { throw new Error("Body-image thumbnail generation or source changed during registration."); }

export function validateVerifiedBodyThumbnails(input: unknown): asserts input is VerifiedBodyThumbnail[] {
  if (!Array.isArray(input) || !input.length || input.length > 20_000) invalid();
  const seen = new Set<string>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || Object.keys(candidate).sort().join() !== "proof,source,thumbnail") invalid();
    const { source, thumbnail, proof } = candidate as VerifiedBodyThumbnail;
    try { validateMediaSource(source.binding, source.media, "v2"); validateMedia(thumbnail); } catch { invalid(); }
    if (source.binding.locator.kind !== "block" || (source.media.width ?? 0) <= 1600 ||
        thumbnail.width !== 1600 || thumbnail.height === null || thumbnail.height > (source.media.height ?? 0) ||
        thumbnail.byteSize >= source.media.byteSize || thumbnail.mime !== "image/webp" ||
        thumbnail.ownerPageId !== source.media.ownerPageId ||
        thumbnail.assetId !== mediaIdentity(source.media.ownerPageId, `thumbnail:1600:${source.media.assetId}`, thumbnail.sha256) ||
        !proof || Object.keys(proof).sort().join() !== "byteSize,independentReaderVerified,mime,sha256" ||
        proof.independentReaderVerified !== true || proof.sha256 !== thumbnail.sha256 ||
        proof.byteSize !== thumbnail.byteSize || proof.mime !== thumbnail.mime || seen.has(source.media.assetId)) invalid();
    seen.add(source.media.assetId);
  }
}

/** Rebind independently verified, immutable objects to one fresh qualified batch.
 * No network object reads, encoding, uploads, source requests or content publication.
 * The caller owns its runtime lock and writes the terminal report, including failures.
 */
export async function continueBodyThumbnails(options: {
  runId: string; candidates: VerifiedBodyThumbnail[]; reader: SqlExecutor; writer: SqlExecutor;
  signal?: AbortSignal; progress?: (report: Readonly<{ registered: number; alreadyPresent: number; excluded: number; changed: number }>) => Promise<void>;
}) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.runId)) invalid();
  validateVerifiedBodyThumbnails(options.candidates);
  const report = { registered: 0, alreadyPresent: 0, excluded: 0, changed: 0 };
  const registrar = createThumbnailRegistrar(options.writer);
  for (const candidate of options.candidates) {
    options.signal?.throwIfAborted();
    const assetId = candidate.source.media.assetId;
    const first = await readThumbnail(options.reader, "v2", assetId, 1600);
    options.signal?.throwIfAborted();
    if (!first) { report.excluded++; await options.progress?.({ ...report }); continue; }
    if (first.runId !== options.runId) changed();
    if (canonicalJson(first.source) !== canonicalJson(candidate.source)) {
      report.changed++; await options.progress?.({ ...report }); continue;
    }
    if (first.thumbnail && canonicalJson(first.thumbnail) !== canonicalJson(candidate.thumbnail)) changed();
    if (!first.thumbnail) {
      await registrar.register({ version: "v2", runId: options.runId, assetId,
        sourceSha256: candidate.source.media.sha256, sourceFingerprint: candidate.source.binding.sourceFingerprint,
        widthCap: 1600, thumbnail: candidate.thumbnail });
    }
    options.signal?.throwIfAborted();
    const final = await readThumbnail(options.reader, "v2", assetId, 1600);
    options.signal?.throwIfAborted();
    if (!final || final.runId !== options.runId || canonicalJson(final.source) !== canonicalJson(first.source) ||
        canonicalJson(final.thumbnail) !== canonicalJson(candidate.thumbnail)) changed();
    if (first.thumbnail) report.alreadyPresent++; else report.registered++;
    await options.progress?.({ ...report });
  }
  return report;
}
