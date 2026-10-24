import { Pool } from "pg";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { cloudConfig } from "./cloud.ts";
import { hash, SocialSyncError } from "./model.ts";
import { collectionKey, MAX_COLLECTION_SNAPSHOT_BYTES, validateCollectionSnapshot } from "./collection.ts";
import type { CollectionPending } from "./collection-store.ts";

export function collectionPayload(item:CollectionPending) {
  const snapshot=validateCollectionSnapshot(item.snapshot), raw=JSON.stringify(snapshot);
  if (item.key!==collectionKey(snapshot.target) || hash(raw)!==item.sha256 || Buffer.byteLength(raw)>MAX_COLLECTION_SNAPSHOT_BYTES) throw new SocialSyncError("LOCAL_DATA_INVALID");
  return raw;
}
export async function createCollectionTransport(sql:SqlExecutor,signal?:AbortSignal,accountMode=false,bilibiliApi=false) {
  const check=(operationSignal?:AbortSignal)=>{if(signal?.aborted||operationSignal?.aborted)throw new SocialSyncError("CANCELLED");};check();
  let rows;
  try { rows=(await sql.query<{role:string;login:string;version:number;elevated:boolean;bilibili_api_version?:number}>(`SELECT current_user::text role,session_user::text login,
    (SELECT version FROM social_sync.collection_meta WHERE singleton) version,
    ${bilibiliApi ? "(SELECT bilibili_api_version FROM social_sync.collection_meta WHERE singleton) bilibili_api_version," : ""}
    (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication OR rolinherit OR
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)) elevated FROM pg_roles WHERE rolname=current_user`)).rows; }
  catch(error) {throw new SocialSyncError(bilibiliApi&&(error as {code?:string})?.code==="42703"?"BILIBILI_API_PROTOCOL_REQUIRED":"COLLECTION_CLOUD_UNAVAILABLE");}
  check();const row=rows[0];
  if(rows.length!==1 || row.role!=="nb_social_worker" || row.login!=="nb_social_worker" || row.version!==1 || row.elevated!==false)throw new SocialSyncError("CLOUD_HANDSHAKE_INVALID");
  if(bilibiliApi&&row.bilibili_api_version!==1)throw new SocialSyncError("BILIBILI_API_PROTOCOL_REQUIRED");
  return async (item:CollectionPending,operationSignal?:AbortSignal)=>{
    check(operationSignal);const payload=collectionPayload(item);let receipts;
    if(!bilibiliApi&&item.snapshot.source==="bilibili-collection-api-json")throw new SocialSyncError("BILIBILI_API_PROTOCOL_REQUIRED");
    try {receipts=(await sql.query<{key:string;sha256:string}>(accountMode?"SELECT key,sha256 FROM social_sync.ingest_bilibili_account('collection',$1,$2,$3)":"SELECT key,sha256 FROM social_sync.ingest_collection($1,$2,$3)",[item.key,item.sha256,payload])).rows;}
    catch {throw new SocialSyncError("COLLECTION_UPLOAD_FAILED");}
    check(operationSignal);const r=receipts[0];
    if(receipts.length!==1 || r.key!==item.key || r.sha256!==item.sha256)throw new SocialSyncError("ACK_MISMATCH");
    return {key:r.key,sha256:r.sha256};
  };
}
export async function connectCollectionCloud(raw:string,signal?:AbortSignal,accountMode=false) {
  const pool=new Pool(cloudConfig(raw));pool.on("error",()=>{});let client;
  try {client=await pool.connect();const send=await createCollectionTransport(client,signal,accountMode);
    return {send,close:async()=>{client!.release(true);await pool.end();}};
  } catch(error) {client?.release(true);await pool.end();throw error instanceof SocialSyncError?error:new SocialSyncError("COLLECTION_CLOUD_UNAVAILABLE");}
}
