import assert from "node:assert/strict";
import { Pool } from "pg";
import { hostFixture } from "./incremental-host.ts";
import { installMediaRouteCheckout } from "./media-route-pool.ts";
import { verifyRetentionReadiness } from "../../scripts/database-retention/readiness.ts";
import { READINESS_PATH } from "../../src/server/content-readiness/protocol.ts";

const f = await hostFixture();
try {
  await f.db.exec("REVOKE nb_delta_reader FROM fixture_reader; GRANT nb_reader TO fixture_reader");
  const record = f.artifact.collection.records.find(r => r.detail.item.kind === "status")!;
  assert.ok(record);
  Object.assign(process.env, { DATABASE_READER_ISOLATION: "enforce", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_PUBLICATION_MODE: "published",
    DATABASE_READER_URL: f.options.database.readerUrl, DATABASE_TLS: "verify", DATABASE_READ_PROJECTION: "legacy", DATABASE_SEARCH_PROJECTION: "on-demand",
    MEDIA_PROVIDER: "storage", STORAGE_PROVIDER: "supabase", CONTENT_READINESS_SECRET: "a".repeat(64), SITE_CONFIG_JSON: "{}" });
  delete process.env.SITE_CONFIG;
  globalThis.fetch = async () => { throw Error("No Source or object access is permitted"); };
  const port = f.open({ connectionString: f.options.database.readerUrl });
  let queries = 0, controls = 0;
  Pool.prototype.query = (async (sql: string, values?: unknown[]) => { queries++; return port.query(sql, values); }) as typeof Pool.prototype.query;
  installMediaRouteCheckout(() => { controls++; });
  const { POST } = await import("../../src/app/api/internal/content-readiness/route.ts");
  const target = `https://example.test${READINESS_PATH}`, sample = { id: record.detail.item.id, slug: record.detail.item.slug };
  const transport: typeof fetch = (input, init) => POST(new Request(input, init));
  await verifyRetentionReadiness(target, process.env.CONTENT_READINESS_SECRET, f.artifact.fullRunId, sample, transport);
  const coldQueries = queries;
  const coldControls = controls;
  await verifyRetentionReadiness(target, process.env.CONTENT_READINESS_SECRET, f.artifact.fullRunId, sample, transport);
  assert.ok(coldQueries <= 8); assert.ok(queries - coldQueries <= 8);
  assert.equal(controls, queries * 3); assert.ok(coldQueries + coldControls <= 32); assert.ok(queries - coldQueries + controls - coldControls <= 32);
  assert.equal(f.counts.sourceCalls, 0);
  console.log(JSON.stringify({ passed: true, queries: queries + controls, contentQueries: queries, controls, coldQueries: coldQueries + coldControls, probes: 2 }));
} finally { await f.close(); }
