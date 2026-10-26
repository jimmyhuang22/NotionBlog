import { ContentServiceError } from "../../../contracts/repository.ts";

export const SEARCH_RESULT_TEXT_BYTES = 13 * 1024 * 1024;
export const SEARCH_RESULT_STATEMENTS = 4;
const check = "SELECT nb_read_api.check_capability($1) AND nb_read_api.check_search_parts($2) AND nb_read_api.check_search_walk($3)";
// Exact reviewed scoped search statements after the existing publication rewrite.
const allowed = new Set([
  `${check} AS result`, `${check} AND nb_read_api.check_search_filtered_scope($4) AS result`,
  "SELECT nb_read_api.read_search_parts('qualified',$1::text[]) AS result",
  "SELECT nb_read_api.read_search_filtered_scope('qualified',$1::text[],$2::text[]) AS result",
  "SELECT nb_read_api.read_version('qualified') AS result",
]);
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The search result exceeded its read budget.");
export interface ResultQueryPlan {
  text: string;
  values: unknown[];
  accept<T>(rows: unknown[]): T[];
  fail(): void;
}

/** Request-local SQL result-text limits, not PG/TLS/auth or account billing bytes.
 * The original function still computes its result; existing deadlines are retained. */
export class SearchResultBudget {
  private bytes = 0;
  private statements = 0;
  private failed = false;
  private busy = false;
  readonly maxBytes: number;
  readonly maxStatements: number;
  constructor(maxBytes = SEARCH_RESULT_TEXT_BYTES, maxStatements = SEARCH_RESULT_STATEMENTS) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SEARCH_RESULT_TEXT_BYTES ||
        !Number.isSafeInteger(maxStatements) || maxStatements < 1 || maxStatements > SEARCH_RESULT_STATEMENTS) throw unavailable();
    this.maxBytes = maxBytes;
    this.maxStatements = maxStatements;
  }
  snapshot() { return { resultTextBytes: this.bytes, statements: this.statements, failed: this.failed }; }
  prepare(text: string, values: unknown[] = []): ResultQueryPlan {
    if (this.failed || this.busy || this.statements >= this.maxStatements || !allowed.has(text) || !Array.isArray(values)) {
      this.failed = true; throw unavailable();
    }
    const remaining = this.maxBytes - this.bytes;
    this.statements++; this.busy = true;
    let settled = false;
    const fail = () => { this.failed = true; this.busy = false; settled = true; };
    return {
      // Materialize the original result and its size once in the same statement.
      text: `WITH __nb_eval_raw AS MATERIALIZED (${text}),
        __nb_eval_sized AS MATERIALIZED (
          SELECT result, pg_catalog.octet_length(result::text) AS result_text_bytes FROM __nb_eval_raw)
        SELECT CASE WHEN result_text_bytes <= $${values.length + 1}::integer THEN result ELSE NULL END AS result,
          result_text_bytes AS __nb_result_text_bytes FROM __nb_eval_sized`,
      values: [...values, remaining],
      accept: <T>(rows: unknown[]): T[] => {
        try {
          if (settled || this.failed || !Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" ||
              !Object.hasOwn(rows[0], "result") || !Object.hasOwn(rows[0], "__nb_result_text_bytes")) throw unavailable();
          const row = rows[0] as Record<string, unknown>, size = row.__nb_result_text_bytes;
          if (!(size === null && row.result === null) &&
              (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > remaining)) throw unavailable();
          this.bytes += typeof size === "number" ? size : 0;
          this.busy = false; settled = true;
          return [{ result: row.result }] as T[];
        } catch (error) { fail(); throw error; }
      },
      fail,
    };
  }
}

/** Only opt-in search API requests create a state; empty/off preserves old behavior. */
export function searchResultBudget(env: Record<string, string | undefined> = process.env): SearchResultBudget | undefined {
  const mode = env.DATABASE_SEARCH_RESULT_BUDGET;
  if (!mode || mode === "off") return undefined;
  if (mode !== "bounded-v1" || env.CONTENT_PROVIDER !== "database" || env.DATABASE_CONTENT_VERSION !== "2" ||
      env.DATABASE_READ_PROJECTION !== "scoped" || (env.DATABASE_PUBLICATION_MODE ?? "qualified") !== "qualified" ||
      (env.DATABASE_SEARCH_CONTEXT ?? "off") !== "off" || !["on-demand", "filtered-scope"].includes(env.DATABASE_SEARCH_PROJECTION ?? "on-demand")) {
    throw new ContentServiceError("MISCONFIGURED", "The search result budget is not configured for this read mode.");
  }
  return new SearchResultBudget();
}
