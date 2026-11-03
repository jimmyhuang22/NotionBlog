import type { SqlExecutor } from "./sql.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";

export const thumbnailReadSql = "SELECT nb_thumbnail_api.read_media($1,$2,$3) AS result";
/** Call the existing qualified function as the current invoker; no retained eligibility or new grants. */
export const thumbnailBatchSql = `SELECT r.request_id,
  nb_thumbnail_api.read_media(r.version,r.asset_id,r.width) AS result
  FROM jsonb_to_recordset($1::jsonb)
    AS r(request_id integer,version text,asset_id text,width integer)`;

interface Selection { version: "v1" | "v2"; asset_id: string; width: number }
interface Row { request_id: number; result: unknown }
interface Group { controller: AbortController; items: Waiting[] }
interface Waiting {
  selection: Selection; signal?: AbortSignal; settled: boolean; group?: Group; abort(): void;
  resolve(value: { rows: { result: unknown }[] }): void; reject(error: unknown): void;
}
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The thumbnail index is temporarily unavailable.");

/** Only simultaneous thumbnail reads join a statement. One media statement at a time
 * leaves the other existing pool slot available to catalogue/content reads. A response's
 * recheck always joins a later statement, under current publication and withdrawal rules. */
export function createThumbnailSql(db: SqlExecutor): SqlExecutor {
  let pending: Waiting[] = [], timer: ReturnType<typeof setTimeout> | undefined, active = false;
  function finish(item: Waiting, result?: { rows: { result: unknown }[] }) {
    if (item.settled) return;
    item.settled = true;
    item.signal?.removeEventListener("abort", item.abort);
    if (result) item.resolve(result); else item.reject(unavailable());
  }
  function schedule() {
    if (active || timer !== undefined || !pending.some(item => !item.settled)) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 2);
  }
  async function flush() {
    pending = pending.filter(item => !item.settled);
    const items = pending.splice(0, 32);
    if (!items.length) return;
    active = true;
    const group: Group = { controller: new AbortController(), items };
    for (const item of items) item.group = group;
    try {
      // The first visitor's cancellation and AsyncLocalStorage budget cannot own the batch.
      const signal = AbortSignal.any([group.controller.signal, AbortSignal.timeout(8_000)]);
      const rows = await withContentReadBudget(signal, async () => {
        if (items.length === 1) {
          const { version, asset_id, width } = items[0]!.selection;
          const result = await db.query<{ result: unknown }>(thumbnailReadSql, [version, asset_id, width]);
          return result.rows.map(row => ({ request_id: 0, result: row.result }));
        }
        return (await db.query<Row>(thumbnailBatchSql,
          [JSON.stringify(items.map((item, request_id) => ({ request_id, ...item.selection })))])).rows;
      }, { timeoutMs: 8_000 });
      if (rows.length !== items.length || Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024) throw unavailable();
      const found = new Map<number, unknown>();
      for (const row of rows) {
        if (!Number.isInteger(row.request_id) || row.request_id < 0 || row.request_id >= items.length ||
            found.has(row.request_id) || row.result === undefined) throw unavailable();
        found.set(row.request_id, row.result);
      }
      for (const [index, item] of items.entries()) finish(item, { rows: [{ result: found.get(index) }] });
    } catch { for (const item of items) finish(item); }
    finally {
      for (const item of items) item.group = undefined;
      active = false; schedule();
    }
  }
  return { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    if (text !== thumbnailReadSql || values?.length !== 3 || !["v1", "v2"].includes(String(values[0])) ||
        typeof values[1] !== "string" || !/^a1\.[a-f0-9]{64}$/.test(values[1]) ||
        !(values[0] === "v2" ? [400, 800, 1600] : [400, 800]).includes(Number(values[2])) || typeof values[2] !== "number") {
      return Promise.reject(unavailable());
    }
    const signal = contentReadBudgetIdentity()?.signal;
    if (signal?.aborted) return Promise.reject(unavailable());
    pending = pending.filter(item => !item.settled);
    if (pending.length >= 128) return Promise.reject(unavailable());
    return new Promise<{ rows: { result: unknown }[] }>((resolve, reject) => {
      const item: Waiting = {
        selection: { version: values[0] as Selection["version"], asset_id: values[1] as string, width: values[2] as number },
        signal, settled: false, resolve, reject, abort() {
          finish(item);
          if (item.group?.items.every(waiting => waiting.settled)) item.group.controller.abort();
        },
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      if (signal?.aborted) { item.abort(); return; }
      pending.push(item); schedule();
    }) as Promise<{ rows: T[] }>;
  } };
}
