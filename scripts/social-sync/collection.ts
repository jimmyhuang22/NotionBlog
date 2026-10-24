import type { SocialCollectionCard } from "../../contracts/social-collections.ts";
import { count, hash, identity, metricNames, object, SocialSyncError, text, timestamp, videoUrl } from "./model.ts";
import type { Metrics, Target } from "./model.ts";
import { fetchCollectionPage, collectionPageState, requirePublicApiVideo } from "./bilibili.ts";

export const MAX_COLLECTION_MEMBERS = 1000;
export const MAX_COLLECTION_PARTS = 2000;
export const MAX_COLLECTION_SNAPSHOT_BYTES = 512 * 1024;
export interface CollectionTarget {
  platform: "bilibili"; kind: "season" | "multi-part"; accountId: string; collectionId: string; representativeUrl: string;
}
export interface CollectionMember { id: string; publishedAt: string | null; parts: string[]; partsComplete: boolean }
export interface CollectionSnapshot {
  version: 1; source: "bilibili-collection-ssr" | "bilibili-collection-api-json"; target: CollectionTarget; title: string;
  observedAt: string; firstPublishedAt: string | null; membershipComplete: true;
  members: CollectionMember[]; metrics: Metrics; responseSha256: string; websitePublicationApproved: false;
}
export interface CollectionState {
  version: 1; snapshot: CollectionSnapshot; seenVideos: string[];
  partBaselines: Record<string, { ids: string[]; observedAt: string }>;
  activity: SocialCollectionCard["activity"]; latestAddition: SocialCollectionCard["latestAddition"];
}
function shape(value: unknown, fields: string[]) {
  const row = object(value);
  if (Object.keys(row).length !== fields.length || fields.some(k => !Object.hasOwn(row, k))) throw new SocialSyncError("COLLECTION_INVALID");
  return row;
}
function bvid(value: unknown): string {
  if (typeof value !== "string" || !/^BV[0-9A-Za-z]{10}$/.test(value)) throw new SocialSyncError("INVALID_IDENTITY");
  return value;
}
export function collectionTarget(value: unknown): CollectionTarget {
  const t = shape(value, ["platform", "kind", "accountId", "collectionId", "representativeUrl"]);
  if (t.platform !== "bilibili" || !["season", "multi-part"].includes(String(t.kind))) throw new SocialSyncError("COLLECTION_KIND_UNSUPPORTED");
  const url = videoUrl(t.representativeUrl);
  if (url.url !== t.representativeUrl || typeof t.accountId !== "string" || typeof t.collectionId !== "string") throw new SocialSyncError("COLLECTION_INVALID");
  const kind = t.kind as CollectionTarget["kind"], collectionId = kind === "season" ? identity(t.collectionId) : bvid(t.collectionId);
  if (kind === "multi-part" && collectionId !== url.publicationId) throw new SocialSyncError("IDENTITY_MISMATCH");
  return { platform: "bilibili", kind, accountId: identity(t.accountId), collectionId, representativeUrl: url.url };
}
export function collectionConfig(value: unknown): CollectionTarget[] {
  const c = shape(value, ["version", "collections"]);
  if (c.version !== 1 || !Array.isArray(c.collections) || c.collections.length < 1 || c.collections.length > 20) throw new SocialSyncError("INVALID_CONFIG");
  const targets = c.collections.map(collectionTarget);
  if (new Set(targets.map(collectionKey)).size !== targets.length) throw new SocialSyncError("INVALID_CONFIG");
  return targets;
}
export function collectionKey(target: CollectionTarget): string {
  return hash(JSON.stringify([target.platform, target.accountId, target.kind, target.collectionId]));
}
function nullableTime(value: unknown, observedAt: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new SocialSyncError("INVALID_TIME");
  timestamp(value);
  if (Date.parse(value) > Date.parse(observedAt) + 30000) throw new SocialSyncError("INVALID_TIME");
  return value;
}
function seconds(value: unknown, at: string): string | null {
  const n = count(value);
  if (n === null || n === 0) return null;
  if (n > 253402300799) throw new SocialSyncError("INVALID_TIME");
  return nullableTime(new Date(n * 1000).toISOString(), at);
}
/** Strict narrow input. Unknown dates remain null; unknown part completeness is explicit. */
export function validateCollectionSnapshot(value: unknown): CollectionSnapshot {
  const s = shape(value, ["version", "source", "target", "title", "observedAt", "firstPublishedAt", "membershipComplete", "members", "metrics", "responseSha256", "websitePublicationApproved"]);
  if (s.version !== 1 || !["bilibili-collection-ssr", "bilibili-collection-api-json"].includes(String(s.source)) || s.membershipComplete !== true || s.websitePublicationApproved !== false ||
      typeof s.observedAt !== "string" || typeof s.responseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(s.responseSha256)) throw new SocialSyncError("COLLECTION_INVALID");
  const target = collectionTarget(s.target), at = timestamp(s.observedAt);
  if (!Array.isArray(s.members) || s.members.length < 1 || s.members.length > MAX_COLLECTION_MEMBERS) throw new SocialSyncError("COLLECTION_INCOMPLETE");
  const members = s.members.map(value => {
    const m = shape(value, ["id", "publishedAt", "parts", "partsComplete"]);
    if (!Array.isArray(m.parts) || m.parts.length < 1 || m.parts.length > MAX_COLLECTION_PARTS || typeof m.partsComplete !== "boolean") throw new SocialSyncError("COLLECTION_INCOMPLETE");
    const parts = m.parts.map(identity).sort();
    if (new Set(parts).size !== parts.length) throw new SocialSyncError("COLLECTION_INVALID");
    return { id: bvid(m.id), publishedAt: nullableTime(m.publishedAt, at), parts, partsComplete: m.partsComplete };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(members.map(m => m.id)).size !== members.length || members.reduce((n, m) => n + m.parts.length, 0) > MAX_COLLECTION_PARTS ||
      !members.some(m => m.id === videoUrl(target.representativeUrl).publicationId) ||
      (target.kind === "multi-part" && (members.length !== 1 || members[0].id !== target.collectionId || !members[0].partsComplete || members[0].parts.length < 2))) {
    throw new SocialSyncError("COLLECTION_INCOMPLETE");
  }
  const metric = shape(s.metrics, [...metricNames]), metrics = {} as Metrics;
  for (const name of metricNames) metrics[name] = count(metric[name]);
  const result: CollectionSnapshot = { version: 1, source: s.source as CollectionSnapshot["source"], target, title: text(s.title), observedAt: at,
    firstPublishedAt: nullableTime(s.firstPublishedAt, at), membershipComplete: true, members, metrics,
    responseSha256: s.responseSha256, websitePublicationApproved: false };
  if (target.kind === "season" && result.firstPublishedAt !== null) throw new SocialSyncError("COLLECTION_INVALID");
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_COLLECTION_SNAPSHOT_BYTES) throw new SocialSyncError("COLLECTION_TOO_LARGE");
  return result;
}
function pages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COLLECTION_PARTS) throw new SocialSyncError("COLLECTION_INCOMPLETE");
  const ids = value.map(p => identity(object(p).cid));
  if (new Set(ids).size !== ids.length) throw new SocialSyncError("COLLECTION_INVALID");
  return ids;
}
/** Season metrics come only from season.stat; multi-part metrics count the BV once. */
export function collectionFromPage(html: string, expected: CollectionTarget, observedAt: string): CollectionSnapshot {
  return collectionFromVideoData(collectionPageState(html).videoData, expected, observedAt, "bilibili-collection-ssr", hash(html));
}
/** The same complete-roster checks apply to each inert response representation. */
export function collectionFromVideoData(value: unknown, expected: CollectionTarget, observedAt: string, source: CollectionSnapshot["source"], responseSha256: string): CollectionSnapshot {
  const target = collectionTarget(expected), at = timestamp(observedAt), v = object(value), owner = object(v.owner);
  if(source==="bilibili-collection-api-json")requirePublicApiVideo(v);
  const representative = videoUrl(target.representativeUrl).publicationId;
  if (v.bvid !== representative || identity(owner.mid) !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  if (v.state !== 0 || v.is_upower_exclusive || v.is_upower_preview || v.is_pay_season) throw new SocialSyncError("SOURCE_BLOCKED");
  const ownParts = pages(v.pages), declaredParts = count(v.videos);
  if (declaredParts === null || declaredParts !== ownParts.length) throw new SocialSyncError("COLLECTION_INCOMPLETE");
  let title: string, rawMetrics: Record<string, unknown>, members: CollectionMember[], firstPublishedAt: string | null = null;
  if (target.kind === "multi-part") {
    if (ownParts.length < 2) throw new SocialSyncError("NOT_A_COLLECTION");
    rawMetrics = object(v.stat);
    if (identity(rawMetrics.aid) !== identity(v.aid)) throw new SocialSyncError("SCOPE_MISMATCH");
    title = text(v.title); firstPublishedAt = seconds(v.pubdate, at);
    members = [{ id: representative, publishedAt: firstPublishedAt, parts: ownParts, partsComplete: true }];
  } else {
    const season = object(v.ugc_season);
    if (identity(season.id) !== target.collectionId || identity(season.mid) !== target.accountId || season.is_pay_season) throw new SocialSyncError("IDENTITY_MISMATCH");
    if (v.season_id !== undefined && identity(v.season_id) !== target.collectionId) throw new SocialSyncError("IDENTITY_MISMATCH");
    rawMetrics = object(season.stat);
    if (identity(rawMetrics.season_id) !== target.collectionId) throw new SocialSyncError("SCOPE_MISMATCH");
    if (!Array.isArray(season.sections) || !season.sections.length || season.sections.length > 100) throw new SocialSyncError("COLLECTION_INCOMPLETE");
    members = [];
    for (const value of season.sections) {
      const section = object(value);
      if (identity(section.season_id) !== target.collectionId || !Array.isArray(section.episodes)) throw new SocialSyncError("COLLECTION_INCOMPLETE");
      for (const value of section.episodes) {
        if (members.length >= MAX_COLLECTION_MEMBERS) throw new SocialSyncError("COLLECTION_TOO_LARGE");
        const e = object(value), arc = object(e.arc), author = object(arc.author), id = bvid(e.bvid);
        if (identity(e.season_id) !== target.collectionId || identity(e.aid) !== identity(arc.aid) || identity(author.mid) !== target.accountId || arc.state !== 0) {
          throw new SocialSyncError("IDENTITY_MISMATCH");
        }
        if (arc.is_upower_exclusive || arc.is_upower_preview || arc.is_pay_season) throw new SocialSyncError("SOURCE_BLOCKED");
        const partIds = id === representative ? ownParts : pages(e.pages);
        const arcParts = count(arc.videos);
        members.push({ id, publishedAt: seconds(arc.pubdate, at), parts: partIds,
          partsComplete: id === representative || (arcParts !== null && arcParts > 0 && arcParts === partIds.length) });
      }
    }
    if (count(season.ep_count) !== members.length) throw new SocialSyncError("COLLECTION_INCOMPLETE");
    title = text(season.title);
  }
  const metrics = {} as Metrics;
  const names = { views: "view", likes: "like", comments: "reply", shares: "share", collections: target.kind === "season" ? "fav" : "favorite", coins: "coin", danmaku: "danmaku" };
  for (const name of metricNames) metrics[name] = count(rawMetrics[names[name]]);
  return validateCollectionSnapshot({ version: 1, source, target, title, observedAt: at, firstPublishedAt,
    membershipComplete: true, members, metrics, responseSha256, websitePublicationApproved: false });
}
export async function collectCollection(target: CollectionTarget, signal?: AbortSignal, request: typeof fetch = fetch, captured?: (html:string,snapshot:CollectionSnapshot)=>Promise<void>) {
  const t = collectionTarget(target), url = videoUrl(t.representativeUrl);
  const requestTarget: Target = { platform: "bilibili", accountId: t.accountId, workId: `bc_${collectionKey(t).slice(0,40)}`,
    publicationId: url.publicationId, url: url.url };
  const { html, observedAt } = await fetchCollectionPage(requestTarget, signal, request);
  const snapshot=collectionFromPage(html,t,observedAt);
  await captured?.(html,snapshot);
  return snapshot;
}
function latestTime(values: (string | null)[]): string | null {
  return values.filter((v): v is string => v !== null).sort().at(-1) ?? null;
}
/** Keep historical identities so removals/re-additions and representative changes cannot manufacture updates. */
export function nextCollectionState(previous: CollectionState | null, input: CollectionSnapshot): CollectionState {
  const snapshot = validateCollectionSnapshot(input);
  if (previous && collectionKey(previous.snapshot.target) !== collectionKey(snapshot.target)) throw new SocialSyncError("WORK_BINDING_CONFLICT");
  if (previous && snapshot.observedAt <= previous.snapshot.observedAt) throw new SocialSyncError("COLLECTION_NOT_NEWER");
  const seen = new Set(previous?.seenVideos ?? []), baselines = structuredClone(previous?.partBaselines ?? {});
  const added = previous ? snapshot.members.filter(m => !seen.has(m.id)) : [];
  let addedParts = 0;
  for (const m of snapshot.members) {
    if (previous && (snapshot.target.kind === "multi-part" || !added.some(a => a.id === m.id))) {
      const old = baselines[m.id];
      if (old && m.partsComplete) addedParts += m.parts.filter(id => !old.ids.includes(id)).length;
    }
    seen.add(m.id);
    if (m.partsComplete) {
      const old = baselines[m.id];
      baselines[m.id] = { ids: [...new Set([...(old?.ids ?? []), ...m.parts])].sort(), observedAt: snapshot.observedAt };
    }
  }
  if (seen.size > 10000 || Object.values(baselines).reduce((n,b) => n+b.ids.length,0) > 20000) throw new SocialSyncError("COLLECTION_HISTORY_LIMIT");
  let activity = previous ? previous.activity : (latestTime(snapshot.members.map(m => m.publishedAt)) ?
    { at: latestTime(snapshot.members.map(m => m.publishedAt))!, basis: "member-published" as const } : null);
  let latestAddition = previous?.latestAddition ?? null;
  if (added.length || addedParts) {
    // Old videos newly added to a season have an unknown membership-addition time. Label detection honestly.
    const published = addedParts === 0 && added.length > 0 && added.every(m => m.publishedAt !== null && m.publishedAt >= previous!.snapshot.observedAt)
      ? latestTime(added.map(m => m.publishedAt)) : null;
    latestAddition = { detectedAt: snapshot.observedAt, publishedAt: published, addedVideos: snapshot.target.kind === "season" ? added.length : 0, addedParts };
    activity = { at: published ?? snapshot.observedAt, basis: published ? "member-published" : "addition-detected" };
  }
  return { version: 1, snapshot, seenVideos: [...seen].sort(), partBaselines: baselines, activity, latestAddition };
}
export function validateCollectionState(value: unknown): CollectionState {
  const s = shape(value, ["version", "snapshot", "seenVideos", "partBaselines", "activity", "latestAddition"]);
  if (s.version !== 1 || !Array.isArray(s.seenVideos) || s.seenVideos.length > 10000) throw new SocialSyncError("LOCAL_DATA_INVALID");
  const snapshot = validateCollectionSnapshot(s.snapshot), seenVideos = s.seenVideos.map(bvid);
  if (new Set(seenVideos).size !== seenVideos.length || snapshot.members.some(m => !seenVideos.includes(m.id))) throw new SocialSyncError("LOCAL_DATA_INVALID");
  const partBaselines: CollectionState["partBaselines"] = {};
  for (const [id, value] of Object.entries(object(s.partBaselines))) {
    bvid(id); const b = shape(value, ["ids", "observedAt"]);
    if (!seenVideos.includes(id) || !Array.isArray(b.ids) || !b.ids.length || b.ids.length > 20000 || typeof b.observedAt !== "string" ||
        timestamp(b.observedAt) > snapshot.observedAt) throw new SocialSyncError("LOCAL_DATA_INVALID");
    const ids = b.ids.map(identity);
    if (new Set(ids).size !== ids.length) throw new SocialSyncError("LOCAL_DATA_INVALID");
    partBaselines[id] = { ids, observedAt: b.observedAt };
  }
  if (Object.values(partBaselines).reduce((n,b) => n+b.ids.length,0) > 20000 || snapshot.members.some(m =>
    m.partsComplete && (!partBaselines[m.id] || m.parts.some(id => !partBaselines[m.id].ids.includes(id))))) throw new SocialSyncError("LOCAL_DATA_INVALID");
  let activity: CollectionState["activity"] = null, latestAddition: CollectionState["latestAddition"] = null;
  if (s.activity !== null) {
    const a = shape(s.activity, ["at", "basis"]);
    if (!["member-published", "addition-detected"].includes(String(a.basis))) throw new SocialSyncError("LOCAL_DATA_INVALID");
    activity = { at: nullableTime(a.at, snapshot.observedAt)!, basis: a.basis as NonNullable<CollectionState["activity"]>["basis"] };
    if (!activity.at) throw new SocialSyncError("LOCAL_DATA_INVALID");
  }
  if (s.latestAddition !== null) {
    const a = shape(s.latestAddition, ["detectedAt", "publishedAt", "addedVideos", "addedParts"]);
    const addedVideos = count(a.addedVideos), addedParts = count(a.addedParts), detectedAt = nullableTime(a.detectedAt, snapshot.observedAt);
    if (!detectedAt || detectedAt > snapshot.observedAt || addedVideos === null || addedParts === null || addedVideos > MAX_COLLECTION_MEMBERS || addedParts > MAX_COLLECTION_PARTS ||
        addedVideos+addedParts === 0 || (snapshot.target.kind === "multi-part" && addedVideos !== 0)) throw new SocialSyncError("LOCAL_DATA_INVALID");
    const publishedAt = nullableTime(a.publishedAt, snapshot.observedAt);
    if (!activity || activity.at !== (publishedAt ?? detectedAt) || activity.basis !== (publishedAt ? "member-published" : "addition-detected")) throw new SocialSyncError("LOCAL_DATA_INVALID");
    latestAddition = { detectedAt, publishedAt, addedVideos, addedParts };
  }
  return { version: 1, snapshot, seenVideos, partBaselines, activity, latestAddition };
}
export function collectionCard(state: CollectionState): SocialCollectionCard {
  const s = state.snapshot, partCount = s.members.every(m => m.partsComplete) ? s.members.reduce((n,m) => n+m.parts.length,0) : null;
  return { id: `bc_${collectionKey(s.target).slice(0,40)}`, platform: "bilibili", kind: s.target.kind, title: s.title,
    memberCount: s.target.kind === "season" ? s.members.length : partCount!, partCount,
    firstPublishedAt: s.firstPublishedAt, latestMemberPublishedAt: latestTime(s.members.map(m => m.publishedAt)), observedAt: s.observedAt,
    metricsScope: s.target.kind === "season" ? "bilibili-season" : "bilibili-multi-part", metrics: { ...s.metrics },
    activity: state.activity ? { ...state.activity } : null, latestAddition: state.latestAddition ? { ...state.latestAddition } : null, originalUrl: null };
}
