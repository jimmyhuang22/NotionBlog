"use client";

import Link from "next/link";
import type { Page, Project } from "../../contracts/content.ts";
import { projectLinks, projectMeta } from "../lib/project.ts";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";

export function ProjectLinks({ project }: { project: Project }) {
  const links = projectLinks(project);
  if (!links.length) return null;
  return (
    <p className="project__links">
      {links.map(link => <a key={`${link.label}:${link.url}`} className="rt-link" href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<span aria-hidden="true"> ↗</span></a>)}
    </p>
  );
}

export function ProjectStack({ project }: { project: Project }) {
  return project.stack.length ? <p className="project__stack">{project.stack.map(name => <span key={name} className="tag">{name}</span>)}</p> : null;
}

export function ProjectList({ initial, pageSize, timeZone }: { initial: Page<Project>; pageSize: number; timeZone: string }) {
  const { items, restarted, total, paged, ...paging } = usePagedList<Project>("/api/content/project", { limit: String(pageSize) }, initial);
  if (!items.length) return <div className="state"><p>还没有项目。</p></div>;
  return (
    <>
      {restarted ? <p className="notice" role="status" style={{ marginBottom: 20 }}>项目列表有更新，已从头重新加载。</p> : null}
      {items.map(project => (
        <article key={project.id} className="card project-card">
          <div className="project-card__main">
            <p className="project-card__meta">{projectMeta(project, timeZone)}</p>
            <h2 className="project-card__title"><Link href={project.href} prefetch={false}>{project.title}</Link></h2>
            {project.summary ? <p className="project-card__summary">{project.summary}</p> : null}
          </div>
          {project.stack.length || projectLinks(project).length ? (
            <div className="project-card__side">
              <ProjectStack project={project} />
              <ProjectLinks project={project} />
            </div>
          ) : null}
        </article>
      ))}
      {paged ? <ListTail className="library__more" paging={paging} label="加载更多" status={pagingMessage(paging.problem, items.length, "个", total)} /> : null}
    </>
  );
}
