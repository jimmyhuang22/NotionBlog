import type { SqlExecutor } from "../../src/server/database/sql.ts";
import type { CollectionAdditionHistory } from "./collection-addition-history.ts";
import { openCollectionStore } from "./collection-store.ts";
import { SocialSyncError } from "./model.ts";
import { open } from "node:fs/promises";
import { dirname,isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { privateDirectory } from "../notion-sync/state.ts";

export interface CollectionDayBackfillPlan {key:string;expectedPayloadSHA256:string;sampleCount:number;history:CollectionAdditionHistory|null}
export async function planCollectionDayBackfill(root:string):Promise<CollectionDayBackfillPlan[]> {
  const store=await openCollectionStore(root,true);
  if(!store)return [];
  try{return store.additionHistoryPlans();}finally{store.close();}
}
/** Administration-only. The existing worker cannot write the derived column. */
export async function applyCollectionDayBackfill(sql:SqlExecutor,plans:CollectionDayBackfillPlan[]) {
  if(plans.length>500)throw new SocialSyncError("COLLECTION_EXPORT_TOO_LARGE");
  const result={applied:0,unknown:0,sourceChanged:0};
  for(const plan of plans){
    if(!plan.history){result.unknown++;continue;}
    if(!/^[a-f0-9]{64}$/.test(plan.key)||!/^[a-f0-9]{64}$/.test(plan.expectedPayloadSHA256))throw new SocialSyncError("LOCAL_DATA_INVALID");
    const rows=(await sql.query<{collection_key:string}>(`UPDATE social_sync.collection_states SET addition_history=$3::jsonb
      WHERE collection_key=$1 AND payload_sha256=$2 RETURNING collection_key`,[plan.key,plan.expectedPayloadSHA256,JSON.stringify(plan.history)])).rows;
    if(rows.length===0)result.sourceChanged++;else if(rows.length===1&&rows[0]!.collection_key===plan.key)result.applied++;else throw new SocialSyncError("ACK_MISMATCH");
  }
  return result;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const [mode,root,output,proof]=process.argv.slice(2);
  if(mode!=="--plan"||!root||!output||!isAbsolute(root)||!isAbsolute(output)||proof!=="--complete-local-history")throw new SocialSyncError("USAGE");
  process.umask(0o077);await privateDirectory(dirname(output));
  const plans=await planCollectionDayBackfill(root),file=await open(output,"wx",0o600);
  try{await file.writeFile(JSON.stringify({format:"collection-day-backfill-v1",requiresReviewedCompleteLocalHistory:true,cloudWrites:0,plans},null,2)+"\n");await file.sync();}finally{await file.close();}
  console.log(JSON.stringify({planned:plans.length,proven:plans.filter(p=>p.history!==null).length,unknown:plans.filter(p=>p.history===null).length,sourceRequests:0,cloudWrites:0}));
}
