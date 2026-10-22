import type { DataSourceObjectResponse } from "@notionhq/client";
import type { ContentKind, TimeAmount } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { normalizeId } from "./config.ts";
import { CONTENT_KINDS } from "../../../config/features.ts";

type PropertyType = DataSourceObjectResponse["properties"][string]["type"];
const label: PropertyType[] = ["rich_text", "select", "status", "title"];
const number: PropertyType[] = ["number", "formula", "rollup"];
const date: PropertyType[] = ["date"];
const common: Record<string, PropertyType[]> = { title: ["title"], summary: ["rich_text"], tags: ["multi_select"], cover: ["files"] };
const fields: Record<ContentKind, Record<string, PropertyType[]>> = {
  status: { ...common, recordedAt: ["date", "created_time"] },
  course: { ...common, code: label, semester: [...label, "multi_select"], experience: [...label, "number"], usefulness: [...label, "number"], recommendation: [...label, "number"], difficulty: [...label, "number"], experienceRating: [...label, "number"], usefulnessRating: [...label, "number"], recommendationRating: [...label, "number"], difficultyRating: [...label, "number"] },
  "study-note": { ...common, date: ["date", "created_time"], type: label, moodleUrl: ["url"], order: ["number"] },
  post: { ...common, publishedAt: date },
  album: { ...common, date, photoCount: number },
  book: { ...common, authors: [...label, "multi_select"], status: label, readingDate: date, pagesRead: number, totalPages: number, personalRating: [...label, "number"], doubanRating: number, externalUrl: ["url"] },
  movie: { ...common, originalTitle: label, mediaType: label, status: label, watchedDate: date, releaseDate: date, director: label, actors: [...label, "multi_select"], rating: [...label, "number"], doubanRating: number, publicRating: number, ratingSource: label },
  game: { ...common, status: label, platforms: ["multi_select"], playedDate: date, lastPlayedDate: ["date", "rollup"], firstPlayedDate: ["date", "rollup"], releaseDate: date, playedTime: number, estimatedTime: number, platformMinutes: number, steamMinutes: number, rating: [...label, "number"] },
  project: { ...common, period: date, role: label, stack: ["multi_select"], repositoryUrl: ["url"], demoUrl: ["url"] },
  page: { title: ["title"] },
};
const states: Partial<Record<ContentKind, string[]>> = { game: ["clear", "platinumed", "playing", "wishlist", "unknown"], movie: ["watched", "wishlist", "unknown"], book: ["reading", "read", "wishlist", "given-up", "unknown"] };
export interface WebsiteNotionSource {
  key: string; kind: ContentKind; enabled: true; dataSourceId: string | null;
  pageId: string | null; pageKey: "about" | null; coursePageId: string | null;
  fields: Readonly<Record<string, string>>;
  statusMap: Readonly<Record<string, string>>;
  playedTimeUnit: TimeAmount["unit"] | null;
  cover: { strategy: "none" | "native-page-cover" | "files-property"; property?: string };
  publication: { mode: "all" | "allowlist" | "course-descendants"; allowlistPageIds: string[] };
}
export interface WebsiteNotionConfig {
  schemaVersion: 2; sources: WebsiteNotionSource[];
  /** Collection zone is private, source-hash/config-digest bound input. Absent in legacy configs. */
  timeZone?: string;
}
function bad(): never { throw new ContentServiceError("MISCONFIGURED", "Invalid private website content configuration."); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) bad(); return value as Record<string, unknown>; }
function text(value: unknown, max = 256): string { if (typeof value !== "string" || !value || value.trim() !== value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) bad(); return value; }
/** v2 is separate from the frozen v1 parser. Entire-source publication is always explicit. */
export function parseWebsiteNotionConfig(input: unknown): WebsiteNotionConfig {
  const config = object(input);
  if (config.schemaVersion !== 2 || config.isExampleOnly === true || !Array.isArray(config.sources) || config.sources.length > 128) bad();
  const timeZone = config.timeZone === undefined ? undefined : text(config.timeZone, 128);
  if (timeZone !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone }); } catch { bad(); }
  }
  const keys = new Set<string>(), identities = new Set<string>(), pages = new Set<string>();
  const sources: WebsiteNotionSource[] = [];
  for (const value of config.sources) {
    const s = object(value); if (s.enabled === false) continue;
    if (s.enabled !== true || !CONTENT_KINDS.includes(s.kind as ContentKind)) bad();
    const kind = s.kind as ContentKind, key = text(s.key, 128);
    const p = object(s.publication), mode = p.mode;
    const automaticNotes = kind === "study-note" && mode === "course-descendants";
    const dataSourceId = kind === "page" ? null : normalizeId(text(s.dataSourceId));
    const pageId = kind === "page" ? normalizeId(text(s.pageId)) : null;
    if (keys.has(key) || (dataSourceId && identities.has(dataSourceId) && !automaticNotes) || (pageId && pages.has(pageId))) bad();
    keys.add(key); if (dataSourceId && !automaticNotes) identities.add(dataSourceId); if (pageId) pages.add(pageId);
    const pageKey = kind === "page" && s.pageKey === "about" ? "about" : null;
    if (kind === "page" && !pageKey) bad();
    const mapping: Record<string, string> = {};
    for (const [field, property] of Object.entries(object(s.fields))) { if (!fields[kind][field]) bad(); mapping[field] = text(property); }
    if (!mapping.title) bad();
    if (mode !== "all" && mode !== "allowlist" && !automaticNotes) bad();
    if (kind === "status" && mode !== "all") bad();
    if ((kind === "page" || (kind === "study-note" && !automaticNotes)) && mode !== "allowlist") bad();
    const ids = p.allowlistPageIds ?? [];
    if (!Array.isArray(ids) || ids.length > 20000 || (mode !== "allowlist" && ids.length)) bad();
    const allowlistPageIds = [...new Set(ids.map(id => normalizeId(text(id))))];
    if (kind === "page" && (allowlistPageIds.length !== 1 || allowlistPageIds[0] !== pageId)) bad();
    const coverInput = object(s.cover ?? { strategy: "none" });
    if (!["none", "native-page-cover", "files-property"].includes(String(coverInput.strategy))) bad();
    const cover = { strategy: coverInput.strategy as WebsiteNotionSource["cover"]["strategy"], ...(coverInput.strategy === "files-property" ? { property: text(coverInput.property) } : {}) };
    if (kind === "page" && cover.strategy !== "none") bad();
    const statusMap: Record<string, string> = {};
    for (const [from, to] of Object.entries(object(s.statusMap ?? {}))) { if (!states[kind]?.includes(text(to))) bad(); statusMap[text(from)] = to as string; }
    const unit = s.playedTimeUnit ?? null;
    if (unit !== null && unit !== "hour" && unit !== "minute") bad();
    if (kind === "game" && (mapping.playedTime || mapping.estimatedTime) && unit === null) bad();
    sources.push({ key, kind, enabled: true, dataSourceId, pageId, pageKey, coursePageId: kind === "study-note" && !automaticNotes ? normalizeId(text(s.coursePageId)) : null, fields: mapping, statusMap, playedTimeUnit: unit, cover, publication: { mode: mode as WebsiteNotionSource["publication"]["mode"], allowlistPageIds } });
  }
  if (sources.filter(s => s.kind === "page").length > 1) bad();
  const automatic = sources.filter(s => s.publication.mode === "course-descendants");
  if (new Set(automatic.map(s => s.dataSourceId)).size !== automatic.length || automatic.some(s =>
      !sources.some(c => c.kind === "course" && c.dataSourceId === s.dataSourceId && c.publication.mode === "all"))) bad();
  // Do not add an implicit key: legacy policy/artifact digests remain identical.
  return { schemaVersion: 2, sources, ...(timeZone === undefined ? {} : { timeZone }) };
}
/** Platform timestamps must never be truncated in an implicit collection zone. */
export function websiteCollectionTimeZone(config: WebsiteNotionConfig): string {
  if (config.timeZone === undefined && config.sources.some(s => s.kind === "game" && (s.fields.lastPlayedDate || s.fields.firstPlayedDate))) bad();
  const timeZone = config.timeZone ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone }); } catch { bad(); }
  return timeZone;
}
export function assertWebsiteSourceSchema(source: WebsiteNotionSource, schema: DataSourceObjectResponse): void {
  const resolve = (name: string) => schema.properties[name] ?? Object.values(schema.properties).find(p => { try { return decodeURIComponent(p.id) === decodeURIComponent(name); } catch { return p.id === name; } });
  for (const [field, name] of Object.entries(source.fields)) {
    if (field === "order" && !resolve(name)) continue;
    if (!resolve(name) || !fields[source.kind][field]?.includes(resolve(name)!.type)) bad();
    const property = resolve(name);
    if (field === "lastPlayedDate" && property?.type === "rollup" && property.rollup?.function !== "latest_date") bad();
    if (field === "firstPlayedDate" && property?.type === "rollup" && property.rollup?.function !== "earliest_date") bad();
  }
  if (source.cover.strategy === "files-property" && resolve(source.cover.property!)?.type !== "files") bad();
}
