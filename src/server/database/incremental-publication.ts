import { createHash } from "node:crypto";
import type { StoredMedia } from "../../../contracts/sync.ts";
import type { WebsiteRecord } from "../../../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import protocol from "../../../database/incremental-publication-protocol.json" with { type: "json" };
import { verifyPublication } from "./publication.ts";
import { validateMedia, validateWebsiteRecord } from "./website-validation.ts";
import type { SqlExecutor } from "./sql.ts";

export interface PublicationState { publicationRevision: string; configDigest: string; schemaDigest: string; policyEpoch: string }
export interface ConfirmedWithdrawal { id: string; sourceKey: string; reason: "archived" | "deleted" | "out-of-scope" }
export interface PublicationDelta {
  expectedRevision: string; configDigest: string; upserts: WebsiteRecord[]; media: StoredMedia[]; withdrawals: ConfirmedWithdrawal[];
}
export interface PreparedPublicationDelta extends PublicationDelta { payloadDigest: string }
export interface DeltaReceipt {
  operationId: string; payloadDigest: string; publicationRevision: string;
  upserts: number; withdrawals: number; removedRecords: number; records: number; media: number; committed: true;
}
export class PublicationDeltaError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "PublicationDeltaError"; this.code = code; }
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && uuid(value.split(":")[0]) && /^[0-9]+$/.test(value.split(":")[1] ?? "") && value.split(":").length === 2;
function fail(code = "DELTA_INPUT_INVALID"): never { throw new PublicationDeltaError(code); }
function payload(input: PublicationDelta) {
  return { capability: protocol.capability, expectedRevision: input.expectedRevision, configDigest: input.configDigest,
    upserts: input.upserts, media: input.media, withdrawals: input.withdrawals };
}

/** Only fully prepared changes enter this port. Source discovery and files stay outside SQL. */
export function preparePublicationDelta(input: PublicationDelta): PreparedPublicationDelta {
  if (!input || !version(input.expectedRevision) || !hash(input.configDigest) ||
      ![input.upserts, input.media, input.withdrawals].every(v => Array.isArray(v) && v.length <= 100) ||
      input.upserts.length + input.withdrawals.length === 0) fail();
  const records = new Set<string>(), withdrawn = new Set<string>(), assets = new Set<string>();
  try {
    for (const record of input.upserts) {
      validateWebsiteRecord(record); if (!record.detail.document || records.has(record.detail.item.id)) fail();
      records.add(record.detail.item.id);
    }
    for (const media of input.media) {
      validateMedia(media); if (assets.has(media.assetId)) fail(); assets.add(media.assetId);
    }
    for (const w of input.withdrawals) {
      if (!w || Object.keys(w).length !== 3 || !/^[A-Za-z0-9_-]{1,128}$/.test(w.id) || typeof w.sourceKey !== "string" ||
          !w.sourceKey.length || w.sourceKey.length > 128 || /[\u0000-\u001f\u007f]/.test(w.sourceKey) ||
          !["archived", "deleted", "out-of-scope"].includes(w.reason) || withdrawn.has(w.id) || records.has(w.id)) fail();
      withdrawn.add(w.id);
    }
  } catch { fail(); }
  const value = JSON.stringify(payload(input));
  if (Buffer.byteLength(value) > 16 * 1024 * 1024) fail();
  return { ...structuredClone(input), payloadDigest: createHash("sha256").update(value).digest("hex") };
}

