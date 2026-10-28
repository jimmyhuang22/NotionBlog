import { createHash } from "node:crypto";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { WebsitePolicy } from "../../contracts/website-sync.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";

function fail(): never { throw new ContentServiceError("MISCONFIGURED", "Invalid movie rating policy transition."); }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
};
const reviewed = new WeakMap<object, WebsitePolicy["sources"]>();

/** Only one existing movie source gains both mappings. No source, scope or
 * other raw configuration value (including ignored values) may change. */
export function movieRatingMappingAddition(previousText: string, currentText: string, sourceKey: string) {
  let previous: Record<string, unknown>, current: Record<string, unknown>;
  try { previous = object(JSON.parse(previousText)); current = object(JSON.parse(currentText)); } catch { return fail(); }
  const before = parseWebsiteNotionConfig(previous), after = parseWebsiteNotionConfig(current);
  const original = before.sources.find(source => source.key === sourceKey);
  if (!original || original.kind !== "movie" || !original.fields.doubanRating ||
      Object.hasOwn(original.fields, "publicRating") || Object.hasOwn(original.fields, "ratingSource")) fail();
  const reduced = structuredClone(current);
  const sources = (reduced.sources as unknown[]).map(object);
  const targets = sources.filter(source => source.key === sourceKey);
  if (targets.length !== 1 || targets[0].enabled !== true || targets[0].kind !== "movie") fail();
  const fields = object(targets[0].fields);
  if (!Object.hasOwn(fields, "publicRating") || !Object.hasOwn(fields, "ratingSource") ||
      fields.publicRating !== original.fields.doubanRating || typeof fields.ratingSource !== "string" ||
      fields.ratingSource === fields.publicRating) fail();
  delete fields.publicRating; delete fields.ratingSource;
  if (configDigest(reduced) !== configDigest(previous) || configDigest(before) === configDigest(after)) fail();
  const transition = Object.freeze({ format: "movie-rating-mapping-addition-v1" as const, sourceKey,
    previousSourceSha256: hash(previousText), currentSourceSha256: hash(currentText),
    previousConfigDigest: configDigest(before), currentConfigDigest: configDigest(after) });
  // Match the ordinary worker's static source policy without any source reads.
  reviewed.set(transition, after.sources.map(source => ({ key: source.key, kind: source.kind, mode: source.publication.mode,
    dataSourceId: source.dataSourceId, databaseParentId: source.kind === "study-note" ? source.coursePageId : null, pageId: source.pageId })));
  return transition;
}
export type MovieRatingMappingAddition = ReturnType<typeof movieRatingMappingAddition>;

/** The owner supplies a dedicated connection and BEGIN/COMMIT/ROLLBACK. Never
 * wrap pool.query as a transaction. A transaction-ID fence also rejects an
 * accidentally autocommitting adapter before any policy update. */
export interface MovieRatingPolicyOwner {
  transaction<T>(work: (db: SqlExecutor) => Promise<T>): Promise<T>;
}
export interface MovieRatingPolicyState { revision: string; epoch: string; currentRun: string | null }

