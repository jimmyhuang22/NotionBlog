import { Pool, type PoolConfig } from "pg";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "./sql.ts";
import { contentReadTimingActive, measureContentRead, measureContentReadAsync, recordContentPoolState } from "../content-read-timing.ts";
import { contentReadBudgetIdentity } from "../content-read-budget.ts";
import { requestPoolQuery } from "./request-query.ts";

/** Explicit TLS; connection strings cannot silently override certificate verification. */
export function databasePoolConfig(connectionString: string|undefined, tls: string|undefined, ca?: string): PoolConfig {
  try {
    if(!connectionString)throw new Error();
    const url=new URL(connectionString);
    if(!["postgres:","postgresql:"].includes(url.protocol)||!url.username||!url.password||url.search||url.hash)throw new Error();
    const local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if(tls==="disable"&&!local)throw new Error();
    if(tls!==undefined&&!["verify","disable"].includes(tls))throw new Error();
    return {connectionString,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,
      statement_timeout:15000,query_timeout:20000,application_name:"notionblog",
      ssl:tls==="disable"?false:{rejectUnauthorized:true,...(ca?{ca}:{} )}};
  } catch { throw new ContentServiceError("MISCONFIGURED","The server-side database connection is not configured."); }
}
export function createDatabasePool(connectionString: string|undefined,tls?: string,ca?: string): Pool {
  const pool=measureContentRead("database-pool", () => new Pool(databasePoolConfig(connectionString,tls,ca)));
  // Idle connection errors must not become unhandled events or expose connection details.
  pool.on("error",()=>{});
  return pool;
}
export function sqlExecutor(pool: Pool): SqlExecutor {
  return {query:async <T>(text: string,values?: unknown[]) => {
    const budget = contentReadBudgetIdentity();
    if (budget) {
      recordContentPoolState({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
      return requestPoolQuery<T>(pool, budget, text, values);
    }
    if (contentReadTimingActive()) {
      recordContentPoolState({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
      const client = await measureContentReadAsync("database-acquire", () => pool.connect());
      let failed: Error | boolean | undefined;
      const onError = () => {}; // Active-client transport errors must not become unhandled events.
      client.on("error", onError);
      try {
        const result = await measureContentReadAsync("database-roundtrip", () => client.query(text, values));
        return { rows: result.rows as T[] };
      } catch (error) { failed = error instanceof Error ? error : true; throw error; }
      finally { client.release(failed); client.removeListener("error", onError); }
    }
    const result=await pool.query(text,values); return {rows:result.rows as T[]};
  }};
}
