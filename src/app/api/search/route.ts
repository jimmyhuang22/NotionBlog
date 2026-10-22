import { contentRepository } from "../../../lib/content/index.ts";
import { websiteQueryResponse } from "../../../lib/content/website-http.ts";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export const GET=(request: Request)=>websiteQueryResponse(request,contentRepository,"search");
