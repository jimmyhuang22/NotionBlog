import { discoveryOptions,robotsText } from "../../lib/seo/discovery.ts";
import { contentErrorResponse } from "../../lib/content/http.ts";
export const dynamic="force-dynamic";
export async function GET() {try {return new Response(robotsText(discoveryOptions(process.env)),{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"private, no-store"}});}catch(e){return contentErrorResponse(e);}}
