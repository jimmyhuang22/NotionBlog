import type { SqlExecutor } from "../../src/server/database/sql.ts";
import type { CoverMode } from "../../src/server/social/covers.ts";
import type { CoverQueue } from "./queue.ts";
import { sourceDigest, validateCoverSource, type CoverSource } from "./sources.ts";
import { SocialSyncError } from "../social-sync/model.ts";

/** Refresh only the exact ACK's unchanged, already registered collection image.
 * A changed URL, missing binding, withdrawal or stale observation matches no row. */
export async function refreshUnchangedCollectionSources(sql: SqlExecutor, sources: CoverSource[], mode: CoverMode): Promise<string[]> {
  if (!["trial", "retained"].includes(mode) || sources.length > 500) throw new SocialSyncError("COVER_BATCH_INVALID");
  const seen = new Set<string>();
  const candidates = sources.map(source => {
    validateCoverSource(source);
    if (source.kind !== "collection" || seen.has(source.key)) throw new SocialSyncError("COVER_BATCH_INVALID");
    seen.add(source.key);
    return { key: source.key, digest: sourceDigest(source), at: source.observedAt };
  }).filter(source => source.digest !== null);
  if (!candidates.length) return [];
  const rows = (await sql.query<{ owner_key: string }>(`WITH candidates AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(key text,digest text,at text)
  ) UPDATE social_sync.cover_sources s SET observed_at=c.at FROM candidates c
    WHERE s.display_mode=$2 AND s.owner_kind='collection' AND s.owner_key=c.key
      AND s.source_sha256=c.digest AND social_sync.cover_collection_time($2,c.key,c.at)
      AND social_sync.cover_owner_visible($2,'collection',c.key)
      AND EXISTS(SELECT 1 FROM social_sync.cover_bindings b WHERE b.display_mode=$2
        AND b.owner_kind='collection' AND b.owner_key=c.key AND b.source_sha256=c.digest)
    RETURNING s.owner_key`, [JSON.stringify(candidates), mode])).rows;
  if (rows.length > candidates.length || new Set(rows.map(row => row.owner_key)).size !== rows.length ||
      rows.some(row => !seen.has(row.owner_key))) throw new SocialSyncError("COVER_ACK_MISMATCH");
  return rows.map(row => row.owner_key);
}

/** Metadata has a separate bound; the twenty-image download/encoding limit stays intact. */
export async function refreshQueuedCollections(queue: CoverQueue, mode: CoverMode,
  refresh: (sources: CoverSource[], mode: CoverMode) => Promise<string[]>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const jobs = queue.pendingCollections(mode).filter(job => queue.current(job));
  const keys = await refresh(jobs.map(job => job.source), mode);
  signal?.throwIfAborted();
  if (new Set(keys).size !== keys.length || keys.some(key => !jobs.some(job => job.source.key === key))) throw new SocialSyncError("COVER_ACK_MISMATCH");
  let refreshed = 0, superseded = 0;
  for (const key of keys) {
    const job = jobs.find(job => job.source.key === key)!;
    queue.attempt(job, new Date().toISOString());
    if (queue.finish(job, "complete")) refreshed++; else superseded++;
  }
  return { selected: jobs.length, refreshed, superseded, unchangedPending: jobs.length - keys.length };
}
