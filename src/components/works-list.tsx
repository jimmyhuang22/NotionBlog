"use client";

import type { Page } from "../../contracts/content.ts";
import type { SocialPlatform } from "../../contracts/social.ts";
import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { groupWorksByPublishedYear } from "../lib/works.ts";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { useToday } from "./use-today";
import { WorksCard } from "./works-card";
import { ARRIVING_ROWS, arrivalStyle, useFilterArrival } from "./use-filter-arrival";

/**
 * One platform's works (the owner's choice, 2026-10-18): Bilibili four to a row, Xiaohongshu five, two
 * on a phone. Newest first they fall under year headings by the date they are ordered by; ordered by
 * views or likes they are one run. The query, and so the remembered list, follows platform and order.
 * Days are named by this device's clock once the page is running (`useToday`).
 */
export function WorksList({ initial, platform, order, pageSize, timeZone }: {
  initial: Page<SocialTimelineWork>; platform: SocialPlatform; order: "views" | "likes" | null; pageSize: number; timeZone: string;
}) {
  const query = { limit: String(pageSize), platform, ...(order ? { order } : {}) };
  const { items, restarted, total, appendedFrom, paged, ...paging } = usePagedList<SocialTimelineWork>("/api/social/works/v2", query, initial, true);
  const today = useToday(timeZone);
  // A new order on the same platform: its first cards come in one after another (2026-10-20).
  const arriving = useFilterArrival(platform);
  const firstRows = new Set(arriving ? (initial.items ?? []).slice(0, ARRIVING_ROWS).map(work => work.id) : []);
  const rank = new Map([...firstRows].map((id, index) => [id, index]));
  if (!items.length) return <div className="state"><p>还没有作品。</p></div>;
  const appended = appendedFrom === null ? null : new Set(items.slice(appendedFrom).map(work => work.id));
  const groups = order ? [{ year: null, works: items }] : groupWorksByPublishedYear(items, timeZone);
  return (
    <>
      {restarted ? <p className="notice" role="status">内容有更新，已从第一件重新加载。</p> : null}
      {groups.map(({ year, works }) => (
        <section key={`${year?.key ?? "run"}:${works[0]!.id}`} className="works__group" aria-label={year?.label}>
          {year ? <h2 className="section-title">{year.label}</h2> : null}
          <ul className={`works__grid works__grid--${platform}`}>
            {works.map(work => <li key={work.id} className={appended?.has(work.id) ? "is-appended" : rank.has(work.id) ? "is-arriving" : undefined} style={rank.has(work.id) ? arrivalStyle(rank.get(work.id)!) : undefined}><WorksCard work={work} timeZone={timeZone} today={today} withYear={order !== null} /></li>)}
          </ul>
        </section>
      ))}
      {paged ? <ListTail className="works__more" paging={paging} label="加载更多作品" end="到底了" status={pagingMessage(paging.problem, items.length, "件", total)} /> : null}
    </>
  );
}
