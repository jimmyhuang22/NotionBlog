import { isEnabledContentKind } from "../../../../../../config/features.ts";
import { contentErrorResponse } from "../../../../../lib/content/http.ts";
import { publicationMode } from "../../../../../server/database/publication.ts";
import { getDatabaseRuntime } from "../../../../../server/database/runtime.ts";
import { withMediaReadBudget } from "../../../../../server/media/read-budget.ts";
import { isTrophyIconId, trophyIconResponse } from "../../../../../server/media/trophy-icon.ts";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  if (!isTrophyIconId(assetId) || !isEnabledContentKind("game") || process.env.CONTENT_PROVIDER !== "database" ||
      process.env.DATABASE_CONTENT_VERSION !== "2")
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  try {
    return await withMediaReadBudget(request.signal, () => trophyIconResponse(getDatabaseRuntime().cacheStateDb,
      publicationMode(process.env.DATABASE_PUBLICATION_MODE), assetId));
  } catch (error) { return contentErrorResponse(error); }
}
