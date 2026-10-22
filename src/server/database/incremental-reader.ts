import type { WebsiteRecord } from "../../../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import protocol from "../../../database/incremental-reader-protocol.json" with { type: "json" };
import { PublicationDeltaError, verifyIncrementalPublication, type DeltaReceipt } from "./incremental-publication.ts";
import { validateMedia, validateWebsiteRecord } from "./website-validation.ts";
import type { SqlExecutor } from "./sql.ts";

/** PRIVATE worker projection: source evidence and raw stored AST never enter browser DTOs. */
export interface PublishedRecord {
  record: WebsiteRecord; media: StoredMedia[]; publicationRevision: string;
  configDigest: string; schemaDigest: string; readerVerified: true;
}
export interface PublishedRecordQuery { pageId: string; sourceKey: string; expectedRevision: string }
export type VerificationReceipt = Pick<DeltaReceipt, "operationId" | "payloadDigest" | "publicationRevision" | "committed">;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is string => typeof value === "string" && value.split(":").length === 2 && uuid(value.split(":")[0]) && /^[0-9]+$/.test(value.split(":")[1] ?? "");
function fail(code = "DELTA_READER_UNAVAILABLE"): never { throw new PublicationDeltaError(code); }
async function query<T>(db: SqlExecutor, sql: string, values: unknown[]): Promise<T> {
  try {
    const rows = (await db.query<{result: T}>(sql, values)).rows;
    if (rows.length !== 1 || !Object.hasOwn(rows[0], "result")) fail();
    return rows[0].result;
  } catch (error) {
    if (error instanceof PublicationDeltaError) throw error;
    if (error instanceof Error && error.message === "NB_DELTA_VERSION_CHANGED" && (error as {code?: string}).code === "P0001") fail("DELTA_VERSION_CHANGED");
    fail();
  }
}
export async function verifyIncrementalReader(db: SqlExecutor, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted(); await verifyIncrementalPublication(db); signal?.throwIfAborted();
  if (await query(db, "SELECT nb_delta_api.check_reader($1) AS result", [protocol.migration.sha256]) !== true) fail();
  signal?.throwIfAborted();
}
export async function readPublishedRecord(db: SqlExecutor, input: PublishedRecordQuery, signal?: AbortSignal): Promise<PublishedRecord | null> {
  if (!input || typeof input.pageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.pageId) || typeof input.sourceKey !== "string" || !input.sourceKey.length || input.sourceKey.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(input.sourceKey) || !revision(input.expectedRevision)) fail("DELTA_INPUT_INVALID");
  await verifyIncrementalReader(db, signal);
  const value = await query<PublishedRecord | null>(db, "SELECT nb_delta_api.read_page($1,$2,$3) AS result", [input.pageId, input.sourceKey, input.expectedRevision]);
  signal?.throwIfAborted(); if (value === null) return null;
  try {
    if (!value || Object.keys(value).length !== 6 || value.readerVerified !== true || value.publicationRevision !== input.expectedRevision ||
        value.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !hash(value.configDigest) || !Array.isArray(value.media)) throw new Error();
    validateWebsiteRecord(value.record);
    if (value.record.detail.item.id !== input.pageId || value.record.evidence.sourceKey !== input.sourceKey || !value.record.detail.document) throw new Error();
    value.media.forEach(media => { validateMedia(media); if (media.ownerPageId !== input.pageId) throw new Error(); });
  } catch { fail(); }
  return value;
}
/** Confirm database contents/scope using a reader credential, never the writer's receipt alone. */
export async function verifyPublishedDelta(db: SqlExecutor, receipt: VerificationReceipt, signal?: AbortSignal): Promise<boolean> {
  if (!receipt || receipt.committed !== true || !uuid(receipt.operationId) || !hash(receipt.payloadDigest) || !revision(receipt.publicationRevision) ||
      !receipt.publicationRevision.startsWith(`${receipt.operationId}:`)) fail("DELTA_INPUT_INVALID");
  await verifyIncrementalReader(db, signal);
  const value = await query<Record<string, unknown> | null>(db, "SELECT nb_delta_api.verify_operation($1,$2,$3) AS result",
    [receipt.operationId, receipt.payloadDigest, receipt.publicationRevision]);
  signal?.throwIfAborted(); if (value === null) return false;
  if (typeof value !== "object" || Object.keys(value).length !== 5 || value.operationId !== receipt.operationId || value.payloadDigest !== receipt.payloadDigest ||
      value.publicationRevision !== receipt.publicationRevision || value.schemaDigest !== WEBSITE_SCHEMA_DIGEST || value.readerVerified !== true) fail();
  return true;
}
