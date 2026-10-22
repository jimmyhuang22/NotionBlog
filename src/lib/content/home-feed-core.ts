import type { HomeFeedItem, HomeFeedRepository, HomeFeedSources, FeedSnapshot } from "../../../contracts/home-feed.ts";
import type { CursorQuery, TimelineEvent } from "../../../contracts/website.ts";
import type { SocialWork } from "../../../contracts/social.ts";
import type { DateRange } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { pageOf, validateCursorQuery } from "./website.ts";
import { MAX_SOCIAL_WORKS } from "./social-limits.ts";

export interface HomeFeedOptions {
  content: () => Promise<FeedSnapshot<TimelineEvent>>;
  social?: () => Promise<FeedSnapshot<SocialWork>>;
  sources: HomeFeedSources;
  timeZone: string;
  hydrateContent?: (events: TimelineEvent[], version: string) => Promise<TimelineEvent[]>;
}
/** A hydrator may fill content, but cannot change selection or its sort keys. */
export async function hydrateHomeContent<T extends { source: string; event?: TimelineEvent }>(items: T[], version: string, load?: HomeFeedOptions["hydrateContent"]): Promise<T[]> {
  const selected = items.filter(item => item.source === "content" && item.event);
  if (!load || !selected.length) return items;
  const events = await load(selected.map(item => item.event!), version);
  if (events.length !== selected.length || events.some((event, i) => event.id !== selected[i].event!.id ||
    event.type !== selected[i].event!.type || JSON.stringify(event.occurredAt) !== JSON.stringify(selected[i].event!.occurredAt)))
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "Content changed during home hydration.");
  const byId = new Map(events.map(event => [event.id, event]));
  const hydrated = items.map(item => item.source === "content" && item.event ? { ...item, event: byId.get(item.event.id)! } : item);
  if (Buffer.byteLength(JSON.stringify(hydrated)) > 24 * 1024 * 1024)
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "Home feed exceeds its byte budget.");
  return hydrated;
}
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "Home feed is temporarily unavailable.");
export function validFeedSnapshot<T extends { id: string }>(snapshot: FeedSnapshot<T>, max: number): void {
  if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version || snapshot.version.length > 4096 ||
      !Array.isArray(snapshot.items) || snapshot.items.length > max || snapshot.items.some(item =>
        !item || typeof item.id !== "string" || !item.id || item.id.length > 1024) ||
      new Set(snapshot.items.map(i => i.id)).size !== snapshot.items.length) throw unavailable();
}
function calendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validDate(date: DateRange | null): void {
  if (date === null) return;
  if (!date || (date.precision !== "date" && date.precision !== "datetime") || typeof date.start !== "string" ||
      (date.precision === "date" ? !calendarDate(date.start) :
        !calendarDate(date.start.slice(0, 10)) || !Number.isFinite(Date.parse(date.start)) || !/^\d{4}-\d{2}-\d{2}T/.test(date.start))) throw unavailable();
}
interface Moment { day: string; timestamp: number | null }
/** Keep pure dates as calendar dates; do not manufacture a precise midnight for them. */
type TimedFeedItem=Pick<HomeFeedItem,"id"|"occurredAt">;
function moment(item: TimedFeedItem, formatter: Intl.DateTimeFormat): Moment | null {
  if (!item.occurredAt) return null;
  if (item.occurredAt.precision === "date") return { day: item.occurredAt.start, timestamp: null };
  const timestamp = Date.parse(item.occurredAt.start), parts = formatter.formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  const year = String(value("era") === "BC" ? 1 - Number(value("year")) : Number(value("year"))).padStart(4, "0");
  return { day: `${year}-${value("month")}-${value("day")}`, timestamp };
}
function compare(a: TimedFeedItem, b: TimedFeedItem, moments: Map<string, Moment | null>): number {
  const ma = moments.get(a.id), mb = moments.get(b.id), da = ma?.day ?? null, db = mb?.day ?? null;
  if (da === null && db !== null) return 1;
  if (db === null && da !== null) return -1;
  if (da !== db) return da! > db! ? -1 : 1;
  // Precise events precede pure dates on the same calendar day. This also makes ties transitive.
  if (ma?.timestamp !== null && mb?.timestamp === null) return -1;
  if (ma?.timestamp === null && mb?.timestamp !== null) return 1;
  if (ma && mb && ma.timestamp !== null && mb.timestamp !== null && ma.timestamp !== mb.timestamp) return mb.timestamp - ma.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Shared ordering and resource guard. Versions keep v1/v2 cursor scopes separate. */
export function pageHomeFeedItems<T extends TimedFeedItem>(items:T[],formatter:Intl.DateTimeFormat,query:CursorQuery,versions:unknown[]) {
  for(const item of items)validDate(item.occurredAt);
  if(Buffer.byteLength(JSON.stringify(items))>24*1024*1024)throw unavailable();
  const moments=new Map(items.map(item=>[item.id,moment(item,formatter)]));
  items.sort((a,b)=>compare(a,b,moments));
  return pageOf(items,{...query,limit:query.limit??16},versions);
}
export function createHomeFeedRepository(options: HomeFeedOptions): HomeFeedRepository {
  if (!["mock", "notion", "database"].includes(options.sources.content) ||
      !["disabled", "database"].includes(options.sources.social) ||
      (options.sources.social === "database") !== (options.social !== undefined) || typeof options.content !== "function" ||
      (options.social !== undefined && typeof options.social !== "function")) throw unavailable();
  const sources = Object.freeze({ ...options.sources }), timeZone = options.timeZone;
  const readContent = options.content, readSocial = options.social;
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit", era: "short" }); } catch { throw unavailable(); }
  return { async getPage(query = {}) {
    validateCursorQuery(query);
    // Each configured source is read once. A failed source prevents a partial-success page.
    const [content, social] = await Promise.all([readContent(), readSocial?.()]);
    validFeedSnapshot(content, 20000); if (readSocial) validFeedSnapshot(social!, MAX_SOCIAL_WORKS);
    const items: HomeFeedItem[] = content.items.map(event => ({ id: `content:${event.id}`, source: "content",
      provider: sources.content, occurredAt: event.occurredAt, event }));
    for (const work of social?.items ?? []) items.push({ id: `social:${work.id}`, source: "social", provider: "database",
      occurredAt: work.occurredAt === null ? null : { start: work.occurredAt, end: null, precision: "datetime" }, work });
    const result = pageHomeFeedItems(items,formatter,query,
      ["home-feed-v1", content.version, social?.version ?? null, sources, timeZone, query.limit ?? 16]);
    return { ...result, items: await hydrateHomeContent(result.items, content.version, options.hydrateContent), total: items.length, sources: { ...sources } };
  } };
}
