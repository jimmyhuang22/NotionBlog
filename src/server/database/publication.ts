import { ContentServiceError } from "../../../contracts/repository.ts";
import type { WebsiteWriter } from "../../../contracts/website-sync.ts";
import protocol from "../../../database/publication-protocol.json" with { type: "json" };
import { callSql, type SqlExecutor } from "./sql.ts";
import { createWebsiteWriter } from "./website-writer.ts";
import { SEARCH_CONTEXT_SQL } from "./search-context.ts";

export type PublicationMode = "qualified" | "published";

export function publicationMode(value: string | undefined): PublicationMode {
  if (value === undefined || value === "qualified") return "qualified";
  if (value === "published") return "published";
  throw new ContentServiceError("MISCONFIGURED", "Unsupported publication mode.");
}

export async function verifyPublication(db: SqlExecutor): Promise<void> {
  if (await callSql<boolean>(db, "SELECT nb_publication_api.check_capability($1) AS result", [protocol.migration.sha256]) !== true) {
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "The publication extension is incompatible.");
  }
}

/** Rewrite only fixed server reader functions. Values and public DTOs stay unchanged. */
export function publicationReader(db: SqlExecutor, mode: PublicationMode): SqlExecutor {
  if (mode === "qualified") return db;
  let ready: Promise<void> | undefined;
  return { async query<T>(text: string, values?: unknown[]) {
    if (text === SEARCH_CONTEXT_SQL) {
      await (ready ??= verifyPublication(db).catch(error => { ready = undefined; throw error; }));
      return db.query<T>(text.replace("'qualified'", "'published'"), values);
    }
    const query = text.replace(/\bnb_v2_api\.(read_content|read_snapshot|read_media)\b/g, "nb_publication_api.$1");
    if (query === text) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Unsupported publication read.");
    await (ready ??= verifyPublication(db).catch(error => { ready = undefined; throw error; }));
    return db.query<T>(query, values);
  } };
}

/** Activation is explicit and happens only after the existing complete publication succeeds. */
export function publicationWriter(db: SqlExecutor, mode: PublicationMode): WebsiteWriter {
  const writer = createWebsiteWriter(db);
  if (mode === "qualified") return writer;
  return { ...writer,
    async begin(...args) { await verifyPublication(db); return writer.begin(...args); },
    async promote(lease, receipt) {
      await callSql(db, "SELECT nb_publication_api.promote_run($1,$2,$3,$4,$5,$6) AS result",
        [lease.runId, lease.fence, receipt.records, receipt.media, receipt.complete, 0]);
    },
  };
}
