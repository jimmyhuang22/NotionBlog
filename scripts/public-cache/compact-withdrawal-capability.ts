import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { loadCompactWithdrawalProtocol, type CompactWithdrawalProtocol, type CompactWithdrawalFunctionPin } from "./compact-withdrawal-protocol.ts";

/** One snapshot for the new pair and its five direct dependencies. Resolve private
 * objects only through catalog OIDs: the operator gets no private schema USAGE. */
export const COMPACT_WITHDRAWAL_CATALOG_SQL = `WITH expected(signature,nsp,name,args,private_owner) AS (VALUES
 ('nb_cache_api.plan_withdraw_compact(text)','nb_cache_api','plan_withdraw_compact',ARRAY['pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid],false),
 ('nb_cache_api.withdraw_compact(uuid,jsonb)','nb_cache_api','withdraw_compact',ARRAY['pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,'pg_catalog.jsonb'::pg_catalog.regtype::pg_catalog.oid],false),
 ('nb_cache_api.complete_event(uuid,bigint)','nb_cache_api','complete_event',ARRAY['pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,'pg_catalog.int8'::pg_catalog.regtype::pg_catalog.oid],false),
 ('nb_cache_api.read_event(uuid)','nb_cache_api','read_event',ARRAY['pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid],false),
 ('nb_cache_api.read_withdraw(uuid)','nb_cache_api','read_withdraw',ARRAY['pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid],false),
 ('nb_v2.record_eligible(uuid,text)','nb_v2','record_eligible',ARRAY['pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid],true),
 ('nb_v2_api.set_denied(text,boolean)','nb_v2_api','set_denied',ARRAY['pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,'pg_catalog.bool'::pg_catalog.regtype::pg_catalog.oid],true)),
actors(name) AS (SELECT pg_catalog.unnest(ARRAY['anon','authenticated','nb_cache_operator','nb_cache_publisher','nb_reader','nb_social_reader','nb_social_worker','nb_writer','service_role'])),
owners AS (SELECT
 (SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nb_cache' AND c.relname='state' AND c.relkind='r') AS cache,
 (SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nb_v2' AND c.relname='state' AND c.relkind='r') AS website),
named AS (SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='nb_cache_api' AND p.proname IN ('plan_withdraw_compact','withdraw_compact'))
SELECT e.signature,p.oid IS NOT NULL AS present,(SELECT pg_catalog.count(*)::pg_catalog.int4 FROM named) AS "namedCount",
 pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') AS "sourceSha256",l.lanname AS language,p.provolatile::pg_catalog.text AS volatility,
 p.prosecdef AS "securityDefiner",p.proconfig AS "searchPath",p.prokind::pg_catalog.text AS kind,p.proretset AS "returnsSet",
 CASE p.prorettype WHEN 'pg_catalog.jsonb'::pg_catalog.regtype THEN 'jsonb' WHEN 'pg_catalog.bool'::pg_catalog.regtype THEN 'boolean' WHEN 'pg_catalog.void'::pg_catalog.regtype THEN 'void' END AS "returnType",
 p.pronargdefaults AS defaults,p.provariadic::pg_catalog.int4 AS variadic,
 p.proowner=o.cache AND (NOT e.private_owner OR p.proowner=o.website) AS "ownerMatches",
 EXISTS(SELECT FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_namespace n ON n.nspname='nb_cache_api'
   WHERE r.rolname='nb_cache_operator' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE')) AS "operatorSchemaAccess",
 (SELECT pg_catalog.jsonb_object_agg(a.name,COALESCE(pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE'),false))
   FROM actors a LEFT JOIN pg_catalog.pg_roles r ON r.rolname=a.name) AS "roleExecute",
 EXISTS(SELECT FROM actors a JOIN pg_catalog.pg_roles r ON r.rolname=a.name WHERE a.name<>'nb_cache_operator' AND
   (pg_catalog.pg_has_role(r.oid,p.proowner,'MEMBER') OR pg_catalog.pg_has_role(r.oid,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='nb_cache_operator'),'MEMBER'))) AS "forbiddenMembership",
 (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'grantee',CASE WHEN a.grantee=p.proowner THEN '$owner' ELSE COALESCE((SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantee),'PUBLIC') END,
   'grantor',CASE WHEN a.grantor=p.proowner THEN '$owner' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantor) END,
   'privilege',a.privilege_type,'grantable',a.is_grantable)
   ORDER BY (CASE WHEN a.grantee=p.proowner THEN '$owner' ELSE COALESCE((SELECT rolname FROM pg_catalog.pg_roles WHERE oid=a.grantee),'PUBLIC') END) COLLATE "C")
  FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a) AS acl
FROM expected e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=e.nsp
LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=e.name AND p.proargtypes::pg_catalog.text=pg_catalog.array_to_string(e.args,' ')
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang CROSS JOIN owners o ORDER BY e.signature COLLATE "C"`;

