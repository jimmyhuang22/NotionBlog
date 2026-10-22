import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StudyCourseGrid } from "@/components/study-course-grid";
import { getStudyProjects } from "@/lib/content/study";
import { coursesBySemester } from "@/lib/study-projects";
import { semesterLabel } from "@/lib/format";
import { freshWhenUncached } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;
type Props = { params: Promise<{ project: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { project } = await params;
  const item = (await getStudyProjects()).find(item => item.slug === project);
  return { title: item ? [item.code, item.title].filter(Boolean).join(" · ") : "学习项目" };
}

export default async function StudyProjectPage({ params }: Props) {
  await freshWhenUncached();
  const { project } = await params;
  const item = (await getStudyProjects()).find(item => item.slug === project);
  if (!item) notFound();
  const groups = coursesBySemester(item.courses);
  return <div className="wrap study-project-detail">
    <nav className="crumbs" aria-label="面包屑"><Link href="/study">学习</Link><span aria-hidden="true">›</span><span aria-current="page">{item.code || item.title}</span></nav>
    <header className="page-head study-project-head">{item.code ? <p className="eyebrow">{item.code}</p> : null}<h1>{item.title}</h1></header>
    {item.layout === "semesters" ? <>
      {groups.map(([semester, courses], index) => <section className="semester semester--gallery" id={`semester-${index}`} key={semester ?? "none"}>
        <header className="semester__head"><h2 className="section-title">{semesterLabel(semester)}</h2></header><StudyCourseGrid courses={courses} />
      </section>)}
    </> : <StudyCourseGrid courses={item.courses} />}
  </div>;
}
