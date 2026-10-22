import { join } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { config, hash, noteIdentity, object, publicationKey, SocialSyncError, timestamp } from "./model.ts";
import type { Target } from "./model.ts";
import { refreshConfig } from "./refresh.ts";
import type { RefreshConfig, ReviewedPublication } from "./refresh.ts";
import { checkedNoteShareUrl } from "./xiaohongshu-http.ts";

export interface XhsAccountPolicy { version: 1; enabled: boolean; accountId: string; baseScopeDigest: string; discoveryHours: 1; statisticsHours: 1 }
export interface XhsDirectoryCard { publicationId: string; url: string }
export interface XhsDirectory { version: 1; accountId: string; observedAt: string; cards: XhsDirectoryCard[]; boundaryFound: boolean }
export interface XhsDiscoveredScope { version: 1; policyDigest: string; publications: ReviewedPublication[] }
export async function readXhsAccountPolicy(root: string, base: RefreshConfig): Promise<XhsAccountPolicy | null> {
  let raw: string;
  try { raw = await readPrivateFile(join(root,"xiaohongshu-account.json"),4096); }
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  const p=object(JSON.parse(raw));
  if(Object.keys(p).sort().join()!=="accountId,baseScopeDigest,discoveryHours,enabled,statisticsHours,version"||p.version!==1||typeof p.enabled!=="boolean"||
    typeof p.accountId!=="string"||noteIdentity(p.accountId)!==p.accountId||p.baseScopeDigest!==hash(JSON.stringify(base))||p.discoveryHours!==1||p.statisticsHours!==1||
    !base.publications.some(p0=>p0.target.platform==="xiaohongshu"&&p0.target.accountId===p.accountId)||base.publications.some(p0=>p0.target.platform==="xiaohongshu"&&p0.target.accountId!==p.accountId))throw new SocialSyncError("XHS_ACCOUNT_POLICY_INVALID");
  return p as unknown as XhsAccountPolicy;
}
export function automaticNoteTarget(accountId:string,id:string):Target{
  const target=config({version:1,publications:[{platform:"xiaohongshu",accountId:noteIdentity(accountId),workId:"example",url:`https://www.xiaohongshu.com/explore/${noteIdentity(id)}`} ]})[0]!;
  return {...target,workId:`xa_${publicationKey(target).slice(0,40)}`};
}
/** Only a candidate: publication/link evidence must come from actually reading this locator. */
export function candidateNoteShareUrl(value:string,target:Target):string{
  const url=new URL(checkedNoteShareUrl(value,target));
  return `https://www.xiaohongshu.com/discovery/item/${target.publicationId}?source=webshare&xhsshare=pc_web&xsec_token=${url.searchParams.get("xsec_token")}&xsec_source=pc_share`;
}
/** A bounded posted-list observation proves positive sightings, never deletion or a full history. */
export function xhsDirectory(value:unknown,accountId:string,at:string):XhsDirectory{
  const d=object(value);
  if(Object.keys(d).sort().join()!=="accountId,boundaryFound,cards,observedAt,version"||d.version!==1||d.accountId!==noteIdentity(accountId)||typeof d.observedAt!=="string"||
    typeof d.boundaryFound!=="boolean"||!Array.isArray(d.cards)||d.cards.length<1||d.cards.length>300)throw new SocialSyncError("XHS_DIRECTORY_INVALID");
  const age=Date.parse(timestamp(at))-Date.parse(timestamp(d.observedAt));if(age < -30000||age>5*60000)throw new SocialSyncError("XHS_DIRECTORY_EXPIRED");
  const cards=d.cards.map(input=>{
    const c=object(input);if(Object.keys(c).sort().join()!=="publicationId,url"||typeof c.publicationId!=="string"||typeof c.url!=="string")throw new SocialSyncError("XHS_DIRECTORY_INVALID");
    const target=automaticNoteTarget(accountId,c.publicationId);return {publicationId:target.publicationId,url:checkedNoteShareUrl(c.url,target)};
  });
  if(new Set(cards.map(c=>c.publicationId)).size!==cards.length||!d.boundaryFound)throw new SocialSyncError("XHS_DIRECTORY_GAP");
  return {version:1,accountId,observedAt:d.observedAt,cards,boundaryFound:true};
}
export async function readXhsDiscoveredScope(root:string,base:RefreshConfig,policy:XhsAccountPolicy):Promise<XhsDiscoveredScope>{
  let raw:string;try{raw=await readPrivateFile(join(root,"xiaohongshu-discovered.json"),256*1024);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return {version:1,policyDigest:hash(JSON.stringify(policy)),publications:[]};}
  const d=object(JSON.parse(raw));if(Object.keys(d).sort().join()!=="policyDigest,publications,version"||d.version!==1||d.policyDigest!==hash(JSON.stringify(policy))||!Array.isArray(d.publications))throw new SocialSyncError("XHS_DISCOVERED_SCOPE_INVALID");
  const pubs=refreshConfig({...base,publications:[...base.publications,...d.publications]}).publications.slice(base.publications.length);
  if(pubs.some(p=>p.target.platform!=="xiaohongshu"||p.target.accountId!==policy.accountId||p.target.workId!==automaticNoteTarget(policy.accountId,p.target.publicationId).workId))throw new SocialSyncError("XHS_DISCOVERED_SCOPE_INVALID");
  return {version:1,policyDigest:hash(JSON.stringify(policy)),publications:pubs};
}
export const newDirectoryCards=(directory:XhsDirectory,known:Iterable<string>)=>{const ids=new Set(known);return directory.cards.filter(c=>!ids.has(c.publicationId));};
