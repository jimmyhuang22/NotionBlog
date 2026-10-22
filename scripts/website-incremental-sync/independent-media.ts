import { createHash } from "node:crypto";
import type { StoredMedia } from "../../contracts/sync.ts";
import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import type { RegisterBlockImageInput } from "../../src/server/notion/blocks.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { canonicalJson, mediaIdentity, validateMedia } from "../../src/server/database/website-validation.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import { imageDimensions } from "../website-sync/image-dimensions.ts";
import { hostAwait, hostFail, type HostBudget } from "./host-budget.ts";
import type { DownloadedImage } from "../notion-sync/download.ts";
import type { PreparedImage } from "./source.ts";

/** No default store or source. Downloads must charge every wire chunk to this
 * same budget; storage reservations include unsuccessful reads and writes. */
export function createIndependentMediaPort(options: { budget: HostBudget; storage: ObjectStorage;
  download(url: string, signal: AbortSignal): Promise<DownloadedImage>;
  cached(assetId: string, ownerPageId: string): StoredMedia | null }) {
  const { budget, storage } = options, prepared = new Map<string, StoredMedia>(), objects = new Set<string>();
  let reused = 0, uploaded = 0;
  const guard = (s: AbortSignal) => { budget.guard(); s.throwIfAborted(); };
  return {
    async prepare(input: RegisterBlockImageInput, signal: AbortSignal): Promise<PreparedImage> {
      guard(signal);
      if (input.expiryTime && (!Number.isFinite(Date.parse(input.expiryTime)) || Date.parse(input.expiryTime) <= Date.now())) hostFail("HOST_MEDIA_PENDING");
      const image = await hostAwait(budget, () => options.download(input.url, signal), signal); guard(signal);
      const dimensions = await imageDimensions(image.bytes); guard(signal);
      const sha256 = createHash("sha256").update(image.bytes).digest("hex"), ownerPageId = normalizeId(input.ownerPageId);
      const media: StoredMedia = { assetId: mediaIdentity(ownerPageId, input.blockId ?? input.property ?? "cover", sha256),
        ownerPageId, sha256, objectKey: `sha256/${sha256}`, byteSize: image.bytes.length, mime: image.mime, ...dimensions };
      validateMedia(media); verifyMediaBytes(media, image.bytes);
      const cached = options.cached(media.assetId, ownerPageId);
      if (cached && canonicalJson(cached) !== canonicalJson(media)) hostFail("HOST_MEDIA_MISMATCH");
      if (!objects.has(media.objectKey)) {
        if (!cached) {
          budget.charge("mediaBytes", media.byteSize); guard(signal);
          await hostAwait(budget, () => storage.put(media, image.bytes), signal); guard(signal); uploaded++;
        }
        budget.charge("mediaBytes", media.byteSize); guard(signal);
        const stored = await hostAwait(budget, () => storage.read(media), signal); guard(signal); verifyMediaBytes(media, stored);
        objects.add(media.objectKey); if (cached) reused++;
      }
      if (prepared.size >= 2000 && !prepared.has(media.assetId)) hostFail("HOST_MEDIA_LIMIT");
      prepared.set(media.assetId, media);
      return { verified: true, media, image: { id: media.assetId, src: `/media/v2/${media.assetId}`,
        alt: sanitizePublicText(input.alt), ...dimensions } };
    },
    assets(records: WebsiteRecord[]) {
      const found = new Map<string, StoredMedia>();
      for (const record of records) {
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(visit); return; }
          if (!value || typeof value !== "object") return;
          const x = value as Record<string, unknown>;
          if (typeof x.src === "string" && x.src.startsWith("/media/v2/")) {
            const id = x.id as string, media = prepared.get(id) ?? options.cached(id, record.detail.item.id);
            if (!media) hostFail("HOST_MEDIA_PENDING");
            if (media.ownerPageId !== record.detail.item.id || x.src !== `/media/v2/${media.assetId}` || x.width !== media.width || x.height !== media.height) hostFail("HOST_MEDIA_MISMATCH");
            found.set(id, media);
          }
          Object.values(x).forEach(visit);
        }; visit(record.detail);
      }
      if (found.size > 100) hostFail("HOST_MEDIA_LIMIT");
      return { media: [...found.values()], verified: true as const };
    },
    statistics: () => ({ reusedObjects: reused, uploadedObjects: uploaded }),
  };
}
