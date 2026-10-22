import { WEBSITE_PROTOCOL, WEBSITE_SCHEMA_DIGEST, type WebsiteWriter } from "../../../contracts/website-sync.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { validateMedia, validateWebsiteRecord } from "./website-validation.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import study from "../../../database/website-study-protocol.json" with { type: "json" };
export function createWebsiteWriter(db: SqlExecutor): WebsiteWriter {
  return {
    async verifyStudy() {
      if (await callSql(db,"SELECT nb_study_api.check_capability($1) AS result",[study.migration.sha256]) !== true)
        throw new ContentServiceError("CONTENT_UNAVAILABLE","The automatic study extension is unavailable.");
    },
    begin: (id,digest,seconds=300) => callSql(db,"SELECT nb_v2_api.begin_run($1,$2,$3,$4,$5) AS result",[id,WEBSITE_PROTOCOL,WEBSITE_SCHEMA_DIGEST,digest,seconds]),
    renew: async (lease,seconds=300) => {await callSql(db,"SELECT nb_v2_api.renew_run($1,$2,$3) AS result",[lease.runId,lease.fence,seconds]);},
    async stage(lease,records,media=[]) {
      records.forEach(validateWebsiteRecord);media.forEach(validateMedia);
      const values=[JSON.stringify(records),JSON.stringify(media),"[]"];
      if(values.reduce((n,s)=>n+Buffer.byteLength(s),0)>16*1024*1024)throw new ContentServiceError("CONTENT_UNAVAILABLE","Batch exceeds supported size.");
      await callSql(db,"SELECT nb_v2_api.stage_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result",[lease.runId,lease.fence,...values]);
    },
    promote: async (lease,r) => {await callSql(db,"SELECT nb_v2_api.promote_run($1,$2,$3,$4,$5,$6) AS result",[lease.runId,lease.fence,r.records,r.media,r.complete,0]);},
    fail: async lease => {await callSql(db,"SELECT nb_v2_api.fail_run($1,$2) AS result",[lease.runId,lease.fence]);},
  };
}
