import { parseEnv } from "node:util";
import { Pool, type PoolConfig } from "pg";
import { databasePoolConfig } from "../../src/server/database/connection.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { hash, publicationKey, SocialSyncError, validateObservation } from "./model.ts";
import type { Pending } from "./store.ts";

export const SOCIAL_SCHEMA_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 196608;
export interface XhsAccountTransport {accountId:string;link:(item:Pending)=>{url:string;checkedAt:string}|null}
const ROLE = "nb_social_worker";
export function cloudConfig(raw: string): PoolConfig {
  try {
    const env = parseEnv(raw);
    if (Object.keys(env).some(k => !["SOCIAL_DATABASE_URL", "DATABASE_TLS", "DATABASE_CA_CERT"].includes(k))) throw new Error();
    if (!env.SOCIAL_DATABASE_URL) throw new Error();
    const url = new URL(env.SOCIAL_DATABASE_URL);
    if (decodeURIComponent(url.username).split(".")[0] !== ROLE) throw new Error();
    return { ...databasePoolConfig(env.SOCIAL_DATABASE_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT), max: 1,
      application_name: "notionblog-social-sync", statement_timeout: 10000, query_timeout: 12000 };
  } catch { throw new SocialSyncError("CLOUD_CONFIG_INVALID"); }
}
export function pendingPayload(item: Pending): string {
  validateObservation(item.observation);
  const payload = JSON.stringify(item.observation);
  if (item.key !== publicationKey(item.observation) || hash(payload) !== item.sha256 || Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    throw new SocialSyncError("LOCAL_DATA_INVALID");
  }
  return payload;
}
export async function createCloudTransport(sql: SqlExecutor, signal?: AbortSignal, accountMode = false, httpNotes = false,xhsAccount?:XhsAccountTransport) {
  if (accountMode && httpNotes) throw new SocialSyncError("LOCAL_DATA_INVALID");
  if(xhsAccount&&(!httpNotes||!/^[a-f0-9]{24}$/.test(xhsAccount.accountId)))throw new SocialSyncError("LOCAL_DATA_INVALID");
  const check = (operationSignal?: AbortSignal) => { if (signal?.aborted || operationSignal?.aborted) throw new SocialSyncError("CANCELLED"); };
  check();
  let handshake;
  try {
    handshake = await sql.query<{ role: string; login: string; version: number; elevated: boolean; http_note_version?: number;xhs_account_version?:number;xhs_account_enabled?:boolean }>(`SELECT current_user::text role,session_user::text login,
      (SELECT version FROM social_sync.meta WHERE singleton) version,
      ${httpNotes ? "(SELECT http_note_version FROM social_sync.meta WHERE singleton) http_note_version," : ""}
      ${xhsAccount ? "(SELECT xhs_account_version FROM social_sync.meta WHERE singleton) xhs_account_version,social_sync.xiaohongshu_account_enabled($1) xhs_account_enabled," : ""}
      (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication OR rolinherit OR
        EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) FROM pg_roles r WHERE rolname=current_user) elevated`,xhsAccount?[xhsAccount.accountId]:undefined);
  } catch (error) { const code=(error as {code?:string})?.code;throw new SocialSyncError(xhsAccount&&["42703","42883"].includes(code??"")?"XHS_ACCOUNT_PROTOCOL_REQUIRED":httpNotes&&code==="42703"?"XHS_HTTP_PROTOCOL_REQUIRED":"CLOUD_UNAVAILABLE"); }
  check();
  const h = handshake.rows[0];
  if (handshake.rows.length !== 1 || h.role !== ROLE || h.login !== ROLE || h.version !== SOCIAL_SCHEMA_VERSION || h.elevated !== false) {
    throw new SocialSyncError("CLOUD_HANDSHAKE_INVALID");
  }
  if (httpNotes && h.http_note_version !== 1) throw new SocialSyncError("XHS_HTTP_PROTOCOL_REQUIRED");
  if(xhsAccount&&(h.xhs_account_version!==1||h.xhs_account_enabled!==true))throw new SocialSyncError("XHS_ACCOUNT_PROTOCOL_REQUIRED");
  return async (item: Pending, operationSignal?: AbortSignal) => {
    check(operationSignal); const payload = pendingPayload(item);
    if (accountMode && item.observation.platform !== "bilibili") throw new SocialSyncError("LOCAL_DATA_INVALID");
    if (httpNotes && item.observation.platform !== "xiaohongshu") throw new SocialSyncError("LOCAL_DATA_INVALID");
    if(xhsAccount&&item.observation.accountId!==xhsAccount.accountId)throw new SocialSyncError("LOCAL_DATA_INVALID");
    if (!httpNotes && item.observation.source === "public-note-page-ssr") throw new SocialSyncError("XHS_HTTP_PROTOCOL_REQUIRED");
    let result;
    try { const link=xhsAccount?.link(item);result = await sql.query<{ key: string; sha256: string }>(xhsAccount?"SELECT key,sha256 FROM social_sync.ingest_xiaohongshu_account($1,$2,$3,$4,$5)":accountMode ? "SELECT key,sha256 FROM social_sync.ingest_bilibili_account('publication',$1,$2,$3)" : "SELECT key,sha256 FROM social_sync.ingest($1,$2,$3)", [item.key, item.sha256, payload,...(xhsAccount?[link?.url??null,link?.checkedAt??null]:[])]); }
    catch { throw new SocialSyncError("CLOUD_UPLOAD_FAILED"); }
    // An interrupted response must remain pending even if the server already committed it.
    check(operationSignal);
    const receipt = result.rows[0];
    if (result.rows.length !== 1 || receipt.key !== item.key || receipt.sha256 !== item.sha256) throw new SocialSyncError("ACK_MISMATCH");
    return { key: receipt.key, sha256: receipt.sha256 };
  };
}
export async function connectCloud(raw: string, signal?: AbortSignal, accountMode = false) {
  const pool = new Pool(cloudConfig(raw)); pool.on("error", () => {});
  let client;
  try {
    client = await pool.connect();
    const send = await createCloudTransport(client, signal, accountMode);
    return { send, close: async () => { client!.release(true); await pool.end(); } };
  } catch (error) {
    client?.release(true); await pool.end();
    throw error instanceof SocialSyncError ? error : new SocialSyncError("CLOUD_UNAVAILABLE");
  }
}
