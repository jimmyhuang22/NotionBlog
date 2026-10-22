import "server-only";
import { cache } from "react";
import { getCourse, getCourseTree } from "@/lib/request-cache";
import { courseQuickLinks, studyReadingNodes } from "@/lib/study-overview";

/** Request-local only; all reading controls share already-qualified data, never an eligibility cache. */
export const getStudyReadingTree = cache(async (course: string) => {
  // The introduction is required to filter resources. Its metadata can serve
  // the tree read without opening another cold connection for the sidebar.
  const detail = await getCourse(course);
  if (!detail) return null;
  const tree = await getCourseTree(course);
  if (!tree) return null;
  return { ...tree, nodes: studyReadingNodes(tree.nodes, courseQuickLinks(detail.document).map(link => link.href)) };
});
