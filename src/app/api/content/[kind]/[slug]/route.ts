import { contentRepository } from "../../../../../lib/content/index.ts";
import { contentDetailResponse } from "../../../../../lib/content/http.ts";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string; slug: string }> },
): Promise<Response> {
  const { kind, slug } = await context.params;
  return contentDetailResponse(request, kind, slug, contentRepository);
}
