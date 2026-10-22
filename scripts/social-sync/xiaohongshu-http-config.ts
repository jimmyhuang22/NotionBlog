import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { hash, object, SocialSyncError } from "./model.ts";
import type { Target } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import type { RefreshConfig } from "./refresh.ts";
import { checkedNoteShareUrl } from "./xiaohongshu-http.ts";
import { readXhsAccountPolicy, readXhsDiscoveredScope,candidateNoteShareUrl } from "./xiaohongshu-account.ts";
import { readXhsDiscoveryState } from "./xiaohongshu-discovery-bridge.ts";

export interface HttpNotePolicy {
  version: 1; enabled: boolean; baseScopeDigest: string; linksDigest: string;
  stateDirectory: string; pythonExecutable: string;
}
const cleanPath = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) &&
  resolve(value) === value && !/[\r\n\0]/.test(value);
const contains = (a: string, b: string) => { const r = relative(a, b); return !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep); };
export const statePathsOverlap = (a: string, b: string) => contains(a, b) || contains(b, a);
export async function readHttpNotePolicy(root: string): Promise<HttpNotePolicy | null> {
  let raw: string;
  try { raw = await readPrivateFile(join(root, "xiaohongshu-http.json"), 8192); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const p = object(JSON.parse(raw));
  const keys = ["version", "enabled", "baseScopeDigest", "linksDigest", "stateDirectory", "pythonExecutable"];
  if (Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k)) || p.version !== 1 || typeof p.enabled !== "boolean" ||
    typeof p.baseScopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(p.baseScopeDigest) ||
    typeof p.linksDigest !== "string" || !/^[a-f0-9]{64}$/.test(p.linksDigest) ||
    !cleanPath(p.stateDirectory) || !cleanPath(p.pythonExecutable)) throw new SocialSyncError("XHS_HTTP_CONFIG_INVALID");
  return p as unknown as HttpNotePolicy;
}
export function httpNoteLinks(value: unknown, targets: Target[]): Map<string, string> {
  const raw = object(value);
  if (raw.version !== 1 || Object.keys(raw).length !== 2 || !Array.isArray(raw.links) || raw.links.length !== targets.length) throw new SocialSyncError("XHS_HTTP_LINK_INVALID");
  const byId = new Map(targets.map(t => [t.publicationId, t])), links = new Map<string, string>();
  for (const input of raw.links) {
    const link = object(input);
    if (Object.keys(link).length !== 2 || typeof link.publicationId !== "string" || typeof link.url !== "string" ||
      !byId.has(link.publicationId) || links.has(link.publicationId)) throw new SocialSyncError("XHS_HTTP_LINK_INVALID");
    links.set(link.publicationId, checkedNoteShareUrl(link.url, byId.get(link.publicationId)!));
  }
  return links;
}
export async function readHttpNoteScope(root: string): Promise<{ policy: HttpNotePolicy; scope: RefreshConfig; links: Map<string, string> }> {
  const policy = await readHttpNotePolicy(root);
  if (!policy?.enabled) throw new SocialSyncError("XHS_HTTP_DISABLED");
  const base = refreshConfig(JSON.parse(await readPrivateFile(join(root, "refresh-config.json"), MAX_REFRESH_CONFIG_BYTES)));
  if (hash(JSON.stringify(base)) !== policy.baseScopeDigest) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
  if (statePathsOverlap(policy.stateDirectory, base.stateDirectories.publications) || statePathsOverlap(policy.stateDirectory, base.stateDirectories.collections)) throw new SocialSyncError("XHS_HTTP_STATE_OVERLAP");
  const account = await readXhsAccountPolicy(root,base);
  const original = base.publications.filter(p => p.target.platform === "xiaohongshu");
  const extra=account?.enabled?(await readXhsDiscoveredScope(root,base,account)).publications:[];
  const publications=[...original,...extra];
  if (!publications.length || publications.length > 500 || new Set(publications.map(p => p.target.accountId)).size !== 1) throw new SocialSyncError("XHS_HTTP_CONFIG_INVALID");
  const rawLinks = await readPrivateFile(join(root, "browser-links.json"), 128 * 1024);
  if (hash(rawLinks) !== policy.linksDigest) throw new SocialSyncError("XHS_HTTP_LINKS_CHANGED");
  const links = httpNoteLinks(JSON.parse(rawLinks), original.map(p => p.target));
  if(account?.enabled){
    const directory=await readXhsDiscoveryState(root,hash(JSON.stringify(account)));
    for(const entry of directory?.links??[]){const target=extra.find(p=>p.target.publicationId===entry.publicationId)?.target;if(target)links.set(entry.publicationId,candidateNoteShareUrl(entry.url,target));}
    if(extra.some(p=>!links.has(p.target.publicationId)))throw new SocialSyncError("XHS_HTTP_LINK_INVALID");
  }
  // The installed Bilibili release still reads the original database and its browser-only rows.
  const scope = refreshConfig({ ...base, publications, collections: [],cadence:{...base.cadence,xiaohongshuHours:account?.enabled?1:base.cadence.xiaohongshuHours},
    stateDirectories: { ...base.stateDirectories, publications: policy.stateDirectory } });
  return { policy, scope, links };
}
