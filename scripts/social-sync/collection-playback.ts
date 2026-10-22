import { Pool } from "pg";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { cloudConfig } from "./cloud.ts";
import { fetchCollectionPage } from "./bilibili.ts";
import { collectionFromPage, collectionKey, collectionTarget } from "./collection.ts";
import { refreshRequest, MAX_REFRESH_SOURCE_BYTES, MAX_REFRESH_RUN_MS } from "./refresh-executor.ts";
import { readRefreshScope } from "./refresh-scope.ts";
import { SocialSyncError, timestamp, hash } from "./model.ts";

type Candidate = { key: string; sourceSha256: string; accountId: string; collectionId: string; publicationId: string;
  publishedAt: string; members: { id: string; key: string; publishedAt: string | null }[]; failureCode: string | null };
const unavailable = () => new SocialSyncError("PLAYBACK_PROTOCOL_REQUIRED");

/** Independent post-sync verifier. It cannot publish cards or update statistics. */
async function verifyCollectionPlaybacksCore(sql: SqlExecutor, keys: string[], mode: "trial" | "retained", options: {
  request?: typeof fetch; signal?: AbortSignal; checkScope?: () => Promise<void>;
} = {}, maximumKeys = 20) {
  if (keys.length > maximumKeys || new Set(keys).size !== keys.length || keys.some(k => !/^[a-f0-9]{64}$/.test(k)) || !["trial","retained"].includes(mode)) throw new SocialSyncError("PLAYBACK_SCOPE_INVALID");
  const signal = AbortSignal.any([AbortSignal.timeout(MAX_REFRESH_RUN_MS), ...(options.signal ? [options.signal] : [])]);
  if(signal.aborted)throw new SocialSyncError("CANCELLED");
  await options.checkScope?.();
  const handshake = (await sql.query<{ role: string; login: string; ready: boolean; elevated: boolean }>(`SELECT current_user::text role,session_user::text login,
    to_regprocedure('social_sync.pending_collection_playbacks(jsonb,text)') IS NOT NULL AS ready,
    (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)) AS elevated
    FROM pg_roles WHERE rolname=current_user`)).rows;
  if (handshake.length !== 1 || handshake[0].role !== "nb_social_worker" || handshake[0].login !== "nb_social_worker" || !handshake[0].ready || handshake[0].elevated) throw unavailable();
  const rows: { candidate: Candidate }[] = [];
  for (let offset = 0; offset < keys.length; offset += 20) {
    signal.throwIfAborted(); await options.checkScope?.();
    const chunk = keys.slice(offset, offset + 20);
    const result = (await sql.query<{ candidate: Candidate }>("SELECT social_sync.pending_collection_playbacks($1::jsonb,$2) AS candidate", [JSON.stringify(chunk), mode])).rows;
    if (result.length > chunk.length) throw unavailable();
    rows.push(...result);
    if (rows.length > keys.length || Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) throw unavailable();
  }
  const request = refreshRequest(options.request, { requests: 20, bytes: MAX_REFRESH_SOURCE_BYTES });
  const report: { selected: number; verified: number; failed: number; code: string | null; remaining: number } = { selected: Math.min(rows.length,20), verified: 0, failed: 0, code: null, remaining: rows.length };
  const seen = new Set<string>();
  for (const { candidate: c } of rows) {
    if (!c || !keys.includes(c.key) || seen.has(c.key) || !/^[a-f0-9]{64}$/.test(c.sourceSha256) ||
      !Array.isArray(c.members) || c.members.length > 1000 || !c.members.length) throw unavailable();
    seen.add(c.key); timestamp(c.publishedAt);
  }
  for (const { candidate: c } of rows.slice(0,20)) {
    if (c.failureCode !== null) {
      if (typeof c.failureCode !== "string" || !/^[A-Z][A-Z_]{0,63}$/.test(c.failureCode)) throw unavailable();
      report.failed++; report.code=c.failureCode; break;
    }
    const target = collectionTarget({ platform: "bilibili", kind: "season", accountId: c.accountId, collectionId: c.collectionId,
      representativeUrl: `https://www.bilibili.com/video/${c.publicationId}/` });
    if (collectionKey(target) !== c.key || !c.members.some(m => m.id === c.publicationId && m.publishedAt === c.publishedAt)) throw unavailable();
    try {
      signal.throwIfAborted();
      await options.checkScope?.();
      const { html, observedAt } = await fetchCollectionPage({ platform: "bilibili", accountId: c.accountId, publicationId: c.publicationId,
        workId: `bc_${c.key.slice(0,40)}`, url: target.representativeUrl }, signal, request);
      const snapshot = collectionFromPage(html, target, observedAt);
      const dates = (members: { id: string; publishedAt: string | null }[]) => members.map(m => [m.id,m.publishedAt]).sort((a,b) => String(a[0]).localeCompare(String(b[0])));
      if (JSON.stringify(dates(snapshot.members)) !== JSON.stringify(dates(c.members))) throw new SocialSyncError("PLAYBACK_SOURCE_CHANGED");
      signal.throwIfAborted(); await options.checkScope?.();
      const receipt = (await sql.query<{ accepted: boolean }>("SELECT social_sync.complete_collection_playback($1,$2,$3,$4,$5,$6) AS accepted", [c.key,c.sourceSha256,c.publicationId,mode,observedAt,null])).rows;
      if (receipt.length !== 1 || receipt[0].accepted !== true) throw new SocialSyncError("ACK_MISMATCH");
      report.verified++; report.remaining--;
    } catch (error) {
      report.failed++; report.code = error instanceof SocialSyncError ? error.code : signal.aborted ? "CANCELLED" : "PLAYBACK_FAILED";
      // Store a fixed code only. Failed jobs do not automatically repeat on the next check.
      if (!signal.aborted) {
        try { await options.checkScope?.(); await sql.query("SELECT social_sync.complete_collection_playback($1,$2,$3,$4,$5,$6) AS accepted", [c.key,c.sourceSha256,c.publicationId,mode,null,report.code]); }
        catch { /* A changed/revoked source cannot acquire even a failure receipt. */ }
      }
      break;
    }
  }
  return report;
}

