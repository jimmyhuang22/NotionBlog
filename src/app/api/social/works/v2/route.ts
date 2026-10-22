import { socialTimelineRepository, isSocialWorksEnabled } from "../../../../../lib/content/social-timeline.ts";
import { socialTimelineWorksResponse } from "../../../../../lib/content/social-http.ts";
export const runtime="nodejs";
export const GET=(request:Request)=>socialTimelineWorksResponse(request,socialTimelineRepository,isSocialWorksEnabled);
