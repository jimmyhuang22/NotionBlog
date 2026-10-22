import { publicHttpResponse } from "../../server/public-cache/http.ts";
import type { HomeFeedRepository } from "../../../contracts/home-feed.ts";
import type { CursorQuery } from "../../../contracts/website.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { withListReadBudget } from "../../server/list-read-budget.ts";
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

export async function homeFeedResponse(request: Request, repository: HomeFeedRepository): Promise<Response> {
  try {
    const query: CursorQuery = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      if (!["limit", "cursor"].includes(key) || Object.hasOwn(query, key)) throw new ContentServiceError("INVALID_QUERY", "Invalid home feed query.");
      if (key === "limit") {
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 50) throw new ContentServiceError("INVALID_QUERY", "Invalid home feed page size.");
        query.limit = Number(value);
      } else {
        if (!value || value.length > 1024 || /[\u0000-\u0020\u007f]/.test(value)) throw new ContentServiceError("INVALID_QUERY", "Invalid home feed cursor.");
        query.cursor = value;
      }
    }
    return publicHttpResponse(request, Response.json({ data: await withListReadBudget("home-feed", () => repository.getPage(query), request.signal) }, { headers }), "home");
  } catch (cause) {
    const code = cause instanceof ContentServiceError && ["INVALID_QUERY", "RATE_LIMITED"].includes(cause.code) ? cause.code : "CONTENT_UNAVAILABLE";
    return Response.json({ error: { code, message: code === "INVALID_QUERY" ? "Invalid or outdated home feed query. Restart from the first page." : "Home feed is temporarily unavailable." } },
      { status: code === "INVALID_QUERY" ? 400 : 503, headers: code === "INVALID_QUERY" ? headers : { ...headers, "Retry-After": "1" } });
  }
}
