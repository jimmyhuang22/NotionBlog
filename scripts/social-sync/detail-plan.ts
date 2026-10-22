import { config, hash, identity, noteIdentity, object, publicationKey, SocialSyncError, timestamp } from "./model.ts";
import type { Target } from "./model.ts";

function shape(value: unknown, keys: string[]) {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row,k))) throw new SocialSyncError("CATALOG_INVALID");
  return row;
}
/** Offline plan only. A configured item is skipped, not certified fresh; no binding/upload/approval side effects. */
export function planDetailBatches(value: unknown, existing: Target[]) {
  const root = shape(value, ["version", "capturedAt", "complete", "accounts", "entries"]);
  if (root.version !== 1 || root.complete !== true || typeof root.capturedAt !== "string" || !Array.isArray(root.accounts) ||
      root.accounts.length < 1 || root.accounts.length > 4 || !Array.isArray(root.entries) || root.entries.length < 1 || root.entries.length > 1000) throw new SocialSyncError("CATALOG_INVALID");
  timestamp(root.capturedAt);
  const accounts = root.accounts.map(value => {
    const a = shape(value, ["platform", "accountId"]);
    if (!["bilibili","xiaohongshu"].includes(String(a.platform)) || typeof a.accountId !== "string") throw new SocialSyncError("CATALOG_INVALID");
    return { platform: a.platform as Target["platform"], accountId: a.platform === "bilibili" ? identity(a.accountId) : noteIdentity(a.accountId) };
  });
  if (new Set(accounts.map(a=>JSON.stringify(a))).size !== accounts.length) throw new SocialSyncError("CATALOG_INVALID");
  const known = new Set(existing.map(publicationKey)), seen = new Set<string>();
  const ready: Target[] = [], blocked: { key: string; code: string }[] = []; let skippedConfigured = 0;
  for (const value of root.entries) {
    const e = shape(value, ["platform", "accountId", "publicationId", "kind"]);
    const account = accounts.find(a=>a.platform===e.platform && a.accountId===e.accountId);
    if (!account || typeof e.publicationId !== "string" || (account.platform === "bilibili" ?
      !/^BV[0-9A-Za-z]{10}$/.test(e.publicationId) || !["video","unresolved-video-card"].includes(String(e.kind)) :
      !/^[a-f0-9]{24}$/.test(e.publicationId) || !["video","image-note"].includes(String(e.kind)))) throw new SocialSyncError("CATALOG_INVALID");
    const key = publicationKey({ ...account, publicationId: e.publicationId });
    if (seen.has(key)) throw new SocialSyncError("CATALOG_DUPLICATE"); seen.add(key);
    if (known.has(key)) { skippedConfigured++; continue; }
    if (e.kind === "unresolved-video-card") { blocked.push({ key, code: "COLLECTION_SCOPE_REQUIRED" }); continue; }
    const url = account.platform === "bilibili" ? `https://www.bilibili.com/video/${e.publicationId}/` : `https://www.xiaohongshu.com/explore/${e.publicationId}`;
    ready.push({ ...account, publicationId: e.publicationId, workId: `detail_${key.slice(0,40)}`, url });
  }
  ready.sort((a,b)=>publicationKey(a)<publicationKey(b)?-1:1); blocked.sort((a,b)=>a.key<b.key?-1:1);
  const batches: { id: string; config: { version: 1; publications: Omit<Target, "publicationId">[] } }[] = [];
  for (let i=0;i<ready.length;i+=20) {
    const publications = ready.slice(i,i+20), input = { version: 1 as const, publications: publications.map(({publicationId: _id, ...target})=>target) };
    config(input); // Use the existing strict collector validator, including the twenty-item bound.
    batches.push({ id: hash(JSON.stringify(publications)), config: input });
  }
  return { version: 1, sourceCapturedAt: root.capturedAt, planId: hash(JSON.stringify([root,existing])), executed: false,
    inputEntries: root.entries.length, skippedConfigured, ready: ready.length, blocked, batches };
}
