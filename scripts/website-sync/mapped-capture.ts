import { createHash } from "node:crypto";
import type { WebsitePolicy } from "../../contracts/website-sync.ts";
import { ContentServiceError } from "../../contracts/repository.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

const fail = (): never => { throw new ContentServiceError("MISCONFIGURED", "The saved configuration is not a course-rating removal."); };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const transitions = new WeakSet<object>();
const removable = new Set(["recommendation", "difficulty", "recommendationRating", "difficultyRating"]);

/** A narrow projection transition, never a general configuration override. */
export function courseRatingRemoval(previousText: string, currentText: string) {
  const previous = JSON.parse(previousText), current = JSON.parse(currentText);
  const before = parseWebsiteNotionConfig(previous), after = parseWebsiteNotionConfig(current);
  const reduced = structuredClone(previous);
  let removed = 0;
  for (const source of reduced.sources) {
    if (source.kind !== "course" || source.enabled !== true) continue;
    for (const key of removable) if (Object.hasOwn(source.fields, key)) { delete source.fields[key]; removed++; }
  }
  if (!removed || configDigest(reduced) !== configDigest(current) || configDigest(before) === configDigest(after)) fail();
  const transition = Object.freeze({ format: "course-rating-removal-v1" as const, previousSourceSha256: hash(previousText), currentSourceSha256: hash(currentText),
    previousConfigDigest: configDigest(before), currentConfigDigest: configDigest(after), removedMappings: removed });
  transitions.add(transition); return transition;
}
export type CourseRatingRemoval = ReturnType<typeof courseRatingRemoval>;
export function assertCourseRatingRemoval(value: CourseRatingRemoval): void {
  if (!value || !transitions.has(value)) fail();
}
/** The installation owner supplies one dedicated transaction, never pool.query. */
export interface OwnerPolicyTransaction {
  transaction<T>(work: (db: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Installation-owner operation. Public scope and existing run rows remain
 * byte-for-byte unchanged. Keep the epoch so last-success readers stay usable;
 * advance revision to fence any stale writers. This is not configure_policy. */
export async function applyCourseRatingRemovalPolicy(owner: OwnerPolicyTransaction, previousText: string, currentText: string, policy: WebsitePolicy,
  expected: { revision: string; epoch: string; currentRun: string | null }) {
  const transition = courseRatingRemoval(previousText, currentText);
  if (policy.configDigest !== transition.currentConfigDigest) fail();
  return owner.transaction(async db => {
    const state = (await db.query<{ config_digest: string; revision: string; epoch: string; current_run: string | null; lease_run: string | null; lease_until: string | null; freshness_seconds: number }>(
      "SELECT config_digest,revision::text,epoch::text,current_run::text,lease_run::text,lease_until::text,freshness_seconds FROM nb_v2.state FOR UPDATE")).rows[0];
    if (!state || state.config_digest !== transition.previousConfigDigest || state.lease_run !== null || state.lease_until !== null ||
      state.revision !== expected.revision || state.epoch !== expected.epoch || state.current_run !== expected.currentRun ||
      state.freshness_seconds !== policy.freshnessSeconds) fail();
    const sources = (await db.query("SELECT key,kind,mode,data_source_id AS \"dataSourceId\",database_parent_id AS \"databaseParentId\",page_id AS \"pageId\" FROM nb_v2.sources ORDER BY key")).rows;
    const permits = (await db.query("SELECT id,kind,source_key AS \"sourceKey\",course_id AS \"courseId\",parent_id AS \"parentId\" FROM nb_v2.permits ORDER BY id")).rows;
    if (configDigest(sources) !== configDigest([...policy.sources].sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) ||
      configDigest(permits) !== configDigest([...policy.permits].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) fail();
    await db.query("UPDATE nb_v2.state SET config_digest=$1,revision=revision+1", [transition.currentConfigDigest]);
    return { ...transition, epochUnchanged: true, currentRunUnchanged: true, existingRunRowsUnchanged: true };
  });
}
