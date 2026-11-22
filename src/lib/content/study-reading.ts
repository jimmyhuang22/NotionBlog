import "server-only";
import { cache } from "react";
import { getCourse, getCourseTree } from "@/lib/request-cache";
import { courseQuickLinks, studyReadingNodes } from "@/lib/study-overview";

/** Request-local only; all reading controls share already-qualified data, never an eligibility cache. */
export const getStudyReadingTree = cache(async (course: string) => {
  // The notes layout resolves the owner before starting these reads, so the
  // course detail cannot replace the metadata queued for readStudyNote.
  const [detail, tree] = await Promise.all([getCourse(course), getCourseTree(course)]);
  if (!detail || !tree || tree.courseId !== detail.item.id) return null;
  return { ...tree, nodes: studyReadingNodes(tree.nodes, courseQuickLinks(detail.document).map(link => link.href)) };
});
