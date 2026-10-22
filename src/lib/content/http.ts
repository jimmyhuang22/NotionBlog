import { publicHttpResponse } from "../../server/public-cache/http.ts";
import {
  contentFeatures,
  isEnabledContentKind,
  type ContentFeatures,
} from "../../../config/features.ts";
import {
  ContentServiceError,
  type ContentErrorCode,
  type ContentRepository,
} from "../../../contracts/repository.ts";
import { parseListQuery, parseLibraryYearsQuery } from "./query.ts";
import { isLibraryKind } from "./years.ts";

const headers = { "Cache-Control": "no-store" };
const errorStatus: Record<ContentErrorCode, number> = {
  INVALID_QUERY: 400,
  CONTENT_UNAVAILABLE: 503,
  RATE_LIMITED: 503,
  MISCONFIGURED: 503,
};

function error(code: ContentErrorCode | "NOT_FOUND", message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

function unavailableKind(): Response {
  return error("NOT_FOUND", "Content kind is not available.", 404);
}

export function contentErrorResponse(cause: unknown): Response {
  if (cause instanceof ContentServiceError) {
    return error(cause.code, cause.message, errorStatus[cause.code]);
  }
  // Provider and SDK exception details can contain source IDs or credentials.
  return error("CONTENT_UNAVAILABLE", "Content is temporarily unavailable.", 503);
}

export async function contentListResponse(
  request: Request,
  kind: string,
  repository: ContentRepository,
  features: ContentFeatures = contentFeatures,
): Promise<Response> {
  if (!isEnabledContentKind(kind, features)) return unavailableKind();
  try {
    const query = parseListQuery(kind, new URL(request.url).searchParams);
    return publicHttpResponse(request, Response.json({ data: await repository.list(kind, query) }, { headers }), "content");
  } catch (cause) {
    return contentErrorResponse(cause);
  }
}

export async function statusYearsResponse(
  request: Request,
  repository: ContentRepository,
  features: ContentFeatures = contentFeatures,
): Promise<Response> {
  if (!isEnabledContentKind("status", features)) return unavailableKind();
  try {
    if (new URL(request.url).searchParams.size > 0) throw new ContentServiceError("INVALID_QUERY", "Status year summaries do not support query parameters.");
    if (!repository.getStatusYears) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Status years are unavailable.");
    return publicHttpResponse(request, Response.json({ data: await repository.getStatusYears() }, { headers }), "content");
  } catch (cause) { return contentErrorResponse(cause); }
}

export async function libraryYearsResponse(
  request: Request,
  kind: string,
  repository: ContentRepository,
  features: ContentFeatures = contentFeatures,
): Promise<Response> {
  if (!isLibraryKind(kind) || !isEnabledContentKind(kind, features)) return unavailableKind();
  try {
    const query = parseLibraryYearsQuery(kind, new URL(request.url).searchParams);
    if (!repository.getLibraryYears) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Library years are unavailable.");
    return publicHttpResponse(request, Response.json({ data: await repository.getLibraryYears(kind, query) }, { headers }), "content");
  } catch (cause) { return contentErrorResponse(cause); }
}

export async function contentDetailResponse(
  request: Request,
  kind: string,
  slug: string,
  repository: ContentRepository,
  features: ContentFeatures = contentFeatures,
): Promise<Response> {
  if (!isEnabledContentKind(kind, features)) return unavailableKind();
  try {
    if (new URL(request.url).searchParams.size > 0) {
      throw new ContentServiceError("INVALID_QUERY", "Detail requests do not support query parameters.");
    }
    if (!slug || slug.length > 256 || /[\u0000-\u001f\u007f]/.test(slug)) {
      throw new ContentServiceError("INVALID_QUERY", "Invalid content slug.");
    }
    const detail = await repository.get(kind, slug);
    if (!detail) return error("NOT_FOUND", "Content is not available.", 404);
    return publicHttpResponse(request, Response.json({ data: detail }, { headers }), "content");
  } catch (cause) {
    return contentErrorResponse(cause);
  }
}

export async function courseTreeResponse(
  request: Request,
  courseSlug: string,
  repository: ContentRepository,
  features: ContentFeatures = contentFeatures,
): Promise<Response> {
  if (!isEnabledContentKind("course", features)) return unavailableKind();
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "parentId") || params.getAll("parentId").length > 1) {
      throw new ContentServiceError("INVALID_QUERY", "Unsupported course tree query.");
    }
    const parentId = params.get("parentId") ?? undefined;
    if (!courseSlug || courseSlug.length > 256 || /[\u0000-\u001f\u007f]/.test(courseSlug) || (parentId !== undefined && (!parentId || parentId.length > 256 || /[\u0000-\u001f\u007f]/.test(parentId)))) {
      throw new ContentServiceError("INVALID_QUERY", "Invalid course tree identity.");
    }
    const tree = await repository.getCourseTree(courseSlug, parentId);
    if (!tree) return error("NOT_FOUND", "Course tree is not available.", 404);
    return publicHttpResponse(request, Response.json({ data: tree }, { headers }), "content");
  } catch (cause) { return contentErrorResponse(cause); }
}
