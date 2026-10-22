"use client";

import Link from "next/link";
import { useRef, useState } from "react";

export interface CrumbLink { title: string; href: string }

/**
 * A note's trail: 学习, its course, the pages above it and the note. A deep note keeps the course
 * and its own parent and folds what lies between into one control that opens it in place. The
 * course goes by its code, since the directory beside or below names it in full. Two or more
 * pages between them fold, one alone is simply shown.
 */
export function NoteCrumbs({ trail, title, courseCode, project }: { trail: CrumbLink[]; title: string; courseCode: string | null; project?: CrumbLink | null }) {
  const [open, setOpen] = useState(false);
  const firstHidden = useRef<HTMLAnchorElement>(null);
  const [course, ...above] = trail;
  const middle = above.slice(0, -1);
  const folded = !open && middle.length >= 2;
  const shown = folded ? [course!, ...above.slice(-1)] : trail;
  const parent = trail.at(-1) ?? project ?? { href: "/study", title: "学习" };
  return (
    <>
    <nav className="note-back" aria-label="返回上一级"><Link href={parent.href} prefetch={false}><span aria-hidden="true">←</span><span>{parent === course && courseCode ? courseCode : parent.title}</span></Link></nav>
    <nav className="crumbs note-crumbs" aria-label="面包屑">
      {/* The section root is ours to render: a provider may or may not include it in the trail. */}
      <Link href="/study">学习</Link><span aria-hidden="true">›</span>
      {project ? <><Link href={project.href} prefetch={false}>{project.title}</Link><span aria-hidden="true">›</span></> : null}
      {shown.map((link, index) => (
        <span key={link.href} style={{ display: "contents" }}>
          {folded && index === 1 ? (
            <>
              <button type="button" className="crumbs__more" aria-expanded="false" aria-label={`显示中间的 ${middle.length} 层`}
                onClick={() => { setOpen(true); requestAnimationFrame(() => firstHidden.current?.focus()); }}>…</button>
              <span aria-hidden="true">›</span>
            </>
          ) : null}
          <Link ref={!folded && index === 1 ? firstHidden : undefined} prefetch={false} href={link.href}>{index === 0 && courseCode ? courseCode : link.title}</Link>{index < shown.length - 1 ? <span aria-hidden="true">›</span> : null}
        </span>
      ))}
      <span className="visually-hidden" aria-current="page">{title}</span>
    </nav>
    </>
  );
}
