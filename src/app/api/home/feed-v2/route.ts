import { homeFeedV2Repository } from "../../../../lib/content/home-feed-v2.ts";
import { homeFeedResponse } from "../../../../lib/content/home-feed-http.ts";
export const runtime="nodejs";
export const GET=(request:Request)=>homeFeedResponse(request,homeFeedV2Repository);
