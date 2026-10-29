import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CoverImage } from "@/components/cover-image";
import { DirectoryRetry } from "@/components/directory-retry";
import { RichDocumentBody } from "@/components/rich-document";
import { StudyOverview } from "@/components/study-overview";
import { LinkPending } from "@/components/link-pending";
import { courseName, semesterLabel } from "@/lib/format";
import { getCourse, getCourseTree } from "@/lib/request-cache";
import { studyProjectForCourse } from "@/lib/study-projects";
import { courseQuickLinks } from "@/lib/study-overview";
import { getSiteConfig } from "@/lib/site";
import type { ContentBlock } from "../../../../contracts/content.ts";
import { ContentServiceError } from "../../../../contracts/repository.ts";
import { contentMetadata } from "@/lib/seo/metadata";
import { alwaysFresh } from "@/lib/page-freshness";

type Props = { params: Promise<{ course: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { course } = await params;
  try {
    const item = (await getCourse(course))?.item ?? null;
    return { ...contentMetadata(item), title: item?.title ?? "课程" };
  } catch { return { ...contentMetadata(null), title: "课程" }; }
}

async function Materials({ course, quickLinks }: { course: string; quickLinks: string[] }) {
  try {
    const tree = await getCourseTree(course);
    return tree ? <StudyOverview nodes={tree.nodes} quickLinks={quickLinks} timeZone={getSiteConfig().timeZone} /> : <DirectoryRetry />;
  } catch (error) {
    // Busy says "try again in a moment", as the notes layout does, rather than inviting repeated retries.
    return <DirectoryRetry busy={error instanceof ContentServiceError && error.code === "RATE_LIMITED"} />;
  }
}

/** The custom overview replaces the embedded database; preserve any other course introduction. */
function introBlocks(blocks: ContentBlock[], coverId: string | undefined): ContentBlock[] {
  return blocks.flatMap<ContentBlock>(block => {
    if (block.type === "child-page" || block.type === "unsupported" || block.type === "image" && block.image.id === coverId) return [];
    if (block.type === "paragraph" && block.text.every(run => !run.text.trim())) return [];
    if (block.type === "columns") {
      const columns = block.columns.map(column => ({ ...column, blocks: introBlocks(column.blocks, coverId) })).filter(column => column.blocks.length);
      return columns.length ? [{ ...block, columns }] : [];
    }
    return [block];
  });
}

export default async function CoursePage({ params }: Props) {
  await alwaysFresh();
  const { course } = await params;
  const detail = await getCourse(course);
  if (!detail) notFound();
  const { item, document } = detail;
  const project = studyProjectForCourse(item, getSiteConfig().studyProjects);
  const links = courseQuickLinks(document);
  const intro = introBlocks(document?.blocks ?? [], item.cover?.id);
  return <div className="wrap course-landing">
    <nav className="crumbs" aria-label="面包屑"><Link href="/study">学习</Link><span aria-hidden="true">›</span>
      {project ? <><Link href={project.href} prefetch={false}>{project.code || project.title}</Link><span aria-hidden="true">›</span></> : null}
      {item.semester ? <><span>{semesterLabel(item.semester)}</span><span aria-hidden="true">›</span></> : null}<span aria-current="page">{item.code || item.title}</span>
    </nav>
    <header className="course-head course-head--overview"><div>
      <h1>{courseName(item)}</h1>
      {links.length ? <nav className="course-quick-links" aria-label="课程资料">{links.map(link => <Link key={link.href} href={link.href} prefetch={false}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 2.5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5ZM11.5 2.5v5h5M7 11h6M7 14h4" /></svg>
        <span>{link.title}</span><span className="course-quick-links__arrow" aria-hidden="true">→</span><LinkPending />
      </Link>)}</nav> : null}
    </div>{item.cover ? <CoverImage className="course-head__cover" image={item.cover} previewWidth={800} label="课程封面" /> : null}</header>
    {intro.length && document ? <details className="course-introduction"><summary>课程介绍</summary><RichDocumentBody document={{ ...document, blocks: intro }} imagePreviewWidth={800} /></details> : null}
    <Suspense fallback={<div className="state" role="status"><p>正在加载课程目录…</p></div>}><Materials course={course} quickLinks={links.map(link => link.href)} /></Suspense>
  </div>;
}
