"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StudyNode } from "../../contracts/content.ts";
import { studyEntryType } from "@/lib/study-overview";
import { StudyTypeIcon } from "@/components/study-type-icon";
import { LinkPending } from "@/components/link-pending";
import { useStudyLinkContexts } from "@/components/study-reading-context";

function contains(node: StudyNode, href: string): boolean {
  return node.href === href || (node.children ?? []).some(child => contains(child, href));
}

// Links never prefetch: a directory can list dozens of notes and each one costs upstream reads.
function NodeLink({ node, current }: { node: StudyNode; current: string }) {
  const type = studyEntryType(node);
  const labels = useStudyLinkContexts();
  return <Link className="tree__link" prefetch={false} href={node.href} aria-current={node.href === current ? "page" : undefined}>
    <span className={`tree__icon study-type--${type.toLowerCase()}`}><StudyTypeIcon type={type} /></span><span className="study-link-title"><span>{node.title}</span>{labels[node.href] ? <small>{labels[node.href]}</small> : null}</span><LinkPending />
  </Link>;
}

/**
 * A page that has pages under it: the link opens the page, a separate button shows or hides its
 * children. They are siblings so neither control sits inside the other.
 */
function Branch({ node, current }: { node: StudyNode; current: string }) {
  const children = node.children ?? [];
  const active = contains(node, current);
  const [open, setOpen] = useState(active);
  // The branch holding the current page opens however the reader got there; closing it stays their choice.
  useEffect(() => { if (active) setOpen(true); }, [active]);
  const listId = useId();
  // A press opens or closes the children by height (2026-10-20); arriving on a page, or with reduced motion, they are simply there.
  const box = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const pressed = useRef(false);
  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function toggle() {
    const element = box.current;
    if (!open) { pressed.current = true; setOpen(true); return; }
    if (closing) return;
    if (!element || still()) { setOpen(false); return; }
    setClosing(true);
    element.style.overflow = "hidden";
    const done = () => { element.style.overflow = ""; setClosing(false); setOpen(false); };
    element.animate([{ height: `${element.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 200, easing: "cubic-bezier(0.4, 0, 0.6, 1)" }).finished.then(done, done);
  }
  useLayoutEffect(() => {
    const element = box.current;
    if (!open || !pressed.current || !element) return;
    pressed.current = false;
    if (still()) return;
    element.style.overflow = "hidden";
    const done = () => { element.style.overflow = ""; };
    element.animate([{ height: "0px", opacity: 0 }, { height: `${element.offsetHeight}px`, opacity: 1 }], { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" }).finished.then(done, done);
  }, [open]);
  const shown = open && !closing;
  return (
    <>
      <div className="tree__row" data-active-branch={active || undefined}>
        <NodeLink node={node} current={current} />
        <button type="button" className="tree__toggle" aria-expanded={shown} aria-controls={listId} aria-label={`${shown ? "收起" : "展开"}“${node.title}”的 ${children.length} 个子页面`} onClick={toggle}>
          <span aria-hidden="true">›</span>
        </button>
      </div>
      <div ref={box} id={listId} hidden={!open}><Nodes nodes={children} current={current} /></div>
    </>
  );
}

function Nodes({ nodes, current }: { nodes: StudyNode[]; current: string }) {
  return (
    <ul className="tree">
      {nodes.map(node => (
        <li key={node.id}>{node.children?.length ? <Branch node={node} current={current} /> : <NodeLink node={node} current={current} />}</li>
      ))}
    </ul>
  );
}

/** A directory this long gets a finder above it; a short one is read at a glance. */
const FINDER_FROM = 30;

interface Hit { node: StudyNode; path: string[] }
function everyNode(nodes: StudyNode[], path: string[] = []): Hit[] {
  return nodes.flatMap(node => [{ node, path }, ...everyNode(node.children ?? [], [...path, node.title])]);
}

function Marked({ title, query }: { title: string; query: string }) {
  const at = title.toLocaleLowerCase().indexOf(query);
  if (at < 0) return <>{title}</>;
  return <>{title.slice(0, at)}<mark>{title.slice(at, at + query.length)}</mark>{title.slice(at + query.length)}</>;
}

/**
 * Finding a note by its title in a long course. While there is a query the tree gives way to a flat
 * list of the notes whose titles contain it, each with the pages it sits under; clearing the query,
 * or Escape, brings the tree back as it was.
 */
function Finder({ nodes, current }: { nodes: StudyNode[]; current: string }) {
  const labels = useStudyLinkContexts();
  const [search, setSearch] = useState({ path: current, query: "" });
  // Reset the finder without remounting the tree or losing its expanded branches.
  if (search.path !== current) setSearch({ path: current, query: "" });
  const query = search.path === current ? search.query : "";
  const setQuery = (query: string) => setSearch({ path: current, query });
  const all = useMemo(() => everyNode(nodes), [nodes]);
  const wanted = query.trim().toLocaleLowerCase();
  const hits = wanted ? all.filter(hit => `${hit.node.title} ${labels[hit.node.href] ?? ""}`.toLocaleLowerCase().includes(wanted)) : [];
  return (
    <>
      <div className="course-directory__head">
      <label className="tree-find">
        <span className="visually-hidden">在本课程目录里查找</span>
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="m10.5 10.5 3.2 3.2" strokeLinecap="round" /></svg>
        <input type="search" value={query} placeholder={`在 ${all.length} 篇里查找`} enterKeyHint="search"
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setQuery(""); }} />
      </label>
      <p className="tree__heading">课程目录</p>
      </div>
      <p className="visually-hidden" role="status">{wanted ? (hits.length ? `找到 ${hits.length} 篇` : "没有找到") : ""}</p>
      <nav className="course-directory__scroll" aria-label={wanted ? "目录查找结果" : "课程笔记"}>
      {wanted ? (
        hits.length ? (
          <ul className="tree tree--hits">
            {hits.map(({ node, path }) => (
              <li key={node.id}>
                <Link className="tree__link" prefetch={false} href={node.href} aria-current={node.href === current ? "page" : undefined}>
                  <span><Marked title={node.title} query={wanted} /></span>
                  {labels[node.href] ? <span className="tree__where"><Marked title={labels[node.href]} query={wanted} /></span> : null}
                  {path.length ? <span className="tree__where">{path.join(" › ")}</span> : null}
                  <LinkPending />
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="tree__none">没有标题包含“{query.trim()}”的笔记。</p>
      ) : null}
      <div hidden={!!wanted}><Nodes nodes={nodes} current={current} /></div>
      </nav>
    </>
  );
}

/**
 * Lives in the course layout, so it loads once and follows the reader from note to note. In the
 * directory dialog the list scrolls on its own; the current page is brought into its
 * visible part when it is out of it, and left alone when the reader can already see it.
 */
export function CourseTreeNav({ nodes }: { nodes: StudyNode[] }) {
  const current = usePathname();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A frame later: the branch holding the page opens in its own effect, and only then has a place.
    const frame = requestAnimationFrame(() => {
      const link = [...root.current?.querySelectorAll<HTMLElement>('[aria-current="page"]') ?? []].find(link => link.getClientRects().length);
      const pane = root.current?.querySelector<HTMLElement>(".course-directory__scroll");
      if (!link || !pane || pane.scrollHeight <= pane.clientHeight) return;
      const box = pane.getBoundingClientRect(), row = link.getBoundingClientRect();
      if (row.top >= box.top && row.bottom <= box.bottom) return;
      pane.scrollTo({ top: pane.scrollTop + row.top - box.top - (pane.clientHeight - row.height) / 2, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [current]);
  const long = useMemo(() => everyNode(nodes).length >= FINDER_FROM, [nodes]);
  return <div className="course-directory" ref={root}>{long ? <Finder nodes={nodes} current={current} /> : <>
    <p className="tree__heading">课程目录</p><nav className="course-directory__scroll" aria-label="课程笔记"><Nodes nodes={nodes} current={current} /></nav>
  </>}</div>;
}
