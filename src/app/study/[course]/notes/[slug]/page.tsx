import type { Metadata } from "next";
import { Suspense } from "react";
import { contentMetadata } from "@/lib/seo/metadata";
import { notFound } from "next/navigation";
import { TocList } from "@/components/blocks";
import { NoteCrumbs } from "@/components/note-crumbs";
import { ReadingOutline } from "@/components/reading-outline";
import { RichDocumentBody } from "@/components/rich-document";
import { StudyChildPages } from "@/components/study-child-pages";
import { StudyLinkContexts } from "@/components/study-reading-context";
import { studyLinkContexts } from "@/lib/study-link-context";
import { rangeLabel } from "@/lib/format";
import { getCourseMetadata, getNote } from "@/lib/request-cache";
import { getSiteConfig } from "@/lib/site";
import { studyProjectForCourse } from "@/lib/study-projects";
import { documentStudyLinks } from "@/lib/study-overview";
import type { StudyNoteType } from "../../../../../../contracts/content.ts";
import { freshWhenUncached } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;

type Props = { params: Promise<{ course: string; slug: string }> };

const noteTypes: Record<StudyNoteType, string | null> = {
  course: "课程笔记", assignment: "作业", summary: "总结", note: "笔记", quiz: "测验",
  test: "考试", textbook: "教材", tool: "工具", unknown: null,
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { course, slug } = await params;
  try {
    const [owner, note] = await Promise.all([getCourseMetadata(course), getNote(slug)]);
    const item = owner && note?.item.courseId === owner.id ? note.item : null;
    return { ...contentMetadata(item), title: item?.title ?? "笔记" };
  } catch {
    return { ...contentMetadata(null), title: "笔记" };
  }
}

export default async function NotePage({ params }: Props) {
  await freshWhenUncached();
  const { course, slug } = await params;
  const [courseItem, note] = await Promise.all([getCourseMetadata(course), getNote(slug)]);
  // A note reached through another course's address is treated as not available.
  if (!courseItem || !note || note.item.courseId !== courseItem.id) notFound();
  const { item, document } = note;
  const project = studyProjectForCourse(courseItem, getSiteConfig().studyProjects);
  const toc = document?.toc ?? [];
  const typeLabel = noteTypes[item.noteType];
  const date = rangeLabel(item.date, getSiteConfig().timeZone);
  const trail = item.breadcrumbs.filter(link => link.href !== "/study");
  return (
    <>
      <StudyLinkContexts owner={item.href} labels={studyLinkContexts(document)} />
      <NoteCrumbs trail={trail} title={item.title} courseCode={trail[0]?.href === courseItem.href ? courseItem.code : null} project={project ? { title: project.code || project.title, href: project.href } : null} />
      <div className={toc.length ? "reading__body reading__body--toc" : "reading__body"}>
        <article className="reading__article card">
          {typeLabel || date ? (
            <p className="reading__tags">
              {typeLabel ? <span className="tag tag--sky">{typeLabel}</span> : null}
              {date ? <span className="tag">{date}</span> : null}
            </p>
          ) : null}
          <h1 className="reading__title">{item.title}</h1>
          {toc.length ? <details className="toc-drawer"><summary>本页目录</summary><TocList toc={toc} /></details> : null}
          <RichDocumentBody document={document} imagePreviewWidth={800} />
          <Suspense fallback={null}><StudyChildPages href={item.href} linkedHrefs={documentStudyLinks(document)} /></Suspense>
        </article>
        {toc.length ? (
          <nav className="reading__toc" aria-label="本页目录">
            <ReadingOutline toc={toc} />
          </nav>
        ) : null}
      </div>
    </>
  );
}
