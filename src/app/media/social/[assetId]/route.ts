import { withPublicHttp } from "../../../../server/public-cache/http.ts";
import { socialMediaEnabled } from "../../../../server/social/covers.ts";
import { socialMediaRuntime, socialProvider } from "../../../../server/social/runtime.ts";
import { socialDisplayMode } from "../../../../server/social/retained-repository.ts";
import { socialMediaResponse, socialThumbnailWidth } from "../../../../server/social/media.ts";
import { contentErrorResponse } from "../../../../lib/content/http.ts";
import { withMediaReadBudget } from "../../../../server/media/read-budget.ts";

async function readMedia(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    if (!socialMediaEnabled(process.env.SOCIAL_MEDIA_ENABLED) || socialProvider() !== "database") {
      return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    }
    const width = socialThumbnailWidth(request.url), { assetId } = await context.params;
    return await withMediaReadBudget(request.signal, async () => {
      const { sql, storage } = await socialMediaRuntime();
      return socialMediaResponse(assetId, width, socialDisplayMode(process.env.SOCIAL_DISPLAY_MODE), sql, storage, request.headers.get("if-none-match"));
    });
  } catch (error) { return contentErrorResponse(error); }
}

export const GET = withPublicHttp("media", readMedia);
