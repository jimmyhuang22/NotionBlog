"use client";

import Link from "next/link";
import { useStudyReadingTree } from "@/components/study-reading-context";
import { missingStudyChildren, studyEntryType } from "@/lib/study-overview";
import { StudyTypeIcon } from "@/components/study-type-icon";
import { LinkPending } from "@/components/link-pending";

/** Uses the mounted directory; changing notes adds no tree or course-detail request. */
export function StudyChildPages({ href, linkedHrefs }: { href: string; linkedHrefs: string[] }) {
  const tree = useStudyReadingTree();
  const children = missingStudyChildren(tree?.nodes ?? [], href, linkedHrefs);
  if (!children.length) return null;
  return <nav className="study-child-pages" aria-label="子页面"><h2>子页面</h2>{children.map(node => <Link className="child-page" href={node.href} key={node.id} prefetch={false}>
    <StudyTypeIcon type={studyEntryType(node)} /><span>{node.title}</span><span aria-hidden="true">→</span><LinkPending />
  </Link>)}</nav>;
}
