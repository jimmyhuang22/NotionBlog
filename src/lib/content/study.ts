import "server-only";
import { cache } from "react";
import type { Course } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { contentRepository } from "./index.ts";
import { getSiteConfig } from "../site/index.ts";
import { studyProjects } from "../study-projects.ts";
import { traceContentRead } from "../../server/content-read-timing.ts";

/** Request-local only; every request still checks current publication eligibility. */
export const getStudyProjects = cache(() => traceContentRead("catalogue", "course", async () => {
  const courses: Course[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 20; round++) {
    const page = await contentRepository.list("course", { limit: 50, ...(cursor ? { cursor } : {}) });
    courses.push(...page.items);
    if (!page.hasMore) return studyProjects(courses, getSiteConfig().studyProjects);
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "Study catalogue exceeds its boundary.");
}));
