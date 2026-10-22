import { ContentServiceError } from "../../../contracts/repository.ts";
import { SYNC_SCHEMA_DIGEST, type StoredMedia } from "../../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import { validateMediaSource, type MediaSourceProjection, type MediaSourceVersion } from "../media/notion-source.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { mediaIdentity, validateMedia } from "./validation.ts";

export const THUMBNAIL_CAPABILITY = "notionblog-thumbnail-index-v1";
export type ThumbnailWidth = 400 | 800 | 1600;
export interface ThumbnailProjection {
  version: MediaSourceVersion;
  runId: string;
  source: MediaSourceProjection;
  thumbnail: StoredMedia | null;
}
export interface ThumbnailRegistration {
  version: MediaSourceVersion;
  runId: string;
  assetId: string;
  sourceSha256: string;
  sourceFingerprint: string;
  widthCap: ThumbnailWidth;
  thumbnail: StoredMedia;
}
const asset = (x: unknown): x is string => typeof x === "string" && /^a1\.[a-f0-9]{64}$/.test(x);
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const uuid = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const version = (x: unknown): x is MediaSourceVersion => x === "v1" || x === "v2";
const width = (x: unknown): x is ThumbnailWidth => x === 400 || x === 800 || x === 1600;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "The private thumbnail index is unavailable.");
}
function validateThumbnail(thumbnail: StoredMedia, assetId: string, widthCap: ThumbnailWidth, owner?: string): void {
  validateMedia(thumbnail);
  if ((owner !== undefined && thumbnail.ownerPageId !== owner) ||
      thumbnail.assetId !== mediaIdentity(thumbnail.ownerPageId, `thumbnail:${widthCap}:${assetId}`, thumbnail.sha256) ||
      !Number.isInteger(thumbnail.width) || !Number.isInteger(thumbnail.height) ||
      thumbnail.mime !== "image/webp" || thumbnail.width! < 1 || thumbnail.width! > widthCap ||
      thumbnail.height! < 1 || thumbnail.height! > 16383) throw new Error();
}

/** Private generation-bound projection; never serialize its source locator into a public DTO. */
export async function readThumbnail(db: SqlExecutor, sourceVersion: MediaSourceVersion, assetId: string, widthCap: ThumbnailWidth): Promise<ThumbnailProjection | null> {
  if (!version(sourceVersion) || !asset(assetId) || !width(widthCap) || (widthCap === 1600 && sourceVersion !== "v2")) return null;
  const value = await callSql<unknown>(db, "SELECT nb_thumbnail_api.read_media($1,$2,$3) AS result", [sourceVersion, assetId, widthCap]);
  if (value === null) return null;
  try {
    if (!exact(value, ["thumbnailCapability", "schemaDigest", "version", "runId", "source", "thumbnail"]) ||
        value.thumbnailCapability !== THUMBNAIL_CAPABILITY || value.version !== sourceVersion || !uuid(value.runId) ||
        value.schemaDigest !== (sourceVersion === "v1" ? SYNC_SCHEMA_DIGEST : WEBSITE_SCHEMA_DIGEST) ||
        !exact(value.source, ["media", "binding"])) throw new Error();
    const source = value.source as unknown as MediaSourceProjection;
    if (source.media?.assetId !== assetId || source.binding?.assetId !== assetId) throw new Error();
    validateMediaSource(source.binding, source.media, sourceVersion);
    if (value.thumbnail !== null) validateThumbnail(value.thumbnail as StoredMedia, assetId, widthCap, source.media.ownerPageId);
    return { version: sourceVersion, runId: value.runId, source, thumbnail: value.thumbnail as StoredMedia | null };
  } catch { return unavailable(); }
}

/** Append derivatives only; this API cannot acquire leases, publish content or extend freshness. */
export function createThumbnailRegistrar(db: SqlExecutor): { register(input: ThumbnailRegistration): Promise<void> } {
  return {
    async register(input) {
      try {
        if (!exact(input, ["version", "runId", "assetId", "sourceSha256", "sourceFingerprint", "widthCap", "thumbnail"]) ||
            !version(input.version) || !uuid(input.runId) || !asset(input.assetId) || !hash(input.sourceSha256) ||
            !hash(input.sourceFingerprint) || !width(input.widthCap) || (input.widthCap === 1600 && input.version !== "v2")) throw new Error();
        validateThumbnail(input.thumbnail as StoredMedia, input.assetId, input.widthCap);
      } catch { return unavailable(); }
      await callSql(db, "SELECT nb_thumbnail_api.register_media($1,$2,$3,$4,$5,$6,$7::jsonb) AS result",
        [input.version, input.runId, input.assetId, input.sourceSha256, input.sourceFingerprint, input.widthCap, JSON.stringify(input.thumbnail)]);
    },
  };
}
