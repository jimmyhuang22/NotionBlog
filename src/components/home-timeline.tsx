"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { HomeFeedV2Item, HomeFeedV2Page, SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { isNoticedActivity, platformNames } from "../lib/home-feed.ts";
import { entryMoment, eventDetail, eventKinds, eventMoment, feedRuns, spanMoment, type WorkEvent } from "../lib/timeline.ts";
import { CoverImage } from "./cover-image";
import { cardTimeLabel, platformChips } from "../lib/library.ts";
import { GameTag } from "./game-tag";
import { EntryMoment } from "./entry-moment";
import { MonthLabel } from "./month-label";
import { HomeWorkLine, HomeWorks, workPlatforms } from "./home-works";
import { PlatformMark } from "./platform-signs";
import { StatusBody } from "./status-body";
import { ListTail } from "./list-tail";
import { pagingMessage, usePagedList } from "./use-paged-list";
import { useToday } from "./use-today";

/** The platforms a game event names, as their chips label them (Switch, PC, PlayStation). */
function gamePlatforms(event: WorkEvent): string[] {
  return platformChips((event.detail ?? "").split(" · ").map(name => name.trim()).filter(Boolean)).map(chip => chip.label);
}

/**
 * A game on the home timeline, drawn as a work published elsewhere is (2026-11-19, the owner's pick 丙): its wide
 * cover in the same 144 by 81 frame with the hours played at its foot, and the title alone beside it. What it is
 * and where it was played are said by the date row's tag ("在 Switch 上玩", GameTag), so nothing is said twice. Every
 * game reads "playing" whatever its status: a playing entry stands on the day it was last played; a platinum or
 * cleared one on its completion day (F47). Each game keeps its own row and day (2026-11-13).
 */
function GameLine({ event, priorityCover }: { event: WorkEvent; priorityCover: boolean }) {
  // The game's current total, written as on its card: none at all and unknown are left out.
  const time = cardTimeLabel(event.playedTime ?? null);
  const blank = <span className="work-line__blank" aria-hidden="true" />;
  const body: ReactNode = (
    <>
      <span className="work-line__text">
        <span className="work-line__title">{event.title}</span>
        {time ? <span className="visually-hidden">，已玩 {time}</span> : null}
      </span>
      <span className="work-line__thumb" aria-hidden="true">
        {event.cover ? <CoverImage className="work-line__cover" image={{ ...event.cover, alt: "" }} previewWidth={400} label="封面" lazy priority={priorityCover} sized={false} fallback={blank} /> : blank}
        {time ? <span className="work-line__stats"><span><ClockSign />{time}</span></span> : null}
      </span>
    </>
  );
  return (
    <div className="work-line work-line--game">
      {event.href ? <Link className="work-line__main" href={event.href} prefetch={false}>{body}</Link> : <div className="work-line__main">{body}</div>}
    </div>
  );
}

/** A clock, for the hours a game was played. */
function ClockSign() {
  return <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="5.8" /><path d="M8 5v3.2l2.2 1.3" /></svg>;
}

