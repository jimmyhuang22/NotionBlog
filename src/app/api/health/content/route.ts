import { contentRepository,getContentProvider } from "../../../../lib/content/index.ts";
import { contentErrorResponse } from "../../../../lib/content/http.ts";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET() {
  try{await contentRepository.getTimeline({limit:1});const provider=getContentProvider();return Response.json({data:{provider,...(provider==="database"?{databaseVersion:process.env.DATABASE_CONTENT_VERSION??"1"}:{})}},{headers:{"Cache-Control":"private, no-store","X-Robots-Tag":"noindex, nofollow"}});}catch(e){return contentErrorResponse(e);}
}
