import { isAbsolute, resolve } from "node:path";
import { collectionKey, collectionTarget, MAX_COLLECTION_MEMBERS, validateCollectionSnapshot } from "./collection.ts";
import type { CollectionSnapshot, CollectionTarget } from "./collection.ts";
import type { CollectionPending } from "./collection-store.ts";
import { config, hash, object, publicationKey, SocialSyncError, timestamp, validateObservation } from "./model.ts";
import type { Observation, Target } from "./model.ts";
import type { Pending } from "./store.ts";

export const MAX_REFRESH_CONFIG_BYTES = 512 * 1024;
export interface ReviewedPublication { target: Target; kind: Observation["kind"] }
export interface ReviewedCollection { target: CollectionTarget; memberShas: string[]; membershipMode?: "follow-public" }
export interface RefreshConfig {
  version: 1; reviewedAt: string;
  cadence: { bilibiliHours: 6; xiaohongshuHours: 1 | 24 };
  stateDirectories: { publications: string; collections: string };
  publications: ReviewedPublication[]; collections: ReviewedCollection[];
}
function shape(value: unknown, keys: string[]) {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k))) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  return row;
}
function directory(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  return value;
}
/** The operator freezes identities and member versions; cadence never grants website eligibility. */
export function refreshConfig(value: unknown): RefreshConfig {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_REFRESH_CONFIG_BYTES) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  const row = shape(value, ["version", "reviewedAt", "cadence", "stateDirectories", "publications", "collections"]);
  const cadence = shape(row.cadence, ["bilibiliHours", "xiaohongshuHours"]), dirs = shape(row.stateDirectories, ["publications", "collections"]);
  if (row.version !== 1 || typeof row.reviewedAt !== "string" || cadence.bilibiliHours !== 6 || ![1,24].includes(Number(cadence.xiaohongshuHours)) || typeof cadence.xiaohongshuHours !== "number" ||
      !Array.isArray(row.publications) || !Array.isArray(row.collections) || row.publications.length + row.collections.length < 1 ||
      row.publications.length + row.collections.length > 500) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  timestamp(row.reviewedAt);
  const publications = row.publications.map(value => {
    const p = shape(value, ["target", "kind"]), rawTarget = object(p.target);
    const { publicationId, ...input } = rawTarget;
    const target = config({ version: 1, publications: [input] })[0]!;
    if (Object.hasOwn(rawTarget, "publicationId") && publicationId !== target.publicationId) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
    if (!["video", "image-note"].includes(String(p.kind)) || target.platform === "bilibili" && p.kind !== "video") throw new SocialSyncError("REFRESH_CONFIG_INVALID");
    return { target, kind: p.kind as Observation["kind"] };
  });
  const collections = row.collections.map(value => {
    const raw = object(value), follows = Object.hasOwn(raw, "membershipMode");
    const c = shape(raw, follows ? ["target", "memberShas", "membershipMode"] : ["target", "memberShas"]), target = collectionTarget(c.target);
    if (follows && c.membershipMode !== "follow-public") throw new SocialSyncError("REFRESH_CONFIG_INVALID");
    if (!Array.isArray(c.memberShas) || c.memberShas.length < 1 || c.memberShas.length > MAX_COLLECTION_MEMBERS ||
        c.memberShas.some(x => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x)) || new Set(c.memberShas).size !== c.memberShas.length) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
    return { target, memberShas: [...c.memberShas as string[]].sort(), ...(follows ? { membershipMode: "follow-public" as const } : {}) };
  });
  if (new Set(publications.map(p => publicationKey(p.target))).size !== publications.length ||
      new Set(collections.map(c => collectionKey(c.target))).size !== collections.length) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  return { version: 1, reviewedAt: row.reviewedAt, cadence: { bilibiliHours: 6, xiaohongshuHours: cadence.xiaohongshuHours as 1 | 24 },
    stateDirectories: { publications: directory(dirs.publications), collections: directory(dirs.collections) }, publications, collections };
}
/** Fixed scopes retain their initial signatures; follow-public is an explicit per-collection opt-in. */
export function collectionMemberShas(snapshot: CollectionSnapshot): string[] {
  return validateCollectionSnapshot(snapshot).members.map(m => hash(JSON.stringify([m.id, [...m.parts].sort(), m.partsComplete]))).sort();
}
export type ReviewDecision = { allowed: true } | { allowed: false; code: "TARGET_REVIEW_REQUIRED" | "WORK_BINDING_REVIEW_REQUIRED" | "KIND_REVIEW_REQUIRED" | "MEMBERSHIP_REVIEW_REQUIRED" };
export function publicationReview(scope: RefreshConfig, observation: Observation): ReviewDecision {
  validateObservation(observation);
  const approved = scope.publications.find(p => publicationKey(p.target) === publicationKey(observation));
  if (!approved) return { allowed: false, code: "TARGET_REVIEW_REQUIRED" };
  if (approved.target.workId !== observation.workId) return { allowed: false, code: "WORK_BINDING_REVIEW_REQUIRED" };
  if (approved.kind !== observation.kind) return { allowed: false, code: "KIND_REVIEW_REQUIRED" };
  return { allowed: true };
}
export function collectionReview(scope: RefreshConfig, value: CollectionSnapshot): ReviewDecision {
  const snapshot = validateCollectionSnapshot(value), approved = scope.collections.find(c => collectionKey(c.target) === collectionKey(snapshot.target));
  if (!approved || approved.target.representativeUrl !== snapshot.target.representativeUrl) return { allowed: false, code: "TARGET_REVIEW_REQUIRED" };
  if (approved.membershipMode !== "follow-public" && JSON.stringify(approved.memberShas) !== JSON.stringify(collectionMemberShas(snapshot))) return { allowed: false, code: "MEMBERSHIP_REVIEW_REQUIRED" };
  return { allowed: true };
}
export interface RefreshSources {
  publication(target: Target): Observation | null;
  collection(target: CollectionTarget): CollectionSnapshot | null;
}
export function planRefresh(value: unknown, sources: RefreshSources, at: string) {
  const scope = refreshConfig(value), now = Date.parse(timestamp(at));
  if (Date.parse(scope.reviewedAt) > now + 30000) throw new SocialSyncError("REFRESH_TIME_INVALID");
  const observed = (time: string) => { timestamp(time); if (Date.parse(time) > now + 30000) throw new SocialSyncError("REFRESH_TIME_INVALID"); return time; };
  const entries: { key: string; type: "publication" | "collection"; platform: Target["platform"]; observedAt: string | null;
    nextDueAt: string | null; status: "due" | "fresh" | "review-required"; code: string | null; snapshotSha256: string | null }[] = [];
  const duePublications: Target[] = [], dueCollections: CollectionTarget[] = [];
  function add(key: string, type: "publication" | "collection", platform: Target["platform"], snapshot: Observation | CollectionSnapshot | null, decision: ReviewDecision) {
    const observedAt = snapshot ? observed(snapshot.observedAt) : null;
    const nextDueAt = observedAt ? new Date(Date.parse(observedAt) + scope.cadence[platform === "bilibili" ? "bilibiliHours" : "xiaohongshuHours"] * 3600000).toISOString() : null;
    const status = !decision.allowed ? "review-required" : nextDueAt === null || Date.parse(nextDueAt) <= now ? "due" : "fresh";
    entries.push({ key, type, platform, observedAt, nextDueAt, status, code: decision.allowed ? null : decision.code, snapshotSha256: snapshot ? hash(JSON.stringify(snapshot)) : null });
    return status === "due";
  }
  for (const p of scope.publications) {
    const snapshot = sources.publication(p.target);
    if (snapshot && publicationKey(snapshot) !== publicationKey(p.target)) throw new SocialSyncError("REFRESH_STATE_INVALID");
    if (add(publicationKey(p.target), "publication", p.target.platform, snapshot, snapshot ? publicationReview(scope, snapshot) : { allowed: true })) duePublications.push(p.target);
  }
  for (const c of scope.collections) {
    const snapshot = sources.collection(c.target);
    if (snapshot && collectionKey(snapshot.target) !== collectionKey(c.target)) throw new SocialSyncError("REFRESH_STATE_INVALID");
    if (add(collectionKey(c.target), "collection", "bilibili", snapshot, snapshot ? collectionReview(scope, snapshot) : { allowed: true })) dueCollections.push(c.target);
  }
  const batches: { kind: "bilibili-publications" | "xiaohongshu-browser" | "bilibili-collections"; config: unknown }[] = [];
  for (const platform of ["bilibili", "xiaohongshu"] as const) {
    const targets = duePublications.filter(p => p.platform === platform).sort((a, b) => publicationKey(a).localeCompare(publicationKey(b)));
    for (let i = 0; i < targets.length; i += 20) batches.push({ kind: platform === "bilibili" ? "bilibili-publications" : "xiaohongshu-browser",
      config: { version: 1, publications: targets.slice(i, i + 20).map(({ publicationId: _id, ...target }) => target) } });
  }
  dueCollections.sort((a, b) => collectionKey(a).localeCompare(collectionKey(b)));
  for (let i = 0; i < dueCollections.length; i += 20) batches.push({ kind: "bilibili-collections", config: { version: 1, collections: dueCollections.slice(i, i + 20) } });
  return { version: 1, plannedAt: at, scopeDigest: hash(JSON.stringify(scope)), planId: hash(JSON.stringify([scope, entries, at])),
    executed: false, cloudWrites: 0, websiteEligibilityRenewed: false, browserSessionRequired: duePublications.some(p => p.platform === "xiaohongshu"),
    summary: { configured: entries.length, due: entries.filter(e => e.status === "due").length, fresh: entries.filter(e => e.status === "fresh").length, reviewRequired: entries.filter(e => e.status === "review-required").length }, entries, batches };
}
function fresh(at: string, now: string) {
  const age = Date.parse(timestamp(now)) - Date.parse(timestamp(at));
  if (age < -30000 || age >= 24 * 3600000) throw new SocialSyncError("REFRESH_OBSERVATION_EXPIRED");
}
/** Wrap existing restricted transports. No role, registration, approval or outbox acknowledgement is added. */
export function reviewedPublicationSender(value: unknown, send: (item: Pending) => Promise<{ key: string; sha256: string }>, now = () => new Date().toISOString()) {
  const scope = refreshConfig(value);
  return async (item: Pending) => {
    const decision = publicationReview(scope, item.observation);
    if (!decision.allowed) throw new SocialSyncError(decision.code);
    if (item.key !== publicationKey(item.observation) || item.sha256 !== hash(JSON.stringify(item.observation))) throw new SocialSyncError("LOCAL_DATA_INVALID");
    const at = now();
    if (Date.parse(scope.reviewedAt) > Date.parse(timestamp(at)) + 30000) throw new SocialSyncError("REFRESH_TIME_INVALID");
    fresh(item.observation.observedAt, at);
    return send(item);
  };
}
export function reviewedCollectionSender(value: unknown, send: (item: CollectionPending) => Promise<{ key: string; sha256: string }>, now = () => new Date().toISOString()) {
  const scope = refreshConfig(value);
  return async (item: CollectionPending) => {
    const decision = collectionReview(scope, item.snapshot);
    if (!decision.allowed) throw new SocialSyncError(decision.code);
    if (item.key !== collectionKey(item.snapshot.target) || item.sha256 !== hash(JSON.stringify(item.snapshot))) throw new SocialSyncError("LOCAL_DATA_INVALID");
    const at = now();
    if (Date.parse(scope.reviewedAt) > Date.parse(timestamp(at)) + 30000) throw new SocialSyncError("REFRESH_TIME_INVALID");
    fresh(item.snapshot.observedAt, at);
    return send(item);
  };
}
