import { join } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { automaticVideoTarget } from "./bilibili-discovery.ts";
import { collectionKey } from "./collection.ts";
import { hash, identity, object, publicationKey, SocialSyncError } from "./model.ts";
import { refreshConfig } from "./refresh.ts";
import type { RefreshConfig, ReviewedCollection, ReviewedPublication } from "./refresh.ts";

export interface AccountPolicy { version: 1; baseScopeDigest: string; accountId: string; enabled: boolean }
export interface DiscoveredScope { version: 1; policyDigest: string; publications: ReviewedPublication[]; collections: ReviewedCollection[] }
export async function readAccountPolicy(root: string, base: RefreshConfig): Promise<AccountPolicy | null> {
  let raw: string;
  try { raw = await readPrivateFile(join(root, "bilibili-account.json"), 4096); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const p = object(JSON.parse(raw));
  if (Object.keys(p).sort().join() !== "accountId,baseScopeDigest,enabled,version" || p.version !== 1 || typeof p.enabled !== "boolean" ||
      typeof p.accountId !== "string" || identity(p.accountId) !== p.accountId || p.baseScopeDigest !== hash(JSON.stringify(base)) ||
      !base.publications.some(v => v.target.platform === "bilibili" && v.target.accountId === p.accountId)) throw new SocialSyncError("BILIBILI_ACCOUNT_POLICY_INVALID");
  return { version: 1, baseScopeDigest: p.baseScopeDigest as string, accountId: p.accountId, enabled: p.enabled };
}
export function discoveredScope(value: unknown, base: RefreshConfig, policy: AccountPolicy): DiscoveredScope {
  const d = object(value);
  if (Object.keys(d).sort().join() !== "collections,policyDigest,publications,version" || d.version !== 1 || d.policyDigest !== hash(JSON.stringify(policy)) ||
      !Array.isArray(d.publications) || !Array.isArray(d.collections)) throw new SocialSyncError("BILIBILI_DISCOVERED_SCOPE_INVALID");
  const merged = refreshConfig({ ...base, publications: [...base.publications, ...d.publications], collections: [...base.collections, ...d.collections] });
  const publications = merged.publications.slice(base.publications.length), collections = merged.collections.slice(base.collections.length);
  if (publications.some(p => p.target.platform !== "bilibili" || p.target.accountId !== policy.accountId || p.kind !== "video" ||
      p.target.workId !== automaticVideoTarget(policy.accountId, p.target.publicationId).workId) ||
      collections.some(c => c.target.accountId !== policy.accountId || c.membershipMode !== "follow-public")) throw new SocialSyncError("BILIBILI_DISCOVERED_SCOPE_INVALID");
  // The config parser also checks duplicate keys and its total resource bound.
  const keys = [...publications.map(p => publicationKey(p.target)), ...collections.map(c => collectionKey(c.target))];
  if (new Set(keys).size !== keys.length) throw new SocialSyncError("BILIBILI_DISCOVERED_SCOPE_INVALID");
  return { version: 1, policyDigest: hash(JSON.stringify(policy)), publications, collections };
}
export async function readDiscoveredScope(root: string, base: RefreshConfig, policy: AccountPolicy) {
  try { return discoveredScope(JSON.parse(await readPrivateFile(join(root, "bilibili-discovered.json"), 512 * 1024)), base, policy); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return { version: 1 as const, policyDigest: hash(JSON.stringify(policy)), publications: [], collections: [] }; }
}
export async function appendAccountScope(root: string, base: RefreshConfig, follows: RefreshConfig): Promise<RefreshConfig> {
  const policy = await readAccountPolicy(root, base);
  if (!policy?.enabled) return follows;
  const extra = await readDiscoveredScope(root, base, policy);
  return refreshConfig({ ...follows, publications: [...follows.publications, ...extra.publications], collections: [...follows.collections, ...extra.collections] });
}
