import { SYNC_PROTOCOL,SYNC_SCHEMA_DIGEST } from "../../../contracts/sync.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "./sql.ts";

const tables=["state","sources","permits","denied","runs","records","media","tombstones"] as const;
export interface DatabaseArchive {
  protocol: string;
  schemaDigest: string;
  /** Contains PRIVATE policy, source identities and content. Save only to ignored storage. */
  tables: Record<(typeof tables)[number],Record<string,unknown>[]>;
}
function compatibleState(value: unknown): value is Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const state=value as Record<string,unknown>;
  return state.singleton===true&&state.protocol===SYNC_PROTOCOL&&state.schema_digest===SYNC_SCHEMA_DIGEST;
}
function validateArchive(archive: DatabaseArchive): void {
  if(!archive||archive.protocol!==SYNC_PROTOCOL||archive.schemaDigest!==SYNC_SCHEMA_DIGEST||!archive.tables||
      Object.keys(archive.tables).length!==tables.length||!tables.every(t=>Array.isArray(archive.tables[t])&&
        archive.tables[t].every(row=>!!row&&typeof row==="object"&&!Array.isArray(row)))||
      archive.tables.state.length!==1||!compatibleState(archive.tables.state[0])) {
    throw new ContentServiceError("CONTENT_UNAVAILABLE","Incompatible database archive.");
  }
}
export async function exportDatabaseArchive(db: SqlExecutor): Promise<DatabaseArchive> {
  // One SQL statement supplies a consistent MVCC snapshot; identifiers are fixed constants.
  const sql=`SELECT jsonb_build_object(${tables.map(t=>`'${t}',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb.${t} x)`).join(",")}) AS data`;
  const {rows}=await db.query<{data:DatabaseArchive["tables"]}>(sql);
  const archive={protocol:SYNC_PROTOCOL,schemaDigest:SYNC_SCHEMA_DIGEST,tables:rows[0]?.data};
  validateArchive(archive);
  return archive;
}
/** Dedicated transaction connection required; restores into an EMPTY migrated database only. */
export async function restoreDatabaseArchive(db: SqlExecutor,archive: DatabaseArchive): Promise<void> {
  validateArchive(archive);
  await db.query("BEGIN");
  try {
    // Keep the emptiness check valid until COMMIT, including direct operator writes.
    await db.query(`LOCK TABLE ${tables.map(t=>`nb.${t}`).join(",")} IN EXCLUSIVE MODE`);
    const target=await db.query<Record<string,unknown>>("SELECT * FROM nb.state FOR UPDATE");
    if(target.rows.length!==1||!compatibleState(target.rows[0]))throw new ContentServiceError("CONTENT_UNAVAILABLE","Restore requires a compatible migrated database.");
    const {rows}=await db.query<{empty:boolean}>(`SELECT ${tables.filter(t=>t!=="state").map(t=>`NOT EXISTS(SELECT FROM nb.${t})`).join(" AND ")} AS empty`);
    if(!rows[0].empty)throw new ContentServiceError("CONTENT_UNAVAILABLE","Restore requires an empty database.");
    await db.query("DELETE FROM nb.state");
    for(const table of tables)await db.query(`INSERT INTO nb.${table} SELECT * FROM jsonb_populate_recordset(NULL::nb.${table},$1::jsonb)`,[JSON.stringify(archive.tables[table])]);
    await db.query("UPDATE nb.state SET current_run=NULL,lease_run=NULL,lease_until=NULL,revision=revision+1,epoch=epoch+1,fence=fence+1");
    await db.query("UPDATE nb.runs SET valid_until=statement_timestamp()-interval '1 second',status=CASE WHEN status='staging' THEN 'failed' ELSE status END");
    await db.query("COMMIT");
  } catch(cause){try { await db.query("ROLLBACK"); } catch { /* Preserve the restore failure; the caller must discard this connection. */ }throw cause;}
}
/** Export object bytes separately through ObjectStorage.read; SQL does not contain them. */
export function archivedObjects(archive: DatabaseArchive): StoredMedia[] {
  return [...new Map(archive.tables.media.map(m=>{const d=m.descriptor as unknown as StoredMedia;return [d.objectKey,d] as const;})).values()];
}
