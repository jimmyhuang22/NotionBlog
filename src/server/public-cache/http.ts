import { contentErrorResponse } from "../../lib/content/http-error.ts";
import { createHash } from "node:crypto";
import { publicCacheEnabled, publicResponseHeaders, type PublicCacheScope } from "./policy.ts";

/** Applied only after the existing parser and current reader have accepted a response. */
async function applyPublicHttpResponse(request: Request, response: Response, scope: PublicCacheScope): Promise<Response> {
  if (!publicCacheEnabled() || !["GET", "HEAD"].includes(request.method) || ![200, 304].includes(response.status) || response.headers.has("set-cookie")) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(publicResponseHeaders(scope))) headers.set(key, value);
  if (response.status === 304) return new Response(null, { status: 304, headers });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const etag = headers.get("ETag") ?? `"pc1-${createHash("sha256").update(bytes).digest("hex")}"`;
  headers.set("ETag", etag);
  // This runs after the origin's normal checks. A withdrawn response can never turn into 304.
  const condition = request.headers.get("if-none-match");
  const matches = condition !== null && condition.length <= 8192 &&
    (condition.trim() === "*" || (condition.match(/(?:W\/)?"[^"\r\n]*"/g) ?? []).some(v => v.replace(/^W\//, "") === etag));
  if (matches) { headers.delete("Content-Length"); return new Response(null, { status: 304, headers }); }
  return new Response(request.method === "HEAD" ? null : bytes, { status: response.status, headers });
}

export async function publicHttpResponse(request: Request, response: Response, scope: PublicCacheScope): Promise<Response> {
  try { return await applyPublicHttpResponse(request, response, scope); }
  catch (cause) { return contentErrorResponse(cause); }
}

export function withPublicHttp<C>(scope: PublicCacheScope, handler: (request: Request, context: C) => Promise<Response>) {
  return async (request: Request, context: C) => {
    try { return await publicHttpResponse(request, await handler(request, context), scope); }
    catch (cause) { return contentErrorResponse(cause); }
  };
}