export interface CompactWithdrawalCatalogRow {
  signature: string; present: boolean; namedCount: number; sourceSha256: string | null;
  language: string | null; volatility: string | null; securityDefiner: boolean | null; searchPath: string[] | null;
  kind: string | null; returnsSet: boolean | null; returnType: string | null; defaults: number | null; variadic: number | null;
  ownerMatches: boolean | null; operatorSchemaAccess: boolean; roleExecute: unknown; forbiddenMembership: boolean; acl: unknown;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
const pins = (protocol: CompactWithdrawalProtocol) => [...protocol.functions, ...protocol.dependencies]
  .sort((a, b) => a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
export async function readCompactWithdrawalCatalog(db: SqlExecutor, _protocol: CompactWithdrawalProtocol) {
  return (await db.query<CompactWithdrawalCatalogRow>(COMPACT_WITHDRAWAL_CATALOG_SQL)).rows;
}
function matches(row: CompactWithdrawalCatalogRow, fn: CompactWithdrawalFunctionPin) {
  return row.signature === fn.signature && row.present === true && row.sourceSha256 === fn.sourceSha256 &&
    row.language === fn.language && row.volatility === fn.volatility && row.securityDefiner === fn.securityDefiner &&
    canonical(row.searchPath) === canonical(fn.searchPath) && row.ownerMatches === true && row.kind === "f" &&
    row.returnsSet === false && row.returnType === fn.returnType && row.defaults === 0 && row.variadic === 0 &&
    row.operatorSchemaAccess === true && row.forbiddenMembership === false &&
    canonical(row.roleExecute) === canonical(fn.roleExecute) && canonical(row.acl) === canonical(fn.acl);
}
/** New objects may be absent only while all five frozen dependencies match. */
export function compactWithdrawalCatalogState(rows: CompactWithdrawalCatalogRow[], protocol: CompactWithdrawalProtocol): "absent" | "installed" | "mismatch" {
  const expected = pins(protocol);
  if (!Array.isArray(rows) || rows.length !== 7 || rows.some((row, index) => row.signature !== expected[index].signature)) return "mismatch";
  const old = new Set(protocol.dependencies.map(fn => fn.signature)), state = rows[0].namedCount;
  if (![0, 2].includes(state) || rows.some(row => row.namedCount !== state)) return "mismatch";
  if (!rows.every((row, index) => old.has(row.signature) ? matches(row, expected[index]) : state === 0 ? row.present === false : matches(row, expected[index]))) return "mismatch";
  return state === 0 ? "absent" : "installed";
}
/** Client gate only: missing, partial, unknown and unavailable all stop without fallback. */
export async function verifyCompactWithdrawalCapability(db: SqlExecutor): Promise<void> {
  try {
    const protocol = await loadCompactWithdrawalProtocol();
    if (compactWithdrawalCatalogState(await readCompactWithdrawalCatalog(db, protocol), protocol) !== "installed") throw Error();
  } catch { throw Error("COMPACT_WITHDRAWAL_UNAVAILABLE"); }
}
