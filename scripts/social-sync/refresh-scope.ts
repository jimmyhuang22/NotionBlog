import { join } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { collectionKey } from "./collection.ts";
import { hash, object, SocialSyncError } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import type { RefreshConfig } from "./refresh.ts";
import { appendAccountScope } from "./bilibili-account-scope.ts";
import { apiRefreshScope } from "./bilibili-api-policy.ts";

/** Keep the shared configuration byte-compatible with the installed Xiaohongshu bridge. */
export async function readRefreshScope(root: string, platform: "bilibili" | "xiaohongshu"): Promise<RefreshConfig> {
  const base = refreshConfig(JSON.parse(await readPrivateFile(join(root, "refresh-config.json"), MAX_REFRESH_CONFIG_BYTES)));
  if (platform === "xiaohongshu") return base;
  let raw: string;
  try { raw = await readPrivateFile(join(root, "bilibili-follow.json"), 64 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return apiRefreshScope(root, base, await appendAccountScope(root, base, base)); throw error; }
  const policy = object(JSON.parse(raw));
  if (Object.keys(policy).length !== 3 || policy.version !== 1 || typeof policy.baseScopeDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(policy.baseScopeDigest) || !Array.isArray(policy.collectionKeys) || policy.collectionKeys.length < 1 ||
      policy.collectionKeys.length > base.collections.length || policy.collectionKeys.some(k => typeof k !== "string" || !/^[a-f0-9]{64}$/.test(k)) ||
      new Set(policy.collectionKeys).size !== policy.collectionKeys.length || base.collections.some(c => c.membershipMode !== undefined)) {
    throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  }
  if (policy.baseScopeDigest !== hash(JSON.stringify(base))) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
  const keys = new Set(policy.collectionKeys as string[]), configured = new Set(base.collections.map(c => collectionKey(c.target)));
  if ([...keys].some(key => !configured.has(key))) throw new SocialSyncError("REFRESH_CONFIG_INVALID");
  const follows = refreshConfig({ ...base, collections: base.collections.map(c => keys.has(collectionKey(c.target)) ? { ...c, membershipMode: "follow-public" } : c) });
  return apiRefreshScope(root, base, await appendAccountScope(root, base, follows));
}