function WorkCard({ event, priorityCover }: { event: WorkEvent; priorityCover: boolean }) {
  if (event.type.startsWith("game-")) return <GameLine event={event} priorityCover={priorityCover} />;
  const { kind, verb } = eventKinds[event.type];
  const detail = eventDetail(event);
  const body: ReactNode = (
    <>
      {/* The title already names the card, so the cover is not read out; one that cannot be read keeps its quiet place. */}
      {event.cover ? <CoverImage className="event__cover" image={{ ...event.cover, alt: "" }} previewWidth={400} label="封面" lazy priority={priorityCover} sized={false} fallback={<span className="event__cover" aria-hidden="true" />} /> : null}
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
 * come from the home feed endpoint. A work standing alone is one light line with a small picture, and so is a game
 * (2026-11-11); works that follow one another share one entry: two or three as light lines one under another (F57,
 * 2026-11-18), four or more as a strip of cards or, without covers, a list. The first batch and every later page come from the same version
 * of it, because a cursor of one version is refused by the other. Entries of the last week are named by
 * today ("昨天 · …"), by this device's clock once the page is running (the cached markup writes dates
 * out in full), so a page
 * left open overnight moves on.
 */
/** How many rows of the first screen take part in the timeline's entrance. */
const DRAWN_ROWS = 8;
/** Whether this visit has drawn the home timeline already: coming back to the home page shows it at once. */
let drawnThisVisit = false;

/**
 * The mark of a row of works: the platforms' own signs in their own colours, nothing else (2026-11-19, the owner's
 * pick 乙: "作品" beside the sign said the same thing twice). It still leads to the works page, which exists whenever
 * these entries do; the words are read out.
 */
function WorksTag({ works }: { works: SocialTimelineWork[] }) {
  const platforms = workPlatforms(works);
  return (
    <Link className="work-marks" href="/works" prefetch={false} title="全部作品">
      {platforms.map(platform => <span key={platform} className={`work-marks__sign work-marks__sign--${platform}`}><PlatformMark platform={platform} size={16} /></span>)}
      <span className="visually-hidden">{platforms.map(platform => platformNames[platform]).join("、")}作品</span>
    </Link>
  );
}

export function HomeTimeline({ initial, pageSize, timeZone }: { initial: HomeFeedV2Page; pageSize: number; timeZone: string }) {
  const { items, restarted, total, appendedFrom, paged, ...paging } = usePagedList<HomeFeedV2Item>("/api/home/feed-v2", { limit: String(pageSize) }, initial, true);
  const today = useToday(timeZone);
  const [draw] = useState(() => !drawnThisVisit);
  useEffect(() => { drawnThisVisit = true; }, []);
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
        // The entrance clips the row before it becomes visible. Let its first cover load during that wait.
        const priorityCover = index === 0;
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
            style={draw && position < DRAWN_ROWS ? { "--i": position } as CSSProperties : undefined}>
            {heading}
            {item.source === "social" && run.length > 1 ? (
              <article className="entry entry--event entry--social">
                <p className="entry__meta">
                  {/* The days the run covers; a time of day would belong to one work only. */}
                  {span ? <span className="entry__time"><EntryMoment moment={span} /></span> : null}
                  <WorksTag works={run.flatMap(entry => entry.source === "social" ? [entry.work] : [])} />
                  <span className="entry__count">{run.length} 件</span>
                </p>
                <HomeWorks works={run.flatMap(entry => entry.source === "social" ? [entry.work] : [])} timeZone={timeZone} today={today} priorityCover={priorityCover} />
              </article>
            ) : item.source === "social" ? (
              <article className="entry entry--event entry--social">
                <p className="entry__meta">
                  {moment ? <time className="entry__time" dateTime={item.occurredAt?.start}><EntryMoment moment={moment} /></time> : null}
                  {/* The works page exists whenever these entries do: both follow the social source. */}
                  <WorksTag works={[item.work]} />
                  {/* Placed at the moment a change was noticed: said here, so the time is not read as a publication date. */}
                  {item.work.collection && isNoticedActivity(item.work.collection) ? <span className="tag">发现更新</span> : null}
                </p>
                {/* One light line, so the status entries stay the main reading (2026-11-11); so are two or three in a row (F57). */}
                <HomeWorkLine work={item.work} timeZone={timeZone} priorityCover={priorityCover} />
              </article>
            ) : item.event.type === "status" ? (
              <article id={item.event.entry.id} className={item.id === leadId ? "entry entry--lead" : "entry"}>
                {moment ? <time className="entry__time" dateTime={item.event.occurredAt?.start}><EntryMoment moment={moment} /></time> : null}
                {item.id === leadId ? <span className="entry__latest">最新动态</span> : null}
                {demo}
                <StatusBody entry={item.event.entry} />
                {/* Unsized here as before: the picture keeps its own shape under the height limit. */}
                {item.event.entry.cover ? <CoverImage className="entry__cover" image={item.event.entry.cover} previewWidth={800} label="动态封面" lazy priority={priorityCover} sized={false} /> : null}
              </article>
            ) : (
              <article className="entry entry--event">
                <p className="entry__meta">
                  {moment ? <span className="entry__time"><EntryMoment moment={moment} /></span> : null}
                  <span className={`tag tag--${eventKinds[item.event.type].kind}`}>{item.event.type.startsWith("game-") ? <GameTag platforms={gamePlatforms(item.event)} /> : eventKinds[item.event.type].section}</span>
                  {demo}
                </p>
                <WorkCard event={item.event} priorityCover={priorityCover} />
              </article>
            )}
          </div>
        );
      })}
      {paged ? <ListTail className="timeline__more" paging={paging} label="加载更早的内容" end="到底了" status={pagingMessage(paging.problem, items.length, "条", total)} /> : null}
    </>
  );
}
