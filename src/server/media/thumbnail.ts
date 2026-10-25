import { cacheableMediaHeaders } from "./cache.ts";
import { excludeFromSharedCache } from "../public-cache/policy.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { ThumbnailProjection, ThumbnailWidth } from "../database/thumbnail-index.ts";
import type { ObjectStorage } from "../database/storage.ts";
import { TransientStorageReadError, verifyMediaBytes } from "../database/storage.ts";
import { safeMediaUrl } from "../notion/media.ts";
import { validateMediaSource, type MediaSourceBinding } from "./notion-source.ts";
import { readThumbnailBytes, type ThumbnailByteSource } from "./thumbnail-bytes.ts";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export function thumbnailWidth(requestUrl: string, website1600 = false): ThumbnailWidth | null {
  const values = new URL(requestUrl).searchParams.getAll("thumbnail");
  if (!values.length) return null;
  if (values.length !== 1 || !(website1600 ? ["400", "800", "1600"] : ["400", "800"]).includes(values[0])) {
    throw new ContentServiceError("INVALID_QUERY", "Thumbnail size is invalid.");
  }
  return Number(values[0]) as ThumbnailWidth;
}

export function thumbnailsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "disabled") return false;
  if (value === "enabled") return true;
  throw new ContentServiceError("MISCONFIGURED", "Thumbnail configuration is invalid.");
}

export function thumbnailQualification(value: string | undefined): "live-notion" | "database" {
  if (value === undefined || value === "live-notion") return "live-notion";
  if (value === "database") return "database";
  throw new ContentServiceError("MISCONFIGURED", "Thumbnail qualification is invalid.");
}

export interface ThumbnailMediaPorts {
  /** Explicit v2 opt-in: source changes propagate with publication, as pages do. */
  qualification?: "live-notion" | "database";
  read(assetId: string, width: ThumbnailWidth): Promise<ThumbnailProjection | null>;
  resolve(binding: MediaSourceBinding): Promise<{ url: string; sourceFingerprint: string } | null>;
  storage(): ObjectStorage;
  /** Missing variants or classified transient transport failures re-enter the qualified original path. */
  original(): Promise<Response>;
}

function safeSource(source: { url: string; sourceFingerprint: string } | null, binding: MediaSourceBinding): boolean {
  if (!source || source.sourceFingerprint !== binding.sourceFingerprint) return false;
  const url = safeMediaUrl(source.url);
  return !!url && new URL(url).protocol === "https:";
}

/** Current database scope always qualifies each read. Live Notion remains the default. */
export async function thumbnailMediaResponse(assetId: string, width: ThumbnailWidth, ports: ThumbnailMediaPorts): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers });
  if (!/^a1\.[a-f0-9]{64}$/.test(assetId)) return missing();
  if (![400, 800, 1600].includes(width)) throw new ContentServiceError("INVALID_QUERY", "Thumbnail size is invalid.");
  const scopeStarted = performance.now();
  const first = await ports.read(assetId, width);
  const scopeMs = performance.now() - scopeStarted;
  if (!first) return missing();
  // SQL qualifies the current owner kind and source reference; this is an additional locator boundary.
  if (width === 1600 && (first.version !== "v2" || !["cover", "block"].includes(first.source.binding.locator.kind))) return missing();
  const live = thumbnailQualification(ports.qualification) === "live-notion";
  if (!live && first.version !== "v2") throw new ContentServiceError("MISCONFIGURED", "Database thumbnail qualification requires v2.");
  validateMediaSource(first.source.binding, first.source.media, first.version);
  if (first.source.media.assetId !== assetId) return missing();
  if (first.thumbnail === null) return ports.original();
  if (live && !safeSource(await ports.resolve(first.source.binding), first.source.binding)) return missing();
  let bytes: Uint8Array;
  let byteSource: ThumbnailByteSource;
  const objectStarted = performance.now();
  try {
    ({ bytes, source: byteSource } = first.version === "v2"
      ? await readThumbnailBytes(ports.storage(), first.thumbnail)
      : { bytes: await ports.storage().read(first.thumbnail), source: "bypass" });
  }
  catch (error) {
    if (!(error instanceof TransientStorageReadError)) throw error;
    const current = await ports.read(assetId, width);
    if (!current || JSON.stringify(current) !== JSON.stringify(first)) return missing();
    // Re-enter current database + live Notion checks; never reuse the old URL.
    return ports.original();
  }
  const objectMs = performance.now() - objectStarted;
  verifyMediaBytes(first.thumbnail, bytes);
  const recheckStarted = performance.now();
  const current = await ports.read(assetId, width);
  const recheckMs = performance.now() - recheckStarted;
  if (!current || JSON.stringify(current) !== JSON.stringify(first)) return missing();
  if (live) {
    // A slow Storage read requires a fresh source check under live qualification.
    if (!safeSource(await ports.resolve(current.source.binding), current.source.binding)) return missing();
    const final = await ports.read(assetId, width);
    if (!final || JSON.stringify(final) !== JSON.stringify(current)) return missing();
  }
  const response = new Response(Buffer.from(bytes), { headers: {
    ...(first.version === "v2" ? cacheableMediaHeaders(headers) : headers), "Content-Type": first.thumbnail.mime, "Content-Length": String(bytes.length),
    "Server-Timing": `thumb_scope;dur=${scopeMs.toFixed(2)}, thumb_object;dur=${objectMs.toFixed(2)};desc="${byteSource}", thumb_recheck;dur=${recheckMs.toFixed(2)}`,
  } });
  return live ? excludeFromSharedCache(response) : response;
}
