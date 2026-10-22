import {createHash, randomUUID} from "node:crypto";
import {PAYLOAD_TABLES, type DeleteGuard, type PayloadRef, type PayloadTable} from "./plan.ts";
import {MAXIMUM_RETURNED_BYTES,retentionRunLimit} from "./limits.ts";

export const deletionOrder: readonly PayloadTable[] = ["nb_thumbnails.media","nb_v2_media.sources","nb_v2.media","nb_v2.tombstones","nb_v2.records"];
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const hashesDigest = (values: readonly string[]) => sha256([...values].sort().join(""));
export interface Candidate extends Record<string, unknown> {id: string; summary_json: string; summary_sha256: string}
export interface RetentionPlan {
  state: {current_run: string|null;lease_run: string|null;lease_until: string|null};
  stateSHA256: string; publicationSHA256: string; protected: string[]; candidates: Candidate[]; summariesRetained: number;
}
export interface IndexRow extends PayloadRef {bytes: number; runs: string[]}
export interface SchemaArchive {catalogSHA256: string; tables: {name: string; createSQL: string; constraints: string[]; indexes: string[]}[]}
export interface RunArchive {run: Candidate; tables: Record<PayloadTable, IndexRow[]>}
export interface RetentionPort {
  plan(): Promise<RetentionPlan>;
  schema(): Promise<SchemaArchive>;
  index(table: PayloadTable, run: string): Promise<IndexRow[]>;
  payload(table: PayloadTable, refs: PayloadRef[]): Promise<{sha: string; data: string}[]>;
  fingerprint(table: PayloadTable, runs: string[]): Promise<unknown>;
  deleteChunk(table: PayloadTable, guard: DeleteGuard, limit: number, operation: string, archiveSHA: string): Promise<{guardAccepted: boolean; runId: string; deleted: string[]}>;
}
export interface ArchiveStore {
  getBlob(table: PayloadTable, sha: string): Promise<string|null>;
  putBlob(table: PayloadTable, sha: string, data: string): Promise<void>;
  save(name: string, value: unknown): Promise<string>;
}
export interface DailyContext {
  db: RetentionPort; store: ArchiveStore; now(): number;
  /** Must verify the same successful content + thumbnail + visitor + additional-tail receipts.
   * Acquire shared locks before this call; verify their identities before each SQL operation.
   */
  assertWindow(): Promise<void>;
  restore(schema: SchemaArchive, archive: RunArchive, store: ArchiveStore): Promise<void>;
  health(): Promise<void>;
  maximumRuns: number; maximumDeleteCalls?: number; maximumReturnedBytes?: number; maximumPayloadBytes?: number;
}
function requireValue(value: unknown, reason: string): asserts value {if (!value) throw Error(reason);}
const stable = (value: unknown) => JSON.stringify(value);
function validateIndex(table: PayloadTable, run: string, rows: IndexRow[]) {
  const keys=new Set<string>();
  for(const r of rows) {
    const key=stable([r.key,r.width]);
    requireValue(/^[a-f0-9]{64}$/.test(r.sha) && r.sample_run===run && stable(r.runs)===stable([run]) &&
      typeof r.key==="string" && r.key.length<=256 && Number.isSafeInteger(r.bytes) && r.bytes>=2 &&
      (table==="nb_thumbnails.media" ? [400,800,1600].includes(r.width!) : r.width===null) && !keys.has(key),"RETENTION_INDEX_INVALID");
    keys.add(key);
  }
}
function verifyBlob(ref: IndexRow, data: string, table: PayloadTable) {
  requireValue(sha256(data)===ref.sha && Buffer.byteLength(data)===ref.bytes,"RETENTION_ARCHIVE_HASH_MISMATCH");
  // Parsing is used only for identity validation. Restore always uses the original PostgreSQL JSONB text.
  const row=JSON.parse(data), key=table==="nb_thumbnails.media"?"parent_asset_id":table==="nb_v2.records"||table==="nb_v2.tombstones"?"id":"asset_id";
  requireValue(row && !Array.isArray(row) && !("run_id" in row) && row[key]===ref.key &&
    (table!=="nb_thumbnails.media" || (row.version==="v2" && row.width_cap===ref.width)),"RETENTION_ARCHIVE_IDENTITY_MISMATCH");
}
/** A single bounded maintenance operation. No timers, network image reads or automatic retries.
 * An incomplete archive never authorizes deletion. Any unknown SQL result halts the operation;
 * its durable intent and server receipt allow explicit reconciliation without replaying a write.
 */