async function call<T>(db: SqlExecutor, sql: string, values: unknown[] = []): Promise<T> {
  try {
    const rows = (await db.query<{ result: T }>(sql, values)).rows;
    if (rows.length !== 1 || !Object.hasOwn(rows[0], "result")) fail("DELTA_UNAVAILABLE");
    return rows[0].result;
  } catch (error) {
    if (error instanceof PublicationDeltaError) throw error;
    // Only PostgreSQL's explicit exception proves rejection. A lost reply can
    // carry the same text after commit and must remain an uncertain result.
    const message = error instanceof Error && (error as {code?: string}).code === "P0001" ? error.message : "";
    const known = ["NB_DELTA_VERSION_CHANGED", "NB_DELTA_POLICY_CHANGED", "NB_DELTA_OPERATION_CONFLICT", "NB_DELTA_WITHDRAWAL_INVALID", "NB_DELTA_INPUT_INVALID", "NB_DELTA_DEPENDENCY_MISSING", "NB_BUSY"];
    const invalid = ["NB_BATCH_TOO_LARGE", "NB_SCOPE_INVALID", "NB_SCOPE_DENIED", "NB_STUDY_SCOPE_INVALID", "NB_STUDY_ANCESTRY_INVALID",
      "NB_MEDIA_INVALID", "NB_MEDIA_OWNER_INVALID", "NB_ABSENCE_INVALID", "NB_INCOMPLETE", "NB_INCOMPLETE_SCOPE", "NB_BODY_MISSING", "NB_MEDIA_MISSING"];
    throw new PublicationDeltaError(known.includes(message) ? message.replace(/^NB_/, "") : invalid.includes(message) ? "DELTA_INPUT_INVALID" : "DELTA_UNAVAILABLE");
  }
}
export async function verifyIncrementalPublication(db: SqlExecutor): Promise<void> {
  await verifyPublication(db);
  if (await call(db, "SELECT nb_delta_api.check_capability($1) AS result", [protocol.migration.sha256]) !== true) fail("DELTA_UNAVAILABLE");
}
function receipt(value: unknown, operationId: string, payloadDigest: string): DeltaReceipt {
  if (!value || typeof value !== "object") fail("DELTA_UNAVAILABLE");
  const r = value as DeltaReceipt;
  if (Object.keys(r).length !== 9 || r.operationId !== operationId || r.payloadDigest !== payloadDigest || !version(r.publicationRevision) || r.committed !== true ||
      ![r.upserts, r.withdrawals, r.removedRecords, r.records, r.media].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 20000)) fail("DELTA_UNAVAILABLE");
  return r;
}
export async function readPublicationState(db: SqlExecutor): Promise<PublicationState> {
  await verifyIncrementalPublication(db);
  const state = await call<PublicationState>(db, "SELECT nb_delta_api.read_state() AS result");
  if (!state || Object.keys(state).length !== 4 || !version(state.publicationRevision) || !hash(state.configDigest) ||
      state.schemaDigest !== WEBSITE_SCHEMA_DIGEST || typeof state.policyEpoch !== "string" || !/^[0-9]+$/.test(state.policyEpoch)) fail("DELTA_UNAVAILABLE");
  return state;
}
/** Worker-only mutation/recovery port; no automatic retry or queue acknowledgement. */
export function createIncrementalPublisher(db: SqlExecutor) {
  return {
    state: () => readPublicationState(db),
    async lookup(operationId: string, payloadDigest: string): Promise<DeltaReceipt | null> {
      if (!uuid(operationId) || !hash(payloadDigest)) fail();
      await verifyIncrementalPublication(db);
      const value = await call<unknown>(db, "SELECT nb_delta_api.read_operation($1,$2) AS result", [operationId, payloadDigest]);
      return value === null ? null : receipt(value, operationId, payloadDigest);
    },
    async publish(operationId: string, prepared: PreparedPublicationDelta): Promise<DeltaReceipt> {
      if (!uuid(operationId)) fail();
      const delta = preparePublicationDelta(prepared);
      if (delta.payloadDigest !== prepared.payloadDigest) fail("DELTA_OPERATION_CONFLICT");
      await verifyIncrementalPublication(db);
      const value = await call<unknown>(db, "SELECT nb_delta_api.apply_delta($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) AS result",
        [operationId, delta.payloadDigest, delta.expectedRevision, delta.configDigest, JSON.stringify(delta.upserts), JSON.stringify(delta.media), JSON.stringify(delta.withdrawals)]);
      return receipt(value, operationId, delta.payloadDigest);
    },
  };
}
