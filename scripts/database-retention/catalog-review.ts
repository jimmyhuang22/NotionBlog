import {createHash} from "node:crypto";
import {PAYLOAD_TABLES} from "./plan.ts";

const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
const tables=PAYLOAD_TABLES.map(table=>`'${table}'::regclass`).join(",");

/** Capture only in a separately authorized, bounded READ ONLY transaction. Deliberately
 * does not call assert_enabled (which must reject the changed catalog), update a guard,
 * enable maintenance, or access content rows. SQL ordering is retained in the snapshot. */
export const retentionCatalogInspectionSQL=`WITH lines AS (
 SELECT 'constraint:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) AS line
 FROM pg_catalog.pg_constraint WHERE conrelid=ANY(ARRAY[${tables}]) OR confrelid=ANY(ARRAY[${tables}])
 UNION ALL SELECT 'trigger:'||tgrelid::regclass::text||':'||pg_get_triggerdef(oid)||':'||tgenabled::text||':'||pg_get_functiondef(tgfoid)
 FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(ARRAY[${tables}])
 UNION ALL SELECT 'column:'||attrelid::regclass::text||':'||attnum||':'||attname||':'||atttypid||':'||attnotnull||':'||attisdropped
 FROM pg_catalog.pg_attribute WHERE attnum>0 AND attrelid=ANY(ARRAY[${tables}])
)
SELECT (SELECT catalog_sha FROM nb_retention.config WHERE singleton) AS "storedGuardSHA256",
 nb_retention.catalog_sha() AS "actualCatalogSHA256",
 encode(sha256(convert_to(pg_get_functiondef('nb_retention.catalog_sha()'::regprocedure),'UTF8')),'hex') AS "catalogFunctionSHA256",
 encode(sha256(convert_to(pg_get_functiondef('nb_retention.assert_enabled()'::regprocedure),'UTF8')),'hex') AS "guardFunctionSHA256",
 (SELECT jsonb_agg(line ORDER BY line) FROM lines) AS "catalogLines"`;

export interface CatalogSnapshot {
  storedGuardSHA256:string; actualCatalogSHA256:string;
  catalogFunctionSHA256:string; guardFunctionSHA256:string; catalogLines:string[];
}
export interface CatalogExpectations {
  beforeSHA256:string; afterSHA256:string; approvedObserverLineSHA256:string;
  catalogFunctionSHA256:string; guardFunctionSHA256:string;
}

/** An offline comparison against independently reviewed expectations, never a rebind. */
export function reviewRetentionCatalog(snapshot:CatalogSnapshot,expected:CatalogExpectations){
  const hashes=[snapshot.storedGuardSHA256,snapshot.actualCatalogSHA256,snapshot.catalogFunctionSHA256,snapshot.guardFunctionSHA256,...Object.values(expected)];
  if(hashes.length!==9||hashes.some(value=>typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))||
    !Array.isArray(snapshot.catalogLines)||!snapshot.catalogLines.length||snapshot.catalogLines.length>500||
    snapshot.catalogLines.some(line=>typeof line!=="string")||Buffer.byteLength(JSON.stringify(snapshot.catalogLines))>1024*1024){
    throw Error("RETENTION_CATALOG_INPUT_INVALID");
  }
  if(snapshot.storedGuardSHA256!==expected.beforeSHA256||snapshot.actualCatalogSHA256!==expected.afterSHA256||
    snapshot.catalogFunctionSHA256!==expected.catalogFunctionSHA256||snapshot.guardFunctionSHA256!==expected.guardFunctionSHA256||
    sha256(snapshot.catalogLines.join("|"))!==expected.afterSHA256){
    throw Error("RETENTION_CATALOG_BINDING_MISMATCH");
  }
  const additions=snapshot.catalogLines.filter(line=>sha256(line)===expected.approvedObserverLineSHA256);
  if(additions.length!==1||!additions[0].startsWith("trigger:nb_thumbnails.media:")||
    !additions[0].includes("TRIGGER nb_cache_projection_change ")||
    sha256(snapshot.catalogLines.filter(line=>line!==additions[0]).join("|"))!==expected.beforeSHA256){
    throw Error("RETENTION_CATALOG_DELTA_MISMATCH");
  }
  return {status:"EXACT_REVIEWED_OBSERVER_DELTA",beforeSHA256:expected.beforeSHA256,afterSHA256:expected.afterSHA256,
    addedLines:1,guardChanged:false,databaseWrites:0,maintenanceResumeAuthorized:false} as const;
}
