import type { SocialPlatform } from "../../contracts/social.ts";
import type { SocialTimelineWork } from "../../contracts/social-timeline.ts";
import { dateParts, momentLabel, type CalendarDay, type MomentLabel } from "./format.ts";
import { socialWorkPublishedAt } from "./content/social-works-query.ts";
import { collectionFigures, collectionKinds, collectionSize, isNoticedActivity, publicationFigures, publicationKinds, type Figure } from "./home-feed.ts";

/** The moment a work is listed under: a collection's latest activity, else the work's own date. Null when neither is known. */
export function workMoment(work: SocialTimelineWork): string | null {
  return work.collection?.activity?.at ?? work.occurredAt;
}

/**
 * The figures a line shows. A Bilibili line shows its views alone (the owner's choice, 2026-10-17: no
 * likes on Bilibili), and nothing when the views are unknown rather than another figure in their place.
 * Other platforms show views and likes; with neither, the first figure on record stands in, so figures
 * on record are never told as none.
 */
export function leadingFigures(figures: Figure[], platform?: SocialPlatform): Figure[] {
  if (platform === "bilibili") return figures.filter(figure => figure.metric === "views");
  const leading = figures.filter(figure => figure.metric === "views" || figure.metric === "likes");
  return leading.length ? leading : figures.slice(0, 1);
}

/** The shape a platform gives its covers: a video frame, or an upright note. */
export const coverShapes: Record<SocialPlatform, "wide" | "tall"> = { bilibili: "wide", xiaohongshu: "tall" };

/**
 * Which preview a frame asks for. A video frame is up to 380 wide on the page and fills a phone's
 * width, so on a dense screen 400 pixels would be soft; an upright note is never wider than 208.
 */
export const coverPreviewWidths: Record<"wide" | "tall", 400 | 800> = { wide: 800, tall: 400 };

export interface WorkLine {
  key: string;
  platform: SocialPlatform;
  /** What it is on that platform: 视频, 图文, 合集, 多 P 视频. */
  kind: string;
  /** How much is in a collection; null for a single publication or an unknown part count. */
  size: string | null;
  /** Views (and likes, except on Bilibili), see `leadingFigures`. Never summed with another line's. */
  figures: Figure[];
  /** When those figures were read; null when there are none to date. */
  observedAt: string | null;
  /** A checked address, or null: then the line is not a link. */
  url: string | null;
  /** True when the listed moment is when a change was noticed, not when anything was published. */
  noticed: boolean;
  /** The way out is the newest episode's playback page rather than the collection's list (feedback F31). */
  opensLatest: boolean;
}

/**
 * One line per place a work lives: its collection first, then each platform it was published on.
 * Every line keeps to its own platform's figures, time and address, the same rule as on the cards.
 */
export function workLines(work: SocialTimelineWork): WorkLine[] {
  const lines: WorkLine[] = [];
  const collection = work.collection;
  if (collection) {
    const figures = leadingFigures(collectionFigures(collection), collection.platform);
    lines.push({ key: `collection:${collection.id}`, platform: collection.platform, kind: collectionKinds[collection.kind], size: collectionSize(collection), figures,
      observedAt: figures.length ? collection.observedAt : null,
      // A collection opens on its newest episode, whose page lists the whole collection; else on the collection's own list (the owner's choice, 2026-10-18).
      url: collection.latestMemberUrl ?? collection.originalUrl, opensLatest: collection.latestMemberUrl !== null, noticed: isNoticedActivity(collection) });
  }
  for (const publication of work.publications) {
    const figures = leadingFigures(publicationFigures(publication), publication.platform);
    lines.push({ key: publication.id, platform: publication.platform, kind: publicationKinds[publication.kind], size: null, figures,
      observedAt: figures.length ? publication.observedAt : null, url: publication.originalUrl, opensLatest: false, noticed: false });
  }
  return lines;
}

export interface WorkYear { key: string; label: string }

