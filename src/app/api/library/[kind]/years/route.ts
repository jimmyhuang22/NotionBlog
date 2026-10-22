import { contentRepository } from "../../../../../lib/content/index.ts";
import { libraryYearsResponse } from "../../../../../lib/content/http.ts";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await context.params;
  return libraryYearsResponse(request, kind, contentRepository);
}
