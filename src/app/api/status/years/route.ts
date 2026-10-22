import { contentRepository } from "../../../../lib/content/index.ts";
import { statusYearsResponse } from "../../../../lib/content/http.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return statusYearsResponse(request, contentRepository);
}
