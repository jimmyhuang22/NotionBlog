import { SYNC_PROTOCOL, SYNC_SCHEMA_DIGEST, type RunLease, type SyncWriter } from "../../../contracts/sync.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { validateMedia, validateSyncRecord } from "./validation.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";

/** CLI-safe: no server-only, environment reads, Notion SDK or cloud-specific client. */
export function createDatabaseWriter(db: SqlExecutor): SyncWriter {
  return {
    begin: (runId, digest, seconds=300) => callSql<RunLease>(db,
      "SELECT nb_api.begin_run($1,$2,$3,$4,$5) AS result",[runId,SYNC_PROTOCOL,SYNC_SCHEMA_DIGEST,digest,seconds]),
    async renew(lease,seconds=300) {
      await callSql(db,"SELECT nb_api.renew_run($1,$2,$3) AS result",[lease.runId,lease.fence,seconds]);
    },
    async stage(lease,records,media=[],absences=[]) {
      records.forEach(validateSyncRecord); media.forEach(validateMedia);
      const batch=[JSON.stringify(records),JSON.stringify(media),JSON.stringify(absences)];
      if(batch.reduce((n,s)=>n+Buffer.byteLength(s),0)>16*1024*1024)throw new ContentServiceError("CONTENT_UNAVAILABLE","Synchronization batch exceeds the supported size.");
      await callSql(db,"SELECT nb_api.stage_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result",
        [lease.runId,lease.fence,...batch]);
    },
    async promote(lease,receipt) {
      await callSql(db,"SELECT nb_api.promote_run($1,$2,$3,$4,$5,$6) AS result",
        [lease.runId,lease.fence,receipt.records,receipt.media,receipt.complete,receipt.confirmedAbsent??0]);
    },
    async fail(lease) {
      await callSql(db,"SELECT nb_api.fail_run($1,$2) AS result",[lease.runId,lease.fence]);
    },
  };
}
