import type { ThumbnailProjection } from "../database/thumbnail-index.ts";
import type { DisplayStore } from "./files.ts";
import { verifyDisplayBytes } from "./files.ts";
import { displayAssetId, selectDisplayFile, type DisplayAsset } from "./manifest.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget } from "../content-read-budget.ts";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };
export function displayWidth(url: string): 400 | 800 | 1600 | null {
  const params = new URL(url).searchParams;
  if (!params.size) return null;
  const values = params.getAll("thumbnail");
  if (params.size !== 1 || values.length !== 1 || !["400", "800", "1600"].includes(values[0]))
    throw new ContentServiceError("INVALID_QUERY", "Invalid display image width.");
  return Number(values[0]) as 400 | 800 | 1600;
}
function binding(projection: ThumbnailProjection) {
  return [projection.version, projection.runId, projection.source.media.assetId, projection.source.media.ownerPageId,
    projection.source.media.sha256, projection.source.binding.sourceFingerprint];
}
function matches(asset: DisplayAsset, projection: ThumbnailProjection) {
  return projection.version === "v2" && asset.assetId === projection.source.media.assetId &&
    asset.ownerPageId === projection.source.media.ownerPageId && asset.sourceSha256 === projection.source.media.sha256 &&
    asset.sourceFingerprint === projection.source.binding.sourceFingerprint;
}
/** Eligibility is fresh before and after verified disk bytes; there is intentionally no original port. */
export async function displayMediaResponse(assetId: string, width: 400 | 800 | 1600 | null, ports: {
  qualify(assetId: string): Promise<ThumbnailProjection | null>;
  store: DisplayStore;
}): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers });
  if (!displayAssetId(assetId)) return missing();
  checkContentReadBudget(); const first = await ports.qualify(assetId); if (!first) return missing();
  const manifest = await ports.store.manifest(first.runId), asset = manifest.assets.find(asset => asset.assetId === assetId);
  if (!asset || !matches(asset, first)) return missing();
  const descriptor = selectDisplayFile(asset, width), bytes = await ports.store.read(descriptor, manifest.recipe);
  verifyDisplayBytes(descriptor, bytes, manifest.recipe); checkContentReadBudget();
  const current = await ports.qualify(assetId);
  if (!current || !matches(asset, current) || JSON.stringify(binding(current)) !== JSON.stringify(binding(first))) return missing();
  return new Response(Buffer.from(bytes), { headers: { ...headers, "Content-Type": descriptor.mime, "Content-Length": String(bytes.length) } });
}
