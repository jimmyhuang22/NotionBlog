import { ContentServiceError } from "../../../contracts/repository.ts";
import { type RunLease, type StoredMedia } from "../../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import manifest from "../../../database/website-media-protocol.json" with { type: "json" };
import { validateMediaSource, type MediaSourceBinding, type MediaSourceProjection } from "../media/notion-source.ts";
import { callSql, type SqlExecutor } from "./sql.ts";

export const WEBSITE_MEDIA_SOURCE_CAPABILITY = manifest.capability;

interface ProjectionEnvelope {
  schemaDigest: string;
  mediaCapability: string;
  media: StoredMedia | null;
  binding: MediaSourceBinding | null;
}

function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "The private media source index is unavailable.");
}

/** Independent v2 extension; never requires or replaces the v1 media index. */
export function createWebsiteMediaSourceWriter(db: SqlExecutor): {
  stage(lease: RunLease, bindings: MediaSourceBinding[]): Promise<void>;
} {
  return {
    async stage(lease, bindings) {
      if (!Array.isArray(bindings) || bindings.length > 100) unavailable();
      const serialized = JSON.stringify(bindings);
      if (Buffer.byteLength(serialized) > 262144) unavailable();
      await callSql(db, "SELECT nb_v2_media_api.stage_sources($1,$2,$3::jsonb) AS result", [lease.runId, lease.fence, serialized]);
    },
  };
}

/** Owner eligibility, current generation and its private locator are read atomically. */
export async function readWebsiteMediaSource(db: SqlExecutor, assetId: string): Promise<MediaSourceProjection | null> {
  if (!/^a1\.[a-f0-9]{64}$/.test(assetId)) return null;
  const projection = await callSql<ProjectionEnvelope>(db, "SELECT nb_v2_media_api.read_source($1) AS result", [assetId]);
  if (!projection || projection.schemaDigest !== WEBSITE_SCHEMA_DIGEST || projection.mediaCapability !== WEBSITE_MEDIA_SOURCE_CAPABILITY) unavailable();
  if (projection.media === null && projection.binding === null) return null;
  if (!projection.media || !projection.binding || projection.media.assetId !== assetId || projection.binding.assetId !== assetId) unavailable();
  try { validateMediaSource(projection.binding, projection.media, "v2"); }
  catch { return unavailable(); }
  return { media: projection.media, binding: projection.binding };
}
