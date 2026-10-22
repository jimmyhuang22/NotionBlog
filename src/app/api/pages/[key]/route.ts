import { contentRepository } from "../../../../lib/content/index.ts";
import { sitePageResponse } from "../../../../lib/content/website-http.ts";
export const runtime="nodejs";
export async function GET(request: Request,context:{params:Promise<{key:string}>}) {return sitePageResponse(request,(await context.params).key,contentRepository);}