export async function dailyRetention(context: DailyContext) {
  const maximumRuns=retentionRunLimit(context.maximumRuns);
  const returnedLimit=context.maximumReturnedBytes??MAXIMUM_RETURNED_BYTES;
  if(!Number.isSafeInteger(returnedLimit)||returnedLimit<1||returnedLimit>MAXIMUM_RETURNED_BYTES)throw Error("RETENTION_RESPONSE_BUDGET_INVALID");
  const {db,store}=context, operation=randomUUID(), start=context.now(), stop=start+30*60*1000;
  const metrics={deleteCalls:0,deletedRows:0,returnedBytes:0,payloadBytes:0,newPayloadBytes:0,archivedRuns:0};
  let intent: string|null=null;
  const checkpoint=async()=>{requireValue(context.now()<stop-20_000,"RETENTION_WINDOW_ENDED");await context.assertWindow();};
  const read=async<T>(work:()=>Promise<T>):Promise<T>=>{
    await checkpoint(); const result=await work();metrics.returnedBytes+=Buffer.byteLength(stable(result));
    requireValue(metrics.returnedBytes<=returnedLimit,"RETENTION_RESPONSE_BUDGET");return result;
  };
  try {
    const plan=await read(()=>db.plan());
    requireValue(plan.state.current_run && !plan.state.lease_run && !plan.state.lease_until,"RETENTION_WRITER_BUSY");
    const candidates=plan.candidates.slice(0,maximumRuns);
    const schema=await read(()=>db.schema());
    const before:unknown[]=[];
    for(const table of PAYLOAD_TABLES)before.push(await read(()=>db.fingerprint(table,plan.protected)));
    const archives:RunArchive[]=[];
    let missingPayloadBound=0,deletionResponseBound=0;
    for(const run of candidates) {
      requireValue(typeof run.summary_json==="string" && sha256(run.summary_json)===run.summary_sha256,"RETENTION_SUMMARY_HASH_MISMATCH");
      const tables={} as RunArchive["tables"];
      for(const table of deletionOrder) {
        const rows=await read(()=>db.index(table,run.id)); validateIndex(table,run.id,rows);tables[table]=rows;
        for(const ref of rows){
          metrics.payloadBytes+=ref.bytes;
          requireValue(metrics.payloadBytes<=(context.maximumPayloadBytes??512*1024*1024),"RETENTION_PAYLOAD_BUDGET");
          const data=await store.getBlob(table,ref.sha);
          if(data===null)missingPayloadBound+=6*ref.bytes+128;
          else verifyBlob(ref,data,table);
        }
        // Include complete delete result envelopes and all hash strings, not only row count.
        deletionResponseBound+=rows.length*67+Math.ceil(rows.length/500)*128;
      }
      archives.push({run,tables});
    }
    const finalReadBound=2*Buffer.byteLength(stable(plan))+before.reduce<number>((sum,x)=>sum+Buffer.byteLength(stable(x)),0)+archives.length*PAYLOAD_TABLES.length*2+4096;
    // A deliberately conservative JSON string bound includes escaping and array/envelope costs.
    // Missing blobs are counted even when another candidate may later supply the same hash.
    requireValue(metrics.returnedBytes+missingPayloadBound+deletionResponseBound+finalReadBound<=returnedLimit,"RETENTION_ADMISSION_BUDGET");
    requireValue(Object.values(archives).reduce((n,a)=>n+deletionOrder.reduce((m,t)=>m+Math.ceil(a.tables[t].length/500),0),0)<=(context.maximumDeleteCalls??750),"RETENTION_DELETE_BUDGET");
    for(const archive of archives){
      for(const table of deletionOrder){
        const rows=archive.tables[table];
        for(let offset=0;offset<rows.length;offset+=50) {
          const refs=rows.slice(offset,offset+50),missing:IndexRow[]=[];
          for(const ref of refs) {
            const data=await store.getBlob(table,ref.sha);
            if(data===null)missing.push(ref);else verifyBlob(ref,data,table);
          }
          if(missing.length) {
            const payload=await read(()=>db.payload(table,missing));
            requireValue(payload.length===missing.length && new Set(payload.map(x=>x.sha)).size===missing.length,"RETENTION_PAYLOAD_MISSING");
            for(const ref of missing) {
              const data=payload.find(x=>x.sha===ref.sha)?.data;requireValue(data!==undefined,"RETENTION_PAYLOAD_MISSING");
              verifyBlob(ref,data,table);await store.putBlob(table,ref.sha,data);metrics.newPayloadBytes+=ref.bytes;
              const saved=await store.getBlob(table,ref.sha);requireValue(saved!==null,"RETENTION_ARCHIVE_MISSING");verifyBlob(ref,saved,table);
            }
          }
        }
      }
      await checkpoint();await context.restore(schema,archive,store);metrics.archivedRuns++;
    }
    const archiveSHA=await store.save(`${operation}/archive`,{format:"retention-daily-v1",operation,schema,plan,archives,verifiedRecoverable:true});
    const fresh=await read(()=>db.plan());
    requireValue(metrics.returnedBytes+deletionResponseBound+finalReadBound<=returnedLimit,"RETENTION_ADMISSION_BUDGET");
    requireValue(fresh.stateSHA256===plan.stateSHA256 && fresh.publicationSHA256===plan.publicationSHA256 &&
      stable(fresh.protected)===stable(plan.protected) && fresh.summariesRetained===plan.summariesRetained,"RETENTION_PLAN_CHANGED");
    for(const archive of archives) {
      requireValue(fresh.candidates.some(x=>x.id===archive.run.id&&x.summary_sha256===archive.run.summary_sha256),"RETENTION_CANDIDATE_CHANGED");
      for(const table of deletionOrder) {
        let remaining=archive.tables[table].map(x=>x.sha);
        while(remaining.length) {
          await checkpoint();requireValue(metrics.deleteCalls<(context.maximumDeleteCalls??750),"RETENTION_DELETE_BUDGET");
          const guard:DeleteGuard={run:archive.run.id,stateSHA256:plan.stateSHA256,publicationSHA256:plan.publicationSHA256,
            summarySHA256:archive.run.summary_sha256,remainingPayloadSHA256:hashesDigest(remaining)};
          intent=randomUUID();await store.save(`${operation}/intents/${intent}`,{operation:intent,table,guard,archiveSHA,limit:500});
          metrics.deleteCalls++;
          const result=await db.deleteChunk(table,guard,500,intent,archiveSHA);
          // Save the response before further interpretation, including rejected or unexpected replies.
          await store.save(`${operation}/results/${intent}`,result);
          metrics.returnedBytes+=Buffer.byteLength(stable(result));
          requireValue(result.guardAccepted && result.runId===archive.run.id && result.deleted.length>0 && result.deleted.length<=500,"RETENTION_WRITE_REJECTED");
          const next=[...remaining];
          for(const hash of result.deleted){const i=next.indexOf(hash);requireValue(i>=0,"RETENTION_UNKNOWN_DELETED_HASH");next.splice(i,1);}
          remaining=next;metrics.deletedRows+=result.deleted.length;intent=null;
          requireValue(metrics.returnedBytes<=returnedLimit,"RETENTION_RESPONSE_BUDGET");
        }
      }
    }
    const after=await read(()=>db.plan());
    requireValue(after.stateSHA256===plan.stateSHA256 && after.publicationSHA256===plan.publicationSHA256 &&
      after.summariesRetained===plan.summariesRetained && stable(after.protected)===stable(plan.protected),"RETENTION_FINAL_POINTER_CHANGED");
    for(let i=0;i<PAYLOAD_TABLES.length;i++)requireValue(stable(await read(()=>db.fingerprint(PAYLOAD_TABLES[i],plan.protected)))===stable(before[i]),"RETENTION_PROTECTED_PAYLOAD_CHANGED");
    for(const archive of archives)for(const table of deletionOrder)
      requireValue((await read(()=>db.index(table,archive.run.id))).length===0,"RETENTION_PAYLOAD_REMAINS");
    await checkpoint();await context.health();
    const result={status:"PASS",operation,startedAt:start,finishedAt:context.now(),archiveSHA,...metrics};
    await store.save(`${operation}/completion`,result);return result;
  }catch(error){
    await store.save(`${operation}/stopped`,{status:"STOPPED",operation,finishedAt:context.now(),...metrics,inFlightIntent:intent,
      reason:error instanceof Error?error.message:"RETENTION_FAILED",automaticRetry:false});throw error;
  }
}
