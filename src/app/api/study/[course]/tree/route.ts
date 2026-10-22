import { contentRepository } from "@/lib/content";
import { courseTreeResponse } from "@/lib/content/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ course: string }> }) {
  const { course } = await context.params;
  return courseTreeResponse(request, course, contentRepository);
}
