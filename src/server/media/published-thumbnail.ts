import { cacheableMediaHeaders } from "./cache.ts";
import type { PublishedThumbnailProjection } from "../database/published-thumbnails.ts";
import type { ThumbnailWidth } from "../database/thumbnail-index.ts";
import { verifyMediaBytes, type ObjectStorage } from "../database/storage.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
/** Two database reads and one independent object read. No Notion source port,
 * redirect or implicit original callback can be introduced into this path. */
export async function publishedThumbnailResponse(assetId: string, width: ThumbnailWidth, ports: {
  read(assetId: string, width: ThumbnailWidth): Promise<PublishedThumbnailProjection | null>;
  storage(): ObjectStorage;
}): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers });
  if (!/^a1\.[a-f0-9]{64}$/.test(assetId)) return missing();
  if (![400, 800].includes(width)) throw new ContentServiceError("INVALID_QUERY", "Thumbnail size is invalid.");
  const first = await ports.read(assetId, width);
  if (!first) return missing();
  const descriptor = first.thumbnail ?? first.original;
  const bytes = await ports.storage().read(descriptor); verifyMediaBytes(descriptor, bytes);
  const current = await ports.read(assetId, width);
  if (!current || JSON.stringify(current) !== JSON.stringify(first)) return missing();
  return new Response(Buffer.from(bytes), { headers: { ...cacheableMediaHeaders(headers), "Content-Type": descriptor.mime, "Content-Length": String(bytes.length) } });
}
