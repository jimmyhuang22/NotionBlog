import Link from "next/link";
import type { Metadata } from "next";
import { getStudyProjects } from "@/lib/content/study";
import { LinkPending } from "@/components/link-pending";
import { alwaysFresh } from "@/lib/page-freshness";

// Kept for a day at most and dropped when the published content changes; see src/lib/page-freshness.ts.
export const revalidate = 86399;
export const metadata: Metadata = { title: "学习" };

export default async function StudyPage() {
  // Rendered per request (public cache review, 2026-10-21): its data still comes from the shared cache, but a
  // notice about a failed read must never be kept as the page.
  await alwaysFresh();
  const projects = await getStudyProjects();
  return <div className="wrap study-projects">
    <header className="page-head"><h1>学习</h1></header>
    {projects.length ? <div className="study-project-grid">{projects.map(project => <Link key={project.slug} href={project.href} prefetch={false} className="card study-project-card">
      {project.category ? <span className="study-project-card__category">{project.category}</span> : null}
      <span className="study-project-card__title">{project.code || project.title}</span>
      {project.code ? <span className="study-project-card__name">{project.title}</span> : null}
      <LinkPending />
    </Link>)}</div> : <div className="state"><p>还没有学习项目。</p></div>}
  </div>;
}
