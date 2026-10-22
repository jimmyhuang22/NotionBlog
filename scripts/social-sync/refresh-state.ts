import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { acquireLock,privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { openStore } from "./store.ts";
import { openCollectionStore } from "./collection-store.ts";
import { collectionKey } from "./collection.ts";
import { publicationKey,SocialSyncError } from "./model.ts";
import { planRefresh } from "./refresh.ts";
import { readRefreshScope } from "./refresh-scope.ts";
import type { RefreshConfig } from "./refresh.ts";
import { reviewCandidate } from "./refresh-executor.ts";

/** Consistent read-only work selection, under the same source locks as the executor. */
export async function inspectRefresh(root:string,platform:"bilibili"|"xiaohongshu",at=new Date().toISOString(),scopeProvider?:()=>Promise<RefreshConfig>){
  await privateDirectory(root);
  const readScope=scopeProvider??(()=>readRefreshScope(root,platform)),scope=await readScope();
  const dirs=[root,...(scope.publications.length?[scope.stateDirectories.publications]:[]),...(scope.collections.length?[scope.stateDirectories.collections]:[])];
  const releases:(()=>Promise<void>)[]=[];
  let pubs:Awaited<ReturnType<typeof openStore>>=null,cols:Awaited<ReturnType<typeof openCollectionStore>>=null;
  try{
    for(const dir of [...new Set(dirs)].sort()){await lstat(dir);releases.push(await acquireLock(dir,randomUUID()));}
    if(scope.publications.length){pubs=await openStore(scope.stateDirectories.publications,true);if(!pubs)throw new SocialSyncError("REFRESH_STATE_MISSING");pubs.checkTargets(scope.publications.map(p=>p.target));}
    if(scope.collections.length){cols=await openCollectionStore(scope.stateDirectories.collections,true);if(!cols||cols.status().pending===null)throw new SocialSyncError("REFRESH_STATE_UPGRADE_REQUIRED");}
    const plan=planRefresh(scope,{publication:t=>pubs?.latest(t)??null,collection:t=>cols?.latest(t)?.snapshot??null},at);
    const pending=new Set<string>(),held=new Set<string>();
    for(const entry of plan.entries.filter(e=>e.platform===platform)){
      try{
        const record=JSON.parse(await readPrivateFile(join(root,`review-${entry.type}-${entry.key}.json`),600*1024));
        if(record.version!==1||record.candidate?.key!==entry.key||record.candidate?.type!==entry.type)throw new SocialSyncError("LOCAL_DATA_INVALID");
        if(!reviewCandidate(scope,record.candidate).allowed)held.add(entry.key);
      }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      if(entry.type==="publication"){
        const target=scope.publications.find(p=>publicationKey(p.target)===entry.key)!.target;
        if(pubs!.pendingFor(target))pending.add(entry.key);
      }else{
        const target=scope.collections.find(c=>collectionKey(c.target)===entry.key)!.target;
        if(cols!.pendingFor(target))pending.add(entry.key);
      }
    }
    // Changes while waiting for locks must not publish a plan for the old scope.
    const after=await readScope();
    if(JSON.stringify(after)!==JSON.stringify(scope))throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    const entries=plan.entries.filter(e=>e.platform===platform).map(e=>({...e,pending:pending.has(e.key),held:held.has(e.key)||e.status==="review-required"}));
    return {scope,scopeDigest:plan.scopeDigest,entries,keys:entries.filter(e=>!e.held&&(e.status==="due"||e.pending)).map(e=>e.key).sort(),reviewRequired:entries.filter(e=>e.held).length};
  }finally{pubs?.close();cols?.close();for(const release of releases.reverse())await release();}
}
