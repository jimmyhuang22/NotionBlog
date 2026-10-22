import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { createDatabasePool, databasePoolConfig } from "./connection.ts";
import { attachContentReaderPool } from "./reader-pool.ts";

const key = Symbol.for("notionblog.content-reader-pools.v1");
const host = globalThis as typeof globalThis & { [key]?: Map<string, Pool> };

/** Share transport within this process, never repositories, content or eligibility. */
export function sharedContentReaderPool(connectionString: string | undefined, tls?: string, ca?: string): Pool {
  // Validate before lookup and include every effective option: credentials, TLS
  // trust and limits must never inherit a different reader's existing pool.
  const config = databasePoolConfig(connectionString, tls, ca);
  const identity = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const pools = host[key] ??= new Map();
  const previous = pools.get(identity);
  if (previous && !previous.ending && !previous.ended) return previous;

  const pool = createDatabasePool(connectionString, tls, ca);
  try { attachContentReaderPool(pool); }
  catch (error) { void pool.end().catch(() => {}); throw error; }
  pools.set(identity, pool);
  return pool;
}
