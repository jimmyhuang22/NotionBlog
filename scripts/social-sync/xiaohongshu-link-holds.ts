import { join } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash, object, SocialSyncError, timestamp } from "./model.ts";
export interface NoteLinkHold {key:string;linkSha256:string;at:string;code:"SOURCE_NOTE_UNAVAILABLE"|"NOTE_BROWSER_REQUIRED"}
export async function readNoteLinkHolds(root:string):Promise<NoteLinkHold[]>{
  let raw:string;try{raw=await readPrivateFile(join(root,"xiaohongshu-link-holds.json"),128*1024);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
  const d=object(JSON.parse(raw));if(Object.keys(d).sort().join()!=="holds,version"||d.version!==1||!Array.isArray(d.holds)||d.holds.length>500)throw new SocialSyncError("XHS_LINK_HOLDS_INVALID");
  const seen=new Set<string>();for(const rawHold of d.holds){const h=object(rawHold);if(Object.keys(h).sort().join()!=="at,code,key,linkSha256"||typeof h.key!=="string"||!/^[a-f0-9]{64}$/.test(h.key)||seen.has(h.key)||typeof h.linkSha256!=="string"||!/^[a-f0-9]{64}$/.test(h.linkSha256)||typeof h.at!=="string"||!["SOURCE_NOTE_UNAVAILABLE","NOTE_BROWSER_REQUIRED"].includes(String(h.code)))throw new SocialSyncError("XHS_LINK_HOLDS_INVALID");timestamp(h.at);seen.add(h.key);}
  return d.holds as NoteLinkHold[];
}
/** Caller owns the existing root lock. A new actual locator releases only that locator's hold. */
export async function holdNoteLink(root:string,key:string,url:string,at=new Date().toISOString(),code:NoteLinkHold["code"]="SOURCE_NOTE_UNAVAILABLE"){
  if(!/^[a-f0-9]{64}$/.test(key))throw new SocialSyncError("XHS_LINK_HOLDS_INVALID");timestamp(at);
  const holds=(await readNoteLinkHolds(root)).filter(h=>h.key!==key);holds.push({key,linkSha256:hash(url),at,code});
  await writeJson(join(root,"xiaohongshu-link-holds.json"),{version:1,holds});
}
