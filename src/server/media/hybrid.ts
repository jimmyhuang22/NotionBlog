import { cacheableMediaHeaders } from "./cache.ts";
import { excludeFromSharedCache } from "../public-cache/policy.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { ObjectStorage } from "../database/storage.ts";
import { verifyMediaBytes } from "../database/storage.ts";
import { safeMediaUrl } from "../notion/media.ts";
import { validateMediaSource, type MediaSourceBinding, type MediaSourceProjection, type MediaSourceVersion } from "./notion-source.ts";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export function mediaProvider(value: string | undefined): "storage" | "notion" {
  if (value === undefined || value === "storage") return "storage";
  if (value === "notion") return "notion";
  throw new ContentServiceError("MISCONFIGURED", "Media provider configuration is invalid.");
}

export interface HybridMediaPorts {
  version?: MediaSourceVersion;
  read(assetId: string): Promise<MediaSourceProjection | null>;
  resolve(binding: MediaSourceBinding): Promise<{ url: string; sourceFingerprint: string } | null>;
  storage(): ObjectStorage;
}

/** Never use a stored backup after a Notion permission, locator or source failure. */
export async function hybridMediaResponse(assetId: string, ports: HybridMediaPorts): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers });
  if (!/^a1\.[a-f0-9]{64}$/.test(assetId)) return missing();
  const first = await ports.read(assetId);
  if (!first) return missing();
  if (first.media.assetId !== assetId || first.binding.assetId !== assetId) return missing();
  try { validateMediaSource(first.binding, first.media, ports.version); } catch { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Media source is incompatible."); }
  const source = await ports.resolve(first.binding);
  if (!source || source.sourceFingerprint !== first.binding.sourceFingerprint) return missing();
  const url = safeMediaUrl(source.url);
  if (!url || new URL(url).protocol !== "https:") return missing();
  const bytes = first.binding.delivery === "storage" ? await ports.storage().read(first.media) : undefined;
  if (bytes) verifyMediaBytes(first.media, bytes);
  // Qualification is checked again after every remote lookup / object download.
  const current = await ports.read(assetId);
  if (!current) return missing();
  try { validateMediaSource(current.binding, current.media, ports.version); } catch { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Media source is incompatible."); }
  if (JSON.stringify(current) !== JSON.stringify(first)) return missing();
  if (bytes) {
    // A slow Storage download also requires a fresh source permission check.
    const finalSource = await ports.resolve(current.binding);
    if (!finalSource || finalSource.sourceFingerprint !== current.binding.sourceFingerprint) return missing();
    const finalProjection = await ports.read(assetId);
    if (!finalProjection || JSON.stringify(finalProjection) !== JSON.stringify(current)) return missing();
    return excludeFromSharedCache(new Response(Buffer.from(bytes), { headers: { ...(ports.version === "v2" ? cacheableMediaHeaders(headers) : headers), "Content-Type": current.media.mime, "Content-Length": String(bytes.length) } }));
  }
  return new Response(null, { status: 302, headers: { ...headers, Location: url } });
}
