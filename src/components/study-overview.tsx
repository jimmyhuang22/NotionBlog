"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import type { DateRange, StudyNode } from "../../contracts/content.ts";
import { dateParts } from "@/lib/format";
import { studyOverviewEntries, studyReadingNodes, studyEntryType, studyDateText, studyTypeLabels, studyView, type StudyView } from "@/lib/study-overview";
import { LinkPending } from "@/components/link-pending";

const views: [StudyView, string][] = [["all", "总览"], ["notes", "笔记"], ["courses", "周课"], ["assignments", "作业"]];

function EntryDate({ date, timeZone }: { date: DateRange | null | undefined; timeZone: string }) {
  if (!date) return null;
  const start = dateParts(date.start, date.precision, timeZone);
  const end = date.end ? dateParts(date.end, date.precision, timeZone) : null;
  if (!start) return null;
  const [first, last] = studyDateText(start, end && date.end !== date.start ? end : null);
  return <span className="study-entry__date"><time dateTime={date.start}>{first}</time>{last ? <> <span aria-hidden="true">–</span><span className="visually-hidden">至</span> <time dateTime={date.end!}>{last}</time></> : null}</span>;
}

/** URL state uses native history, avoiding a server request for every keystroke. */
export function StudyOverview({ nodes, timeZone, quickLinks = [] }: { nodes: StudyNode[]; timeZone: string; quickLinks?: string[] }) {
  const search = useSearchParams();
  const view = studyView(search.get("view"));
  const query = search.get("q") ?? "";
  const ordered = useMemo(() => studyReadingNodes(nodes, quickLinks), [nodes, quickLinks]);
  const entries = studyOverviewEntries(ordered, view, query);
  function update(key: "view" | "q", value: string) {
    const url = new URL(window.location.href);
    if (!value || key === "view" && value === "all") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState(null, "", url);
  }
  useEffect(() => {
    const saved = window.history.state?.studyOverviewScroll;
    if (!saved || saved.url !== window.location.href || typeof saved.top !== "number") return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: saved.top, behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, []);
  // Choosing a kind (2026-10-20): the chosen look slides across, the old list fades and the new rows come in one by one (motion.css).
  const [switched, setSwitched] = useState(0);
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const place = (animate: boolean) => {
      const box = nav.current?.getBoundingClientRect();
      const button = nav.current?.querySelector('button[aria-pressed="true"]')?.getBoundingClientRect();
      if (!box || !button || !pill.current || !nav.current) return;
      pill.current.style.transition = animate ? "" : "none";
      Object.assign(pill.current.style, { width: `${button.width}px`, height: `${button.height}px`, top: `${button.top - box.top}px`, transform: `translateX(${button.left - box.left}px)` });
      nav.current.dataset.pill = "";
    };
    place(nav.current?.dataset.pill !== undefined);
    const resized = () => place(false);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [view]);
  function choose(next: StudyView) {
    if (next === view) return;
    const old = list.current;
    if (old && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const ghost = old.cloneNode(true) as HTMLElement;
      ghost.classList.add("study-entries--leaving");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      ghost.style.top = `${old.offsetTop}px`;
      old.parentElement?.append(ghost);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-out", fill: "forwards" }).finished.then(() => ghost.remove(), () => ghost.remove());
    }
    setSwitched(count => count + 1);
    update("view", next);
  }
  function rememberPosition() {
    window.history.replaceState({ ...window.history.state, studyOverviewScroll: { url: window.location.href, top: window.scrollY } }, "");
  }
  return <section className="study-overview" aria-label="课程纵览">
    <div className="study-overview__toolbar">
      <nav ref={nav} className="study-views segmented" aria-label="按材料类型筛选"><span ref={pill} className="study-views__pill" aria-hidden="true" />{views.map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => choose(key)}>{label}</button>)}</nav>
      <input className="study-overview__find" type="search" aria-label="在本课程目录中查找" placeholder="在本课程里查找" value={query} onChange={event => update("q", event.target.value)} />
    </div>
    <p className="visually-hidden" role="status" aria-live="polite">{entries.length} 个目录项</p>
    {entries.length ? <ul ref={list} key={switched ? `${view}:${switched}` : "first"} className="study-entries">{entries.map(({ node, path }, index) => {
      const type = studyEntryType(node);
      const arriving = switched > 0 && index < 12;
      return <li key={node.id} className={arriving ? "is-arriving" : undefined} style={arriving ? { "--i": index } as CSSProperties : undefined}><Link className="study-entry" href={node.href} prefetch={false} onNavigate={rememberPosition}>
        <span className={`study-entry__type study-type--${type.toLowerCase()}`}><i aria-hidden="true">{studyTypeLabels[type].mark}</i><span className="visually-hidden">{studyTypeLabels[type].name}</span></span>
        <span className="study-entry__name"><span className="study-entry__title">{node.title}</span>{path.length ? <span className="study-entry__path">{path.join(" › ")}</span> : null}</span><EntryDate date={node.date} timeZone={timeZone} /><LinkPending />
      </Link></li>;
    })}</ul> : <p className="study-overview__empty">{nodes.length ? "没有匹配的目录项。" : "这门课还没有笔记。"}</p>}
  </section>;
}
