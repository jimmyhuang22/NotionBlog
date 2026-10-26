import { ContentServiceError } from "../../../contracts/repository.ts";
import protocol from "../../../database/scoped-read-protocol.json" with { type: "json" };
import searchProtocol from "../../../database/search-precomputed-protocol.json" with { type: "json" };
import filteredScopeProtocol from "../../../database/search-filtered-scope-protocol.json" with { type: "json" };
import filteredProtocol from "../../../database/search-filtered-protocol.json" with { type: "json" };
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { SEARCH_CONTEXT_SQL } from "./search-context.ts";

export function readProjectionMode(value: string | undefined, searchValue = process.env.DATABASE_SEARCH_PROJECTION): "legacy" | "scoped" {
  const projection = value ?? "legacy";
  if (projection !== "legacy" && projection !== "scoped")
    throw new ContentServiceError("MISCONFIGURED", "Invalid database read projection.");
  readSearchProjectionMode(searchValue, projection);
  return projection;
}

export type SearchProjectionMode = "on-demand" | "precomputed" | "filtered" | "filtered-scope";
export function readSearchProjectionMode(value: string | undefined, projection: "legacy" | "scoped"): SearchProjectionMode {
  if (value === undefined || value === "on-demand") return "on-demand";
  if ((value === "precomputed" || value === "filtered" || value === "filtered-scope") && projection === "scoped") return value;
  throw new ContentServiceError("MISCONFIGURED", "Invalid database search projection; optional search projections require scoped reads.");
}

/** Capability readiness is cached; content, scope and references are never cached. */
export function scopedReader(db: SqlExecutor, mode: PublicationMode,
  searchProjection: SearchProjectionMode = readSearchProjectionMode(process.env.DATABASE_SEARCH_PROJECTION, "scoped")): SqlExecutor {
  if (!["qualified", "published"].includes(mode)) throw new ContentServiceError("MISCONFIGURED", "Invalid publication mode.");
  if (!["on-demand", "precomputed", "filtered", "filtered-scope"].includes(searchProjection)) throw new ContentServiceError("MISCONFIGURED", "Invalid search projection.");
  let ready: Promise<void> | undefined;
  let searchReady: Promise<void> | undefined;
  const check = async (search: boolean) => {
    const precomputed = search && searchProjection === "precomputed";
    const filtered = search && searchProjection === "filtered";
    const filteredScope = search && searchProjection === "filtered-scope";
    if (await callSql(db, "SELECT nb_read_api.check_capability($1) AND nb_read_api.check_search_parts($2) AND nb_read_api.check_search_walk($3)" +
      (precomputed ? " AND nb_read_api.check_search_precomputed($4,$5)" : filtered ? " AND nb_read_api.check_search_filtered($4)" : filteredScope ? " AND nb_read_api.check_search_filtered_scope($4)" : "") + " AS result",
      [protocol.migration.sha256, protocol.searchMigration.sha256, protocol.traversalMigration.sha256,
        ...(precomputed ? [searchProtocol.migration.sha256, searchProtocol.algorithm] : filtered ? [filteredProtocol.migration.sha256] : filteredScope ? [filteredScopeProtocol.migration.sha256] : [])]) !== true)
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "The scoped reader extension is incompatible.");
  };
  return { async query<T>(text: string, values?: unknown[]) {
    if (text === SEARCH_CONTEXT_SQL) {
      await (ready ??= check(false).catch(error => { ready = undefined; throw error; }));
      return db.query<T>(text.replace("'qualified'", `'${mode}'`), values);
    }
    if (text.includes("nb_read_api.read_search_filtered(") && searchProjection !== "filtered")
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "Filtered search requires its reviewed capability.");
    if (text.includes("nb_read_api.read_search_filtered_scope(") && searchProjection !== "filtered-scope")
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "Filtered scope search requires its reviewed capability.");
    let rewritten = text.replace(/\bnb_v2_api\.(read_content|read_snapshot)\(/g, `nb_read_api.$1('${mode}',`)
      .replace(/\bnb_read_api\.read_version\(\)/g, `nb_read_api.read_version('${mode}')`)
      .replace(/\bnb_read_api\.(read_selected|read_search_parts|read_search_filtered|read_search_filtered_scope|read_index|read_status_index)\(/g, (_match, name: string) =>
        `nb_read_api.${name === "read_index" ? "read_snapshot" : name === "read_status_index" ? "read_content" : name}('${mode}',`);
    if (rewritten === text) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Unsupported scoped read.");
    if (searchProjection === "precomputed") rewritten = rewritten.replace(/\bnb_read_api\.read_search_parts\(/g, "nb_read_api.read_search_precomputed(");
    const optionalSearch = /\bnb_read_api\.read_search_(filtered_scope|filtered|precomputed)\(/.test(rewritten);
    if (optionalSearch) {
      // Combine base and optional checks on a cold search: still one round trip.
      // Do not share this pending promise with ordinary reads: a missing/slow
      // optional extension must not block a course, home or catalogue request.
      await (searchReady ??= check(true).then(() => { ready ??= Promise.resolve(); })
        .catch(error => { searchReady = undefined; throw error; }));
    } else {
      await (ready ??= check(false).catch(error => { ready = undefined; throw error; }));
    }
    return db.query<T>(rewritten, values);
  } };
}

export const SCOPED_SELECTED_SQL = "SELECT nb_read_api.read_selected($1,$2::text[],$3::uuid,$4::bigint) AS result";
export const SCOPED_SEARCH_SQL = "SELECT nb_read_api.read_search_parts($1::text[]) AS result";
export const SCOPED_FILTERED_SCOPE_SEARCH_SQL = "SELECT nb_read_api.read_search_filtered_scope($1::text[],$2::text[]) AS result";
export const SCOPED_FILTERED_SEARCH_SQL = "SELECT nb_read_api.read_search_filtered($1::text[],$2::text[]) AS result";
export const SCOPED_VERSION_SQL = "SELECT nb_read_api.read_version() AS result";
export const SCOPED_INDEX_SQL = "SELECT nb_read_api.read_index($1::text[],false,true) AS result";
export const SCOPED_STATUS_INDEX_SQL = "SELECT nb_read_api.read_status_index($1,$3,NULL,'{}'::jsonb,$6,$7,$4::uuid,$5::bigint,$2,true) AS result";
