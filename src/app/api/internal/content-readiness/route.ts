import { privateContentReadinessResponse } from "../../../../server/content-readiness/response.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;
export function POST(request: Request) {
  return privateContentReadinessResponse(request, process.env, async () =>
    (await import("../../../../server/database/runtime.ts")).getDatabaseRuntime().repository);
}
