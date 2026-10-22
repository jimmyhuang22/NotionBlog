import type { StoredMedia } from "../../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import protocol from "../../../database/published-thumbnails-protocol.json" with { type: "json" };
import { callSql, type SqlExecutor } from "./sql.ts";
import { mediaIdentity, validateMedia } from "./website-validation.ts";
import type { ThumbnailWidth } from "./thumbnail-index.ts";

/** Private descriptors and publication identity; never serialize to a browser DTO. */
export interface PublishedThumbnailProjection {
  publicationRevision: string; configDigest: string; policyEpoch: string; widthCap: ThumbnailWidth;
  original: StoredMedia; thumbnail: StoredMedia | null;
}
function unavailable(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Published thumbnail data is unavailable."); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export async function verifyPublishedThumbnails(db: SqlExecutor): Promise<void> {
  if (await callSql(db, "SELECT nb_publication_api.check_thumbnail_capability($1) AS result", [protocol.migration.sha256]) !== true) unavailable();
}
/** The raw restricted reader stays inside this adapter; every call checks the
 * extension identity and parent publication in the same SQL statement. */
export function createPublishedThumbnailReader(db: SqlExecutor) {
  return async (assetId: string, width: ThumbnailWidth): Promise<PublishedThumbnailProjection | null> => {
    if (!/^a1\.[a-f0-9]{64}$/.test(assetId) || ![400, 800].includes(width)) return null;
    const value = await callSql<unknown>(db, "SELECT nb_publication_api.read_thumbnail($1,$2,$3) AS result", [assetId, width, protocol.migration.sha256]);
    if (value === null) return null;
    try {
      if (!exact(value, ["thumbnailCapability", "migrationDigest", "schemaDigest", "publicationRevision", "configDigest", "policyEpoch", "widthCap", "original", "thumbnail"]) ||
        value.thumbnailCapability !== protocol.capability || value.migrationDigest !== protocol.migration.sha256 || value.schemaDigest !== WEBSITE_SCHEMA_DIGEST ||
        value.widthCap !== width || typeof value.publicationRevision !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[0-9]{1,20}$/.test(value.publicationRevision) ||
        typeof value.configDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.configDigest) ||
        typeof value.policyEpoch !== "string" || !/^[0-9]{1,20}$/.test(value.policyEpoch)) throw new Error();
      const original = value.original as StoredMedia; validateMedia(original);
      if (original.assetId !== assetId) throw new Error();
      let thumbnail = value.thumbnail as StoredMedia | null;
      if (thumbnail !== null) {
        validateMedia(thumbnail);
        if (thumbnail.ownerPageId !== original.ownerPageId || thumbnail.mime !== "image/webp" ||
          thumbnail.assetId !== mediaIdentity(original.ownerPageId, `thumbnail:${width}:${assetId}`, thumbnail.sha256) ||
          !Number.isInteger(thumbnail.width) || thumbnail.width! < 1 || thumbnail.width! > width ||
          !Number.isInteger(thumbnail.height) || thumbnail.height! < 1 || thumbnail.height! > 16383 ||
          original.width !== null && thumbnail.width! > original.width || original.height !== null && thumbnail.height! > original.height) throw new Error();
        // Valid historical variants may predate the strict byte-saving policy.
        // They remain archived; this read explicitly selects the stored original.
        if (thumbnail.byteSize >= original.byteSize) thumbnail = null;
      }
      return { publicationRevision: value.publicationRevision, configDigest: value.configDigest, policyEpoch: value.policyEpoch,
        widthCap: width, original, thumbnail };
    } catch { return unavailable(); }
  };
}

/** Backend bytes must have been independently prepared and verified first.
 * Registration neither reads source URLs nor activates the parent publication. */
export function createPublishedThumbnailRegistrar(db: SqlExecutor) {
  return {async register(input: {expectedRevision: string; parentAssetId: string; parentSha256: string; widthCap: ThumbnailWidth; thumbnail: StoredMedia}): Promise<void> {
    try {
      if (!exact(input, ["expectedRevision", "parentAssetId", "parentSha256", "widthCap", "thumbnail"]) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[0-9]{1,20}$/.test(input.expectedRevision) ||
        !/^a1\.[a-f0-9]{64}$/.test(input.parentAssetId) || !/^[a-f0-9]{64}$/.test(input.parentSha256) || ![400, 800].includes(input.widthCap)) throw new Error();
      const m = input.thumbnail; validateMedia(m);
      if (m.mime !== "image/webp" || m.assetId !== mediaIdentity(m.ownerPageId, `thumbnail:${input.widthCap}:${input.parentAssetId}`, m.sha256) ||
        !Number.isInteger(m.width) || m.width! < 1 || m.width! > input.widthCap || !Number.isInteger(m.height) || m.height! < 1 || m.height! > 16383) throw new Error();
    } catch { return unavailable(); }
    await callSql(db, "SELECT nb_publication_api.register_thumbnail($1,$2,$3,$4,$5::jsonb,$6) AS result",
      [input.expectedRevision, input.parentAssetId, input.parentSha256, input.widthCap, JSON.stringify(input.thumbnail), protocol.migration.sha256]);
  }};
}
