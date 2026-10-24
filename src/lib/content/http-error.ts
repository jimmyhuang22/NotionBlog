import { ContentServiceError, type ContentErrorCode } from "../../../contracts/repository.ts";

const headers = { "Cache-Control": "no-store" };
const errorStatus: Record<ContentErrorCode, number> = {
  INVALID_QUERY: 400,
  CONTENT_UNAVAILABLE: 503,
  RATE_LIMITED: 503,
  MISCONFIGURED: 503,
};

export function error(code: ContentErrorCode | "NOT_FOUND", message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export function contentErrorResponse(cause: unknown): Response {
  if (cause instanceof ContentServiceError) {
    return error(cause.code, cause.message, errorStatus[cause.code]);
  }
  // Provider and SDK exception details can contain source IDs or credentials.
  return error("CONTENT_UNAVAILABLE", "Content is temporarily unavailable.", 503);
}
