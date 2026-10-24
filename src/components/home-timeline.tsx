"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { HomeFeedV2Item, HomeFeedV2Page } from "../../contracts/social-timeline.ts";
import { isNoticedActivity } from "../lib/home-feed.ts";
import { entryMoment, eventDetail, eventKinds, eventMoment, feedRuns, spanMoment, type WorkEvent } from "../lib/timeline.ts";
import { CoverImage } from "./cover-image";
import { PlatformChips } from "./platform-chips";
import { cardTimeLabel, platformChips } from "../lib/library.ts";
import { EntryMoment } from "./entry-moment";
import { MonthLabel } from "./month-label";
import { isBiliCard } from "./bili-card";
import { HomeWorks } from "./home-works";
import { SocialWorkCard } from "./social-work-card";
import { StatusBody } from "./status-body";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { useToday } from "./use-today";

/**
 * A game on the home timeline, as one line (the owner's choice, 2026-10-18): a small square of its
 * cover, then "在玩 {title}" whatever its status (the entry stands on the day it was last played; a
 * platinum or cleared one reads the same, no mark), then its platforms in their makers' colours. The
 * line wraps as a whole, chips and all, never through a word.
 */
function GameLine({ event }: { event: WorkEvent }) {
  const platforms = platformChips((event.detail ?? "").split(" · ").map(name => name.trim()).filter(Boolean));
  // The game's current total, written as on its card: none at all and unknown are left out.
  const time = cardTimeLabel(event.playedTime ?? null);
  const body: ReactNode = (
    <>
      {event.cover ? <CoverImage className="event__square" image={{ ...event.cover, alt: "" }} previewWidth={400} label="封面" lazy sized={false} fallback={<span className="event__square" aria-hidden="true" />} /> : <span className="event__square" aria-hidden="true" />}
      <span className="event__line">
        <span className="event__sentence"><span className="event__lead">在玩</span> <span className="event__title">{event.title}</span></span>
        {platforms.length || time ? (
          <span className="event__chips">
            {platforms.length ? <><span className="visually-hidden">，</span><PlatformChips chips={platforms} /></> : null}
            {time ? <span className="event__time"><span className="visually-hidden">，</span>{time}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );
  const className = "card event event--game event--line";
  if (event.href) return <Link className={className} href={event.href} prefetch={false}>{body}</Link>;
  return <div className={className}>{body}</div>;
}

function WorkCard({ event }: { event: WorkEvent }) {
  if (event.type.startsWith("game-")) return <GameLine event={event} />;
  const { kind, verb } = eventKinds[event.type];
  const detail = eventDetail(event);
  const body: ReactNode = (
    <>
      {/* The title already names the card, so the cover is not read out; one that cannot be read keeps its quiet place. */}
      {event.cover ? <CoverImage className="event__cover" image={{ ...event.cover, alt: "" }} previewWidth={400} label="封面" lazy sized={false} fallback={<span className="event__cover" aria-hidden="true" />} /> : null}
      <span className="event__text">
        <span className="event__verb">{verb}</span>
        <span className="event__title">{event.title}</span>
        {detail ? <span className="event__detail">{detail}</span> : null}
      </span>
    </>
  );
  const className = `card event event--${kind}`;
  if (event.href) return <Link className={className} href={event.href} prefetch={false}>{body}<span className="event__arrow" aria-hidden="true">›</span></Link>;
  // An update without a page on this site links to its source, or nowhere.
  if (event.externalUrl) return <a className={className} href={event.externalUrl} target="_blank" rel="noopener noreferrer">{body}<span className="event__arrow" aria-hidden="true">↗</span></a>;
  return <div className={className}>{body}</div>;
}

/**
 * Home only: status entries carry the timeline; other sections' updates and works published on other
 * platforms sit between them as cards. The merged order, the daily de-duplication and the paging all
 * come from the home feed endpoint. A work standing alone is one card in its platform's shape; works
 * that follow one another share one entry, as a strip of such cards or, without covers, a list. The first batch and every later page come from the same version
 * of it, because a cursor of one version is refused by the other. Entries of the last week are named by
 * today ("昨天 · …"), by this device's clock once the page is running (the cached markup writes dates
 * out in full), so a page
 * left open overnight moves on.
 */
/** How many rows of the first screen take part in the timeline's entrance. */
const DRAWN_ROWS = 8;

export function HomeTimeline({ initial, pageSize, timeZone }: { initial: HomeFeedV2Page; pageSize: number; timeZone: string }) {
  const { items, restarted, total, appendedFrom, paged, ...paging } = usePagedList<HomeFeedV2Item>("/api/home/feed-v2", { limit: String(pageSize) }, initial, true);
  const today = useToday(timeZone);
  if (!items.length) return <div className="state"><p>还没有动态。</p></div>;
  const leadId = items.find(item => item.source === "content" && item.event.type === "status")?.id;
  // Real works can stand beside demo content, so then each demo entry says so itself; the footer covers a page that is all demo.
  const markDemo = initial.sources.social !== "disabled";
  let previousMonth: string | undefined;
  return (
    <>
      {restarted ? <p className="notice timeline__notice" role="status">内容有更新，已从最新一条重新加载。</p> : null}
      {feedRuns(items, timeZone).map(({ first: index, items: run }, position) => {
        const item = run[0]!;
        const { month } = eventMoment(item.source === "content" ? item.event : item, timeZone);
        const moment = entryMoment((item.source === "content" ? item.event : item).occurredAt, timeZone, today);
        const span = run.length > 1 ? spanMoment(run, timeZone, today) : null;
        const monthKey = month?.key ?? "unknown";
        const heading = monthKey !== previousMonth
          ? <h3 className={index === 0 ? "timeline__month timeline__month--first" : "timeline__month"}>{month ? <MonthLabel monthKey={month.key} label={month.label} /> : "日期未记录"}</h3>
          : null;
        previousMonth = monthKey;
        const demo = markDemo && item.provider === "mock" ? <span className="tag tag--demo">演示</span> : null;
        return (
          <div key={item.id} className={appendedFrom !== null && index >= appendedFrom ? "is-appended" : undefined}
            /* The first screen's place in the ink line's entrance (motion.css); later rows arrive without it. */
            style={position < DRAWN_ROWS ? { "--i": position } as CSSProperties : undefined}>
            {heading}
            {item.source === "social" && run.length > 1 ? (
              <article className="entry entry--event entry--social">
                <p className="entry__meta">
                  {/* The days the run covers; a time of day would belong to one work only. */}
                  {span ? <span className="entry__time"><EntryMoment moment={span} /></span> : null}
                  <Link className="tag tag--social" href="/works" prefetch={false} title="全部作品">作品</Link>
                  <span className="entry__count">{run.length} 件</span>
                </p>
                <HomeWorks works={run.flatMap(entry => entry.source === "social" ? [entry.work] : [])} timeZone={timeZone} today={today} />
              </article>
            ) : item.source === "social" ? (
              <article className="entry entry--event entry--social">
                <p className="entry__meta">
                  {moment ? <time className="entry__time" dateTime={item.occurredAt?.start}><EntryMoment moment={moment} /></time> : null}
                  {/* The works page exists whenever these entries do: both follow the social source. */}
                  <Link className="tag tag--social" href="/works" prefetch={false} title="全部作品">作品</Link>
                  {/* Placed at the moment a change was noticed: said here, so the time is not read as a publication date. */}
                  {item.work.collection && isNoticedActivity(item.work.collection) ? <span className="tag">发现更新</span> : null}
                </p>
                {/* A Bilibili work with a cover is the same card as in a run of works, one of it. */}
                {item.work.cover && isBiliCard(item.work)
                  ? <HomeWorks works={[item.work]} timeZone={timeZone} today={today} />
                  : <SocialWorkCard work={item.work} timeZone={timeZone} today={today} />}
              </article>
            ) : item.event.type === "status" ? (
              <article id={item.event.entry.id} className={item.id === leadId ? "entry entry--lead" : "entry"}>
                {moment ? <time className="entry__time" dateTime={item.event.occurredAt?.start}><EntryMoment moment={moment} /></time> : null}
                {item.id === leadId ? <span className="entry__latest">最新动态</span> : null}
                {demo}
                <StatusBody entry={item.event.entry} />
                {/* Unsized here as before: the picture keeps its own shape under the height limit. */}
                {item.event.entry.cover ? <CoverImage className="entry__cover" image={item.event.entry.cover} previewWidth={800} label="动态封面" lazy sized={false} /> : null}
              </article>
            ) : (
              <article className="entry entry--event">
                <p className="entry__meta">
                  {moment ? <span className="entry__time"><EntryMoment moment={moment} /></span> : null}
                  <span className={`tag tag--${eventKinds[item.event.type].kind}`}>{eventKinds[item.event.type].section}</span>
                  {demo}
                </p>
                <WorkCard event={item.event} />
              </article>
            )}
          </div>
        );
      })}
      {paged ? <ListTail className="timeline__more" paging={paging} label="加载更早的内容" end="到底了" status={pagingMessage(paging.problem, items.length, "条", total)} /> : null}
    </>
  );
}
