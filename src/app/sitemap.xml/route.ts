import { contentRepository } from "../../lib/content/index.ts";
import { contentFeatures } from "../../../config/features.ts";
import { discoveryOptions,sitemapXml } from "../../lib/seo/discovery.ts";
import { contentErrorResponse } from "../../lib/content/http.ts";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET() {try{return new Response(await sitemapXml(contentRepository,contentFeatures,discoveryOptions(process.env)),{headers:{"Content-Type":"application/xml; charset=utf-8","Cache-Control":"private, no-store"}});}catch(e){return contentErrorResponse(e);}}