/** Original bounded API remains compatible. */
export async function verifyCollectionPlaybacks(sql: SqlExecutor, keys: string[], mode: "trial" | "retained", options: Parameters<typeof verifyCollectionPlaybacksCore>[3] = {}) {
  const { remaining: _remaining, ...report } = await verifyCollectionPlaybacksCore(sql, keys, mode, options);
  return report;
}

/** Read the approved scope in bounded SQL chunks, but share one 20-GET/2-minute allowance.
 * Verified targets leave the pending set, so the next natural cycle handles the remainder.
 */
export async function verifyCollectionPlaybackScope(sql: SqlExecutor, keys: string[], mode: "trial" | "retained", options: Parameters<typeof verifyCollectionPlaybacksCore>[3] = {}) {
  return verifyCollectionPlaybacksCore(sql, keys, mode, options, 1000);
}

export async function runCollectionPlaybackCli(args: string[]) {
  if(args.length===1 && args[0]==="--help") {
    console.log("node scripts/social-sync/collection-playback.ts run <absolute-private-runtime-root> <trial|retained>");return;
  }
  const [command,root,mode] = args;
  if (command !== "run" || args.length !== 3 || !root || !isAbsolute(root) || resolve(root) !== root || !["trial","retained"].includes(mode)) throw new SocialSyncError("PLAYBACK_USAGE");
  process.umask(0o077); await privateDirectory(root);
  let release: (()=>Promise<void>) | undefined, pool: Pool | undefined;
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
  try {
    release=await acquireLock(root,randomUUID());
    const scope = await readRefreshScope(root,"bilibili"), digest=hash(JSON.stringify(scope)), keys = scope.collections.filter(c=>c.target.kind==="season").map(c=>collectionKey(c.target));
    const checkScope=async()=>{if(hash(JSON.stringify(await readRefreshScope(root,"bilibili")))!==digest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");};
    const raw = await readPrivateFile(join(root,"cloud.env"),65536);
    pool = new Pool(cloudConfig(raw)); pool.on("error",()=>{});
    const client = await pool.connect();
    try {
      const report = await verifyCollectionPlaybackScope(client,keys,mode as "trial"|"retained",{checkScope,signal:controller.signal});
      await writeJson(join(root,"collection-playback-latest.json"),{at:new Date().toISOString(),...report});
      console.log(JSON.stringify(report)); if(report.failed)process.exitCode=1;
    } finally { client.release(true); }
  } finally {
    try { await pool?.end(); } finally {
      try { await release?.(); } finally { process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel); }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCollectionPlaybackCli(process.argv.slice(2)).catch(error=>{
  console.error(JSON.stringify({code:error instanceof SocialSyncError?error.code:"PLAYBACK_FAILED"}));process.exitCode=1;
});
