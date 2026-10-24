import { getNotionRuntime } from "../../../server/notion/runtime.ts";
import { directNotionMediaResponse, withDirectMediaBudget } from "../../../server/media/notion-direct.ts";
import { contentErrorResponse } from "../../../lib/content/http.ts";
import { getDatabaseRuntime } from "../../../server/database/runtime.ts";
import { databaseMediaResponse } from "../../../server/database/media.ts";
import { readMediaSource } from "../../../server/database/media-sources.ts";
import { resolveNotionMediaSource } from "../../../server/notion/media-source.ts";
import { hybridMediaResponse, mediaProvider } from "../../../server/media/hybrid.ts";
import { ContentServiceError } from "../../../../contracts/repository.ts";
import { readThumbnail } from "../../../server/database/thumbnail-index.ts";
import { thumbnailMediaResponse, thumbnailWidth, thumbnailsEnabled } from "../../../server/media/thumbnail.ts";

import { withMediaReadBudget } from "../../../server/media/read-budget.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    if (process.env.CONTENT_PROVIDER === "notion") return await withDirectMediaBudget(request, async () => {
      const { assetId } = await context.params;
      const { repository, client, mediaSecret, withPolicy } = getNotionRuntime();
      if (!withPolicy) throw new ContentServiceError("MISCONFIGURED", "Direct content requires the central policy capability.");
      return withPolicy(() => directNotionMediaResponse(assetId, repository, client, mediaSecret));
    });
    return await withMediaReadBudget(request.signal, async () => {
      const { assetId } = await context.params;
      if (process.env.CONTENT_PROVIDER === "database") {
        if ((process.env.DATABASE_CONTENT_VERSION ?? "1") !== "1") return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
        const { db, storage } = getDatabaseRuntime();
        if (mediaProvider(process.env.MEDIA_PROVIDER) === "notion") {
          const { repository, client, config } = getNotionRuntime();
          if (config.schemaVersion !== 1) throw new ContentServiceError("MISCONFIGURED", "Media source configuration does not match the content version.");
          const ports = {
            read: id => readMediaSource(db, id),
            resolve: binding => resolveNotionMediaSource(binding, repository, client), storage,
          } satisfies import("../../../server/media/hybrid.ts").HybridMediaPorts;
          const width = thumbnailWidth(request.url);
          if (width && thumbnailsEnabled(process.env.MEDIA_THUMBNAILS)) return await thumbnailMediaResponse(assetId, width, {
            read: (id, cap) => readThumbnail(db, "v1", id, cap), resolve: ports.resolve, storage,
            original: () => hybridMediaResponse(assetId, ports),
          });
          return await hybridMediaResponse(assetId, ports);
        }
        return await databaseMediaResponse(assetId, db, storage);
      }
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) { return contentErrorResponse(error); }
}
