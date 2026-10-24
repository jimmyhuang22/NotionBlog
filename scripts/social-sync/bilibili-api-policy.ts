import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { hash, object, SocialSyncError } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import type { RefreshConfig } from "./refresh.ts";
import { lstat } from "node:fs/promises";

export interface BilibiliApiPolicy { version: 1; enabled: boolean; baseScopeDigest: string; stateDirectories: { publications: string; collections: string } }
const overlaps = (a: string, b: string) => { const r = relative(a, b); return !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep); };
const clean = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && resolve(v) === v && !/[\r\n\0]/.test(v);
/** Old installed tools must never encounter a new source in their shared SQLite files. */
export async function readBilibiliApiPolicy(root: string, base: RefreshConfig): Promise<BilibiliApiPolicy | null> {
  let raw: string; try { raw = await readPrivateFile(join(root, "bilibili-api.json"), 8192); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const p = object(JSON.parse(raw)), dirs = object(p.stateDirectories);
  if (Object.keys(p).sort().join() !== "baseScopeDigest,enabled,stateDirectories,version" || p.version !== 1 || typeof p.enabled !== "boolean" ||
      typeof p.baseScopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(p.baseScopeDigest) || Object.keys(dirs).sort().join() !== "collections,publications" ||
      !clean(dirs.publications) || !clean(dirs.collections)) throw new SocialSyncError("BILIBILI_API_CONFIG_INVALID");
  if(!p.enabled)return p as unknown as BilibiliApiPolicy;
  if(dirs.publications===root)throw new SocialSyncError("BILIBILI_API_STATE_OVERLAP");
  if (p.baseScopeDigest !== hash(JSON.stringify(base))) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
  const candidates = [dirs.publications, dirs.collections], old = [base.stateDirectories.publications, base.stateDirectories.collections];
  if (p.enabled) {
    try { const http = object(JSON.parse(await readPrivateFile(join(root, "xiaohongshu-http.json"), 8192))); if (!clean(http.stateDirectory)) throw new SocialSyncError("BILIBILI_API_STATE_OVERLAP"); old.push(http.stateDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (overlaps(candidates[0], candidates[1]) || overlaps(candidates[1], candidates[0]) || candidates.some(d => old.some(o => overlaps(d, o) || overlaps(o, d)))) throw new SocialSyncError("BILIBILI_API_STATE_OVERLAP");
  return p as unknown as BilibiliApiPolicy;
}
export async function apiRefreshScope(root: string, base: RefreshConfig, scope: RefreshConfig): Promise<RefreshConfig> {
  const policy = await readBilibiliApiPolicy(root, base);
  return policy?.enabled ? { ...scope, stateDirectories: { ...policy.stateDirectories } } : scope;
}
export const bilibiliMetadataRoot = (root: string, policy: BilibiliApiPolicy | null) => policy?.enabled ? policy.stateDirectories.publications : root;
export async function readBilibiliMetadataRoot(root: string): Promise<string> {
  try{await lstat(join(root,"bilibili-api.json"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return root;throw error;}
  const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES)));
  return bilibiliMetadataRoot(root,await readBilibiliApiPolicy(root,base));
}
/** Enabling a source must not silently discard an existing operator pause or capture packet. */
export async function requireApiMetadataTransfer(root: string, metadataRoot: string, directory: "cycle-bilibili" | "discovery-bilibili", file: "health.json" | "state.json" | "latest-cycle.json") {
  if(root===metadataRoot)return;
  try{await lstat(join(metadataRoot,directory,file));return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  try{await lstat(join(root,directory,file));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  throw new SocialSyncError("BILIBILI_API_STATE_PREPARATION_REQUIRED");
}
