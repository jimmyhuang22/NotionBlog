import type { SocialCollectionCard, SocialCollectionDayAddition } from "../../contracts/social-collections.ts";
import type { SocialMetric, SocialPlatform, SocialPublication } from "../../contracts/social.ts";
import { type CalendarDay, dateParts, dayLabel } from "./format.ts";

export const platformNames: Record<SocialPlatform, string> = { bilibili: "B 站", xiaohongshu: "小红书" };
export const publicationKinds: Record<SocialPublication["kind"], string> = { video: "视频", "image-note": "图文" };

/** Reading order of a publication's figures; a platform that does not report one simply leaves it out. */
const metricLabels: [SocialMetric, string][] = [
  ["views", "播放"], ["likes", "点赞"], ["coins", "投币"], ["collections", "收藏"], ["comments", "评论"], ["danmaku", "弹幕"], ["shares", "转发"],
];

/** Counts read the way the platforms write them: plain below ten thousand, then in 万 with one decimal. */
function countText(value: number): string {
  if (value < 10000) return String(value);
  return `${Math.round(value / 1000) / 10}万`;
}

type Counts = Record<SocialMetric, number | null>;
type Displays = Record<SocialMetric, string | null>;

/**
 * One figure as text. An exact count is used when there is one (zero is a real zero); otherwise the
 * platform's own rounded display stands as it is. Null means unknown and is never shown as a number.
 */
export function figureText(metrics: Counts, displays: Displays | null, metric: SocialMetric): string | null {
  const exact = metrics[metric];
  if (exact !== null && Number.isFinite(exact) && exact >= 0) return countText(exact);
  return displays?.[metric] || null;
}

export interface Figure { metric: SocialMetric; label: string; value: string }

function figures(metrics: Counts, displays: Displays | null): Figure[] {
  return metricLabels.flatMap(([metric, label]) => {
    const value = figureText(metrics, displays, metric);
    return value === null ? [] : [{ metric, label, value }];
  });
}

/** The figures a publication actually has, in reading order. Figures of different platforms are never added up. */
export function publicationFigures(publication: SocialPublication): Figure[] {
  return figures(publication.metrics, publication.metricDisplay);
}

export interface SampleTime { at: string; label: string }

/**
 * When a row's figures were read from its platform, in the site's time zone, for the hint on hovering
 * them. Every row tells its own time: the platforms of one work are read on different schedules. The
 * year is left out while it is the current one; `today` is this device's day once the page is running
 * (`useToday`), and unknown while the page is drawn from cached markup, when the year is written out.
 * A time that cannot be read yields nothing rather than a guess. Whether the reading is late is not
 * shown anywhere any more (decided 2026-10-14).
 */
export function sampleTime(observedAt: string, timeZone: string, today: CalendarDay | null): SampleTime | null {
  const parts = dateParts(observedAt, "datetime", timeZone);
  if (!parts) return null;
  return { at: observedAt, label: `${today?.year === parts.year ? "" : `${parts.year} 年 `}${dayLabel(parts)}` };
}

/** What a card may say about a collection. The checked link is separate, so a candidate and a published one both fit. */
export type CollectionFacts = Omit<SocialCollectionCard, "originalUrl">;

/** A collection's figures are the platform's own totals for the whole collection, not a sum over its members. */
export function collectionFigures(card: CollectionFacts): Figure[] {
  return figures(card.metrics, null);
}

export const collectionKinds: Record<SocialCollectionCard["kind"], string> = { season: "合集", "multi-part": "多 P 视频" };

/** True when the moment the card is placed at is when a change was noticed, not when anything was published. */
export function isNoticedActivity(card: CollectionFacts): boolean {
  return card.activity?.basis === "addition-detected";
}

/** How much is in it: videos for a collection, parts for a multi-part video. An unknown part count is left out. */
export function collectionSize(card: CollectionFacts): string | null {
  if (card.kind === "season") return `${card.memberCount} 个视频`;
  return card.partCount === null ? null : `${card.partCount} 个分 P`;
}

export interface CollectionUpdate { text: string; note: string | null }

/**
 * What the card may say about the collection's latest change. The first look only sets a baseline and
 * is never an update: a collection then tells its newest member's date, and a multi-part video nothing,
 * because its date is its own publication and already the entry's time. Members published since are an
 * addition; members that were only noticed, with no publication time behind them, are a discovery and
 * say so.
 */
export function collectionUpdate(card: CollectionFacts, timeZone: string): CollectionUpdate | null {
  const added = card.latestAddition;
  if (!added && !isNoticedActivity(card)) {
    if (card.kind !== "season") return null;
    const parts = card.latestMemberPublishedAt ? dateParts(card.latestMemberPublishedAt, "datetime", timeZone) : null;
    return parts ? { text: `最近一集发布于 ${parts.year} 年 ${parts.month} 月 ${parts.day} 日`, note: null } : null;
  }
  const what = [added && added.addedVideos > 0 ? `${added.addedVideos} 个视频` : null, added && added.addedParts > 0 ? `${added.addedParts} 个分 P` : null].filter(Boolean).join("、");
  // Without counts there is still a change to report, just not a number to put on it.
  const text = what ? `新增 ${what}` : "有新增内容";
  return card.activity?.basis === "member-published" ? { text, note: null } : { text: `发现${text}`, note: "发布时间未知" };
}

/**
 * Only a change since the first look. The baseline's line about the newest member repeats the time
 * the entry already stands at, so a card that keeps to the essentials leaves it out.
 */
export function collectionAddition(card: CollectionFacts, timeZone: string): CollectionUpdate | null {
  return card.latestAddition || isNoticedActivity(card) ? collectionUpdate(card, timeZone) : null;
}

/**
 * The number on a home card's corner and the words read for it (F37). Once the backend sends the day's
 * total (`dayAddition`) it is used as it is, never added up here; until then the latest addition stands
 * in. Null means no badge: the first look, or a day with nothing counted.
 */
export function collectionBadge(card: CollectionFacts & { dayAddition?: SocialCollectionDayAddition | null }, timeZone: string): { count: number | null; words: string } | null {
  const day = card.dayAddition;
  if (day) {
    const what = [day.addedVideos > 0 ? `${day.addedVideos} 个视频` : null, day.addedParts > 0 ? `${day.addedParts} 个分 P` : null].filter(Boolean).join("、");
    if (!what) return null;
    const count = day.addedVideos + day.addedParts;
    if (day.basis === "addition-detected") return { count, words: `发现新增 ${what}，发布时间未知` };
    return { count, words: day.basis === "mixed" ? `新增 ${what}，其中部分发布时间未知` : `新增 ${what}` };
  }
  const update = collectionAddition(card, timeZone);
  if (!update) return null;
  const added = card.latestAddition;
  const count = added ? added.addedVideos + added.addedParts : 0;
  return { count: count > 0 ? count : null, words: update.note ? `${update.text}，${update.note}` : update.text };
}
