import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { retentionMigrationSQL } from "../../scripts/database-retention/migration.ts";
import { setupCacheCommitFixture } from "./cache-commit-fixture.ts";

/** Real cache and retention installation bodies; no archive/delete operation.
 * The optional source relation is only a synthetic catalog shape for this test. */
export async function setupCacheRolloutFixture(db: SqlExecutor, exec: (sql: string) => Promise<unknown>) {
  const fixture = await setupCacheCommitFixture(db, exec);
  await exec("CREATE SCHEMA nb_v2_media;CREATE TABLE nb_v2_media.sources(id text PRIMARY KEY)");
  await exec(retentionMigrationSQL);
  await exec("UPDATE nb_retention.config SET enabled=true,catalog_sha=nb_retention.catalog_sha()");
  return fixture;
}