/** The year a work is grouped under in the site's time zone; works without a date share one group at the end. */
export function workYear(work: SocialTimelineWork, timeZone: string): WorkYear {
  const moment = workMoment(work);
  const parts = moment ? dateParts(moment, "datetime", timeZone) : null;
  return parts ? { key: String(parts.year), label: `${parts.year}` } : { key: "undated", label: "日期未记录" };
}

/** Month and day within its year group, or nothing when the date is unknown. */
export function workDay(work: SocialTimelineWork, timeZone: string): string | null {
  const moment = workMoment(work);
  const parts = moment ? dateParts(moment, "datetime", timeZone) : null;
  return parts ? `${parts.month} 月 ${parts.day} 日` : null;
}

/**
 * The same day as it reads today, by the rule of the status entries: "今天", "昨天 · 10 月 13 日",
 * "N 天前 · …" within a week, the plain date before that. A work is told by its day only.
 */
export function workDayMoment(work: SocialTimelineWork, timeZone: string, today: CalendarDay | null): MomentLabel | null {
  const moment = workMoment(work);
  const parts = moment ? dateParts(moment, "datetime", timeZone) : null;
  return parts ? momentLabel({ ...parts, time: null }, today) : null;
}

/** Consecutive works of the same year, in the order they arrive. The list is already sorted; nothing is re-sorted here. */
export function groupWorksByYear<T extends SocialTimelineWork>(works: T[], timeZone: string): { year: WorkYear; works: T[] }[] {
  const groups: { year: WorkYear; works: T[] }[] = [];
  for (const work of works) {
    const year = workYear(work, timeZone);
    const last = groups.at(-1);
    if (last && last.year.key === year.key) last.works.push(work);
    else groups.push({ year, works: [work] });
  }
  return groups;
}

/** The works page's sections: one per platform, Bilibili first and the default (the owner's choice, 2026-10-18). */
export const worksPlatforms: { value: SocialPlatform; label: string; order: "views" | "likes"; orderLabel: string }[] = [
  { value: "bilibili", label: "B 站", order: "views", orderLabel: "播放最多" },
  { value: "xiaohongshu", label: "小红书", order: "likes", orderLabel: "点赞最多" },
];

/** A works-page address; the default platform and the newest-first order are left out, so each view has one address. */
export function worksHref(platform: SocialPlatform, order: "views" | "likes" | null): string {
  const params = new URLSearchParams({ ...(platform === "bilibili" ? {} : { platform }), ...(order ? { order } : {}) });
  return params.size ? `/works?${params}` : "/works";
}

/**
 * The day a works-page card shows, by the same date the list is ordered by; a recent one named as status entries name it.
 * Ordered by views or likes there are no year headings, so a day of another year carries its year (F41, as on the home
 * page): "2025 年 6 月 19 日", while this year's stays "6 月 19 日" and the relative names are unchanged.
 */
export function worksDay(work: SocialTimelineWork, timeZone: string, today: CalendarDay | null, withYear = false): MomentLabel | null {
  const at = socialWorkPublishedAt(work);
  const parts = at ? dateParts(at, "datetime", timeZone) : null;
  if (!parts) return null;
  const moment = momentLabel({ ...parts, time: null }, today);
  return withYear && !moment.relative && today && parts.year !== today.year ? { ...moment, rest: `${parts.year} 年 ${moment.rest}` } : moment;
}

/** Works-page year groups, by that same date; works without one share a group at the end. */
export function groupWorksByPublishedYear<T extends SocialTimelineWork>(works: T[], timeZone: string): { year: WorkYear; works: T[] }[] {
  const groups: { year: WorkYear; works: T[] }[] = [];
  for (const work of works) {
    const at = socialWorkPublishedAt(work);
    const parts = at ? dateParts(at, "datetime", timeZone) : null;
    const year: WorkYear = parts ? { key: String(parts.year), label: `${parts.year}` } : { key: "undated", label: "日期未记录" };
    const last = groups.at(-1);
    if (last && last.year.key === year.key) last.works.push(work);
    else groups.push({ year, works: [work] });
  }
  return groups;
}
