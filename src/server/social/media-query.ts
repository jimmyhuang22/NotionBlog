import type { SqlExecutor } from "../database/sql.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";

export const socialMediaOwnerSql = "SELECT owner_kind,owner_key,files FROM social_sync.cover_bindings WHERE owner_kind=$1 AND owner_key=$2 AND display_mode=$3";
export const socialMediaAssetSql = "SELECT owner_kind,owner_key,files FROM social_sync.cover_bindings WHERE asset_id=$1 AND display_mode=$2";

/** Invoker/RLS reads, including the same identity and protocol checks as the unbatched reader. */
export const socialMediaBatchSql = `WITH wanted AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS r(request_id integer,owner_kind text,owner_key text,asset_id text,display_mode text)
), identity AS MATERIALIZED (
  SELECT current_user AS role,session_user AS login,
    (SELECT version FROM social_sync.reader_meta WHERE singleton) AS reader_version,
    (SELECT version FROM social_sync.collection_meta WHERE singleton) AS collection_version,
    (SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit OR
      EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)
      FROM pg_roles WHERE rolname=current_user) AS elevated
) SELECT i.*,w.request_id,b.owner_kind,b.owner_key,b.files
  FROM wanted w CROSS JOIN identity i LEFT JOIN LATERAL (
    SELECT owner_kind,owner_key,files FROM social_sync.cover_bindings b
      WHERE w.asset_id IS NULL AND b.owner_kind=w.owner_kind AND b.owner_key=w.owner_key AND b.display_mode=w.display_mode
    UNION ALL
    SELECT owner_kind,owner_key,files FROM social_sync.cover_bindings b
      WHERE w.asset_id IS NOT NULL AND b.asset_id=w.asset_id AND b.display_mode=w.display_mode
    OFFSET 0
  ) b ON true`;

interface Selection { owner_kind: string | null; owner_key: string | null; asset_id: string | null; display_mode: string }
interface Binding { owner_kind: string; owner_key: string; files: unknown }
interface BatchRow {
  role: string; login: string; reader_version: number; collection_version: number; elevated: boolean;
  request_id: number; owner_kind: string | null; owner_key: string | null; files: unknown;
}
interface Group { controller: AbortController; items: Waiting[] }
interface Waiting {
  selection: Selection; signal?: AbortSignal; settled: boolean; group?: Group; abort(): void;
  resolve(value: { rows: Binding[] }): void; reject(error: unknown): void;
}
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "Social media is temporarily unavailable.");

function selection(text: string, values?: unknown[]): Selection {
  const mode = values?.at(-1);
  if (mode !== "trial" && mode !== "retained") throw unavailable();
  if (text === socialMediaOwnerSql && values?.length === 3 &&
      ["publication", "collection"].includes(String(values[0])) && typeof values[1] === "string" && /^[a-f0-9]{64}$/.test(values[1])) {
    return { owner_kind: String(values[0]), owner_key: values[1], asset_id: null, display_mode: mode };
  }
  if (text === socialMediaAssetSql && values?.length === 2 && typeof values[0] === "string" && /^s1\.[a-f0-9]{64}$/.test(values[0])) {
    return { owner_kind: null, owner_key: null, asset_id: values[0], display_mode: mode };
  }
  throw unavailable();
}

/**
 * Batch only simultaneous reads, never retain positive eligibility. Each call, including a
 * response's second qualification, joins a new SQL statement under current RLS. One caller's
 * abort must not cancel another caller's qualification or supply its request-local SQL budget.
 */
export function createSocialMediaSql(db: SqlExecutor): SqlExecutor {
  const batchSize = 32, maxWaiting = 128;
  let pending: Waiting[] = [], timer: ReturnType<typeof setTimeout> | undefined, active = false;

  function finish(item: Waiting, result?: { rows: Binding[] }, cause?: unknown) {
    if (item.settled) return;
    item.settled = true;
    item.signal?.removeEventListener("abort", item.abort);
    if (result) item.resolve(result); else item.reject(cause ?? unavailable());
  }
  function schedule() {
    if (active || timer !== undefined || !pending.some(item => !item.settled)) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 2);
  }
  async function flush() {
    pending = pending.filter(item => !item.settled);
    const items = pending.splice(0, batchSize);
    if (!items.length) return;
    active = true;
    const group: Group = { controller: new AbortController(), items };
    for (const item of items) item.group = group;
    const signal = AbortSignal.any([group.controller.signal, AbortSignal.timeout(8_000)]);
    try {
      // Explicitly detach from the first visitor's AsyncLocalStorage scope.
      const result = await withContentReadBudget(signal, () => db.query<BatchRow>(socialMediaBatchSql,
        [JSON.stringify(items.map((item, request_id) => ({ request_id, ...item.selection })))]), { timeoutMs: 8_000 });
      if (result.rows.length !== items.length || Buffer.byteLength(JSON.stringify(result.rows)) > 2 * 1024 * 1024) throw unavailable();
      const rows = new Map<number, Binding[]>();
      for (const row of result.rows) {
        if (row.role !== "nb_social_reader" || row.login !== "nb_social_reader" || row.reader_version !== 1 ||
            row.collection_version !== 1 || row.elevated !== false || !Number.isInteger(row.request_id) ||
            row.request_id < 0 || row.request_id >= items.length || rows.has(row.request_id)) throw unavailable();
        if (row.owner_kind === null && row.owner_key === null && row.files === null) {
          rows.set(row.request_id, []); continue;
        }
        const wanted = items[row.request_id]!.selection;
        if (!["publication", "collection"].includes(row.owner_kind ?? "") || typeof row.owner_key !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.owner_key) || wanted.asset_id === null &&
            (row.owner_kind !== wanted.owner_kind || row.owner_key !== wanted.owner_key)) throw unavailable();
        rows.set(row.request_id, [{ owner_kind: row.owner_kind!, owner_key: row.owner_key, files: row.files }]);
      }
      for (const [index, item] of items.entries()) finish(item, { rows: rows.get(index)! });
    } catch { for (const item of items) finish(item); }
    finally {
      for (const item of items) item.group = undefined;
      active = false; schedule();
    }
  }
  return {
    query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      let wanted: Selection;
      try { wanted = selection(text, values); } catch { return Promise.reject(unavailable()); }
      const signal = contentReadBudgetIdentity()?.signal;
      if (signal?.aborted) return Promise.reject(unavailable());
      pending = pending.filter(item => !item.settled);
      if (pending.length >= maxWaiting) return Promise.reject(unavailable());
      return new Promise<{ rows: Binding[] }>((resolve, reject) => {
        const item: Waiting = { selection: wanted, signal, settled: false, resolve, reject, abort() {
          finish(item);
          if (item.group?.items.every(waiting => waiting.settled)) item.group.controller.abort();
        } };
        signal?.addEventListener("abort", item.abort, { once: true });
        if (signal?.aborted) { item.abort(); return; }
        pending.push(item); schedule();
      }) as Promise<{ rows: T[] }>;
    },
  };
}
