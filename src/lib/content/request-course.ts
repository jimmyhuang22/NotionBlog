import { cache } from "react";
import type { ContentRepository } from "../../../contracts/repository.ts";

/** React discards this memo between renders; route handlers and Proxy do not retain it. */
export const requestCourseMetadata = cache((repository: ContentRepository, slug: string) => repository.getCourseMetadata
  ? repository.getCourseMetadata(slug)
  : repository.get("course",slug).then(detail => detail?.item ?? null));
