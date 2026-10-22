import type { SearchContext } from "../../../contracts/website.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import { makeSearchContext } from "../../lib/content/search-context.ts";
import protocol from "../../../database/search-context-protocol.json" with { type: "json" };
import { callSql, type SqlExecutor } from "./sql.ts";

export const SEARCH_CONTEXT_SQL = "SELECT nb_search_context_api.read_context('qualified',$1::text[],$2::uuid,$3::bigint,$4) AS result";

export function readSearchContextMode(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "off") return false;
  if (value === "on") return true;
  throw new ContentServiceError("MISCONFIGURED", "Invalid search context mode.");
}

/** One pinned metadata batch, independent of body search mode; no per-result body fetches. */
export async function readSearchContexts(db: SqlExecutor, ids: string[], pin: { runId: string; revision: string }): Promise<Map<string, SearchContext | null>> {
  const contexts = new Map<string, SearchContext | null>();
  if (!ids.length) return contexts;
  const result = await callSql<{ runId: string; revision: string; schemaDigest: string; contexts: { id: string; context: SearchContext | null }[] }>(db,
    SEARCH_CONTEXT_SQL, [ids, pin.runId, pin.revision, protocol.migration.sha256]);
  const fail = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid search context projection."); };
  if (!result || result.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !Array.isArray(result.contexts) || result.contexts.length > ids.length || Buffer.byteLength(JSON.stringify(result)) > 262144) fail();
  if (result.runId !== pin.runId || result.revision !== pin.revision) throw new ContentServiceError("INVALID_QUERY", "Content changed during search.");
  for (const entry of result.contexts) {
    if (!entry || !ids.includes(entry.id) || contexts.has(entry.id)) fail();
    const value = entry.context;
    if (value !== null && (!value || Object.keys(value).some(key => !["courseLabel", "parentLabels"].includes(key)) || typeof value.courseLabel !== "string" || !Array.isArray(value.parentLabels) || value.parentLabels.some(label => typeof label !== "string"))) fail();
    contexts.set(entry.id, value === null ? null : makeSearchContext(undefined, value.courseLabel, value.parentLabels));
  }
  if (contexts.size !== ids.length) throw new ContentServiceError("INVALID_QUERY", "Content eligibility changed during search.");
  return contexts;
}
