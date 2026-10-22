import { publicHttpResponse } from "../../server/public-cache/http.ts";
import type { SocialRepository } from "../../../contracts/social.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { CursorQuery } from "../../../contracts/website.ts";
import type { SocialTimelineRepository } from "../../../contracts/social-timeline.ts";
import { parseSocialWorksQuery } from "./social-works-query.ts";
import { withListReadBudget } from "../../server/list-read-budget.ts";
const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

function parseCursorQuery(params: URLSearchParams): CursorQuery {
  const query: CursorQuery = {};
  for (const [key, value] of params) {
      if (!["limit", "cursor"].includes(key) || Object.hasOwn(query, key)) throw new ContentServiceError("INVALID_QUERY", "Unsupported or repeated query parameter.");
      if (key === "limit") {
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 20) throw new ContentServiceError("INVALID_QUERY", "Invalid page size.");
        query.limit = Number(value);
      } else {
        if (!value || value.length > 512) throw new ContentServiceError("INVALID_QUERY", "Invalid social cursor.");
        query.cursor = value;
      }
  }
  return query;
}

async function worksResponse(request: Request, repository: SocialRepository, enabled: () => boolean,
  parse: (params: URLSearchParams) => CursorQuery): Promise<Response> {
  try {
    if (!enabled()) return Response.json({ error: { code: "NOT_FOUND", message: "Social content is not available." } }, { status: 404, headers });
    const query = parse(new URL(request.url).searchParams);
    return publicHttpResponse(request, Response.json({ data: await withListReadBudget("works", () => repository.listWorks(query), request.signal) }, { headers }), "social");
  } catch (cause) {
    const invalid = cause instanceof ContentServiceError && cause.code === "INVALID_QUERY";
    return Response.json({ error: { code: invalid ? "INVALID_QUERY" : "CONTENT_UNAVAILABLE",
      message: invalid ? "Invalid social query. Restart from the first page." : "Social content is temporarily unavailable." } }, { status: invalid ? 400 : 503, headers: invalid ? headers : { ...headers, "Retry-After": "1" } });
  }
}

/** Frozen v1 query remains limit/cursor only. */
export const socialWorksResponse = (request: Request, repository: SocialRepository, enabled: () => boolean) =>
  worksResponse(request, repository, enabled, parseCursorQuery);
export const socialTimelineWorksResponse = (request: Request, repository: SocialTimelineRepository, enabled: () => boolean) =>
  worksResponse(request, repository, enabled, parseSocialWorksQuery);