const orderedSources = (rows: WebsitePolicy["sources"]) => [...rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const orderedPermits = (rows: WebsitePolicy["permits"]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function changePolicy(owner: MovieRatingPolicyOwner, transition: MovieRatingMappingAddition,
  targetPolicy: WebsitePolicy, expectedState: MovieRatingPolicyState, direction: "apply" | "rollback") {
  const sources = reviewed.get(transition);
  if (!sources || !owner || typeof owner.transaction !== "function") fail();
  // Copy caller-owned objects before the first await; later mutation cannot
  // alter what was checked or returned as the successful operation.
  const policy = structuredClone(targetPolicy), expected = { ...expectedState };
  const from = direction === "apply" ? transition.previousConfigDigest : transition.currentConfigDigest;
  const to = direction === "apply" ? transition.currentConfigDigest : transition.previousConfigDigest;
  if (policy.configDigest !== to || !Number.isInteger(policy.freshnessSeconds) || policy.freshnessSeconds < 1 || policy.freshnessSeconds > 86400 ||
      !/^(0|[1-9][0-9]*)$/.test(expected.revision) || !/^(0|[1-9][0-9]*)$/.test(expected.epoch) ||
      configDigest(orderedSources(policy.sources)) !== configDigest(orderedSources(sources))) fail();
  try {
    return await owner.transaction(async db => {
      const stateRows = (await db.query<{
        config_digest: string; revision: string; epoch: string; current_run: string | null;
        lease_run: string | null; lease_until: string | null; freshness_seconds: number; transaction_id: string;
      }>("SELECT config_digest,revision::text,epoch::text,current_run::text,lease_run::text,lease_until::text,freshness_seconds,pg_catalog.pg_current_xact_id()::text AS transaction_id FROM nb_v2.state FOR UPDATE")).rows;
      const state = stateRows[0];
      if (stateRows.length !== 1 || state.config_digest !== from || state.revision !== expected.revision || state.epoch !== expected.epoch ||
          state.current_run !== expected.currentRun || state.lease_run !== null || state.lease_until !== null ||
          state.freshness_seconds !== policy.freshnessSeconds) fail();
      // Published readers require run.config_digest === state.config_digest.
      // Preserving epoch alone cannot keep an adopted publication readable.
      // This no-migration candidate must refuse either direction in that case.
      const publication = (await db.query<{ relation: string | null }>(
        "SELECT pg_catalog.to_regclass('nb_publication.state')::text AS relation")).rows[0];
      if (!publication) fail();
      if (publication.relation !== null) {
        const pointers = (await db.query<{ run_id: string | null }>(
          "SELECT run_id::text FROM nb_publication.state WHERE singleton FOR UPDATE")).rows;
        if (pointers.length !== 1 || pointers[0].run_id !== null) fail();
      }
      const installedSources = (await db.query<WebsitePolicy["sources"][number]>(
        "SELECT key,kind,mode,data_source_id AS \"dataSourceId\",database_parent_id AS \"databaseParentId\",page_id AS \"pageId\" FROM nb_v2.sources")).rows;
      const installedPermits = (await db.query<WebsitePolicy["permits"][number]>(
        "SELECT id,kind,source_key AS \"sourceKey\",course_id AS \"courseId\",parent_id AS \"parentId\" FROM nb_v2.permits")).rows;
      if (configDigest(orderedSources(installedSources)) !== configDigest(orderedSources(policy.sources)) ||
          configDigest(orderedPermits(installedPermits)) !== configDigest(orderedPermits(policy.permits))) fail();
      const changed = (await db.query<{ revision: string }>(
        "UPDATE nb_v2.state SET config_digest=$1,revision=revision+1 WHERE config_digest=$2 AND revision=$3::bigint AND epoch=$4::bigint AND current_run IS NOT DISTINCT FROM $5::uuid AND lease_run IS NULL AND lease_until IS NULL AND pg_catalog.pg_current_xact_id()::text=$6 RETURNING revision::text",
        [to, from, expected.revision, expected.epoch, expected.currentRun, state.transaction_id])).rows;
      if (changed.length !== 1 || changed[0].revision !== String(BigInt(expected.revision) + 1n)) fail();
      return Object.freeze({ ...transition, direction, configDigest: to, revision: changed[0].revision,
        epoch: state.epoch, currentRun: state.current_run, requiresFullCollection: true as const });
    });
  } catch (error) {
    if (error instanceof ContentServiceError) throw error;
    // Driver messages may contain source IDs or query values. Unknown commit
    // outcomes require owner reconciliation, never an automatic retry.
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "The movie rating policy transaction could not be confirmed.");
  }
}

/** Explicit engineering operation; not imported by the worker, CLI or app. */
export function applyMovieRatingMappingPolicy(owner: MovieRatingPolicyOwner, transition: MovieRatingMappingAddition,
  targetPolicy: WebsitePolicy, expectedState: MovieRatingPolicyState) {
  return changePolicy(owner, transition, targetPolicy, expectedState, "apply");
}

/** Only the exact inverse of a verified addition. Advances revision again;
 * never reinstates an old lease or rewrites a successful or failed run. */
export function rollbackMovieRatingMappingPolicy(owner: MovieRatingPolicyOwner, transition: MovieRatingMappingAddition,
  targetPolicy: WebsitePolicy, expectedState: MovieRatingPolicyState) {
  return changePolicy(owner, transition, targetPolicy, expectedState, "rollback");
}
