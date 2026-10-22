import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CourseTreeNav } from "@/components/course-tree";
import { DirectoryRetry } from "@/components/directory-retry";
import { NotePager, type PagerLink } from "@/components/note-pager";
import { StudyReadingDirectory } from "@/components/study-reading-directory";
import { StudyReadingProvider } from "@/components/study-reading-context";
import { courseName } from "@/lib/format";
import { getCourseMetadata } from "@/lib/request-cache";
import { getStudyReadingTree } from "@/lib/content/study-reading";
import type { StudyNode } from "../../../../../contracts/content.ts";
import { ContentServiceError } from "../../../../../contracts/repository.ts";
import { alwaysFresh } from "@/lib/page-freshness";

function flatten(nodes: StudyNode[]): PagerLink[] {
  return nodes.flatMap(node => [{ href: node.href, title: node.title }, ...flatten(node.children ?? [])]);
}

/** The directory streams on its own: a slow or failed tree never holds back the page beside it. */
async function Directory({ course }: { course: string }) {
  try {
    const tree = await getStudyReadingTree(course);
    if (!tree) return <DirectoryRetry />;
    return tree.nodes.length ? <CourseTreeNav nodes={tree.nodes} /> : <div className="state"><p>这门课还没有笔记。</p></div>;
  } catch (error) {
    return <DirectoryRetry busy={error instanceof ContentServiceError && error.code === "RATE_LIMITED"} />;
  }
}

async function Pager({ course }: { course: string }) {
  try {
    const tree = await getStudyReadingTree(course);
    return tree ? <NotePager order={flatten(tree.nodes)} /> : null;
  } catch {
    return null;
  }
}

/**
 * Shared by every note under a course. Next keeps a layout mounted while the
 * reader moves between its pages, so the directory is read once per visit rather than per note.
 */
export default async function CourseLayout({ children, params }: { children: React.ReactNode; params: Promise<{ course: string }> }) {
  await alwaysFresh();
  const { course } = await params;
  const item = await getCourseMetadata(course);
  if (!item) notFound();
  return (
    <StudyReadingProvider tree={getStudyReadingTree(course).catch(() => null)}><div className="wrap wrap--wide reading">
      <StudyReadingDirectory>
        <div className="reading__side-course">
          <span className="reading__side-title">{item.code || "课程首页"}</span>
          <span className="reading__side-name">{courseName(item)}</span>
        </div>
        <Suspense fallback={<div className="state" role="status"><p>正在加载课程目录，请稍候…</p></div>}>
          <Directory course={course} />
        </Suspense>
      </StudyReadingDirectory>
      <div className="reading__main">
        {children}
        <Suspense fallback={null}><Pager course={course} /></Suspense>
      </div>
    </div></StudyReadingProvider>
  );
}
