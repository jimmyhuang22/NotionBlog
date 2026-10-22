import { homeFeedRepository } from "../../../../lib/content/home-feed.ts";
import { homeFeedResponse } from "../../../../lib/content/home-feed-http.ts";
export const runtime = "nodejs";
export const GET = (request: Request) => homeFeedResponse(request, homeFeedRepository);
