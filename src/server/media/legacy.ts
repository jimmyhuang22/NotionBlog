import type { ThumbnailWidth } from "../database/thumbnail-index.ts";
import { hybridMediaResponse, type HybridMediaPorts } from "./hybrid.ts";
import { legacyMediaReadQueue } from "./legacy-read-queue.ts";
import { withMediaReadBudget } from "./read-budget.ts";
import { thumbnailMediaResponse, type ThumbnailMediaPorts } from "./thumbnail.ts";

const originalNeeded = Symbol("original-needed");

/** v2 legacy delivery: stored thumbnails stay on the short SQL/object path.
 * A missing/transient variant waits outside that budget, then qualifies the
 * original again from scratch under a fresh, bounded live-source read. */
export async function legacyMediaResponse(
  signal: AbortSignal,
  assetId: string,
  original: HybridMediaPorts,
  thumbnail?: { width: ThumbnailWidth; ports: Omit<ThumbnailMediaPorts, "original"> },
  queue = legacyMediaReadQueue,
): Promise<Response> {
  const readOriginal = () => hybridMediaResponse(assetId, original);
  if (!/^a1\.[a-f0-9]{64}$/.test(assetId)) return withMediaReadBudget(signal, readOriginal);
  if (thumbnail) {
    // Live qualification also uses Notion for existing variants, so admit the
    // complete operation (including any fallback) exactly once.
    if (thumbnail.ports.qualification !== "database") {
      return queue.run(signal, () => thumbnailMediaResponse(assetId, thumbnail.width, { ...thumbnail.ports, original: readOriginal }));
    }
    const response = await withMediaReadBudget(signal, () => thumbnailMediaResponse<typeof originalNeeded>(assetId, thumbnail.width, {
      ...thumbnail.ports, original: async () => originalNeeded,
    }));
    if (response !== originalNeeded) return response;
  }
  return queue.run(signal, readOriginal);
}
