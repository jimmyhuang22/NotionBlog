import { ContentServiceError } from "../../../../../contracts/repository.ts";
import { contentErrorResponse, error } from "../../../../lib/content/http-error.ts";
import { parseSnippets, renderSnippets } from "../../../../lib/render/server.ts";
import { limitRender, RenderRateLimitedError } from "../../../../server/render-rate-limit.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Covers 60,000 fully escaped UTF-16 source characters plus the bounded ids/languages.
const MAX_BODY_BYTES = 400 * 1024;
const BODY_TIMEOUT_MS = 3000;

function invalidInput(): never {
  throw new ContentServiceError("INVALID_QUERY", "Invalid rendering request.");
}

function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    // Nginx supplies the public Host even when the application's Request URL is loopback HTTP.
    const url = new URL(request.url);
    const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
    const host = request.headers.get("host") ?? url.host;
    return ["http", "https"].includes(protocol) && parsed.origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

async function requestBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
      request.headers.has("content-encoding") || !request.body ||
      length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) invalidInput();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(BODY_TIMEOUT_MS)]);
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) invalidInput();
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) invalidInput();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) invalidInput();
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return error("INVALID_QUERY", "Same-origin requests are required.", 403);
  try {
    return await limitRender(request.headers, async () => {
      let input: unknown;
      try { input = await requestBody(request); } catch { invalidInput(); }
      const snippets = parseSnippets(input);
      if (!snippets) invalidInput();
      return Response.json(await renderSnippets(snippets), { headers: { "Cache-Control": "no-store" } });
    });
  } catch (cause) {
    const response = contentErrorResponse(cause);
    if (cause instanceof RenderRateLimitedError) response.headers.set("Retry-After", String(cause.retryAfterSeconds));
    return response;
  }
}
