import type { SqlExecutor } from "./sql.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import type { PreparedPublicationDelta, DeltaReceipt } from "./incremental-publication.ts";
import { preparePublicationDelta } from "./incremental-publication.ts";
import protocol from "../../../database/freeze-protocol.json" with { type: "json" };
import { validateMedia } from "./website-validation.ts";

export class FreezeError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "FreezeError"; }
}
export interface FrozenMember { id: string; sourceKey: string; groupId: string; rootId: string; frozenAt: string }
export interface FreezeState { enabled: boolean; generation: string; configDigest: string; publicationRevision: string; publishedAt: string | null; members: FrozenMember[] }
export interface FreezePlan {
  action: "freeze" | "permanent" | "once"; rootId: string; groupId: string | null; digest: string;
  generation: string; publicationRevision: string; pages: number; images: number; missingImages: number;
  title: string; href: string; kind: string; media: StoredMedia[]; thumbnailIds: string[]; members: {id: string; sourceKey: string; title: string}[];
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(v);
const uuid = (v: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const version = (v: string) => typeof v === "string" && v.split(":").length === 2 && uuid(v.split(":")[0]) && /^[0-9]+$/.test(v.split(":")[1]);
export async function freezeQuery<T>(db: SqlExecutor, sql: string, values: unknown[] = []): Promise<T> {
  try {
    const rows = (await db.query<{ result: T }>(sql, values)).rows;
    if (rows.length !== 1 || !Object.hasOwn(rows[0], "result")) throw new FreezeError("FREEZE_UNAVAILABLE");
    return rows[0].result;
  } catch (e) {
    if (e instanceof FreezeError) throw e;
    if ((e as { code?: string })?.code === "P0001" && e instanceof Error && /^NB_(FREEZE_[A-Z_]+|BUSY)$/.test(e.message)) {
      throw new FreezeError(e.message.slice(3));
    }
    // Includes a malformed/lost post-write reply. The caller must query the operation, never replay it.
    throw new FreezeError("FREEZE_UNAVAILABLE");
  }
}
export async function verifyFreeze(db: SqlExecutor): Promise<void> {
  if (await freezeQuery(db, "SELECT nb_freeze_api.check_capability($1) AS result", [protocol.migration.sha256]) !== true) throw new FreezeError("FREEZE_UNAVAILABLE");
}
export function createFreezeStore(db: SqlExecutor) {
  return {
    async state(): Promise<FreezeState> {
      await verifyFreeze(db);
      const result = await freezeQuery<FreezeState>(db, "SELECT nb_freeze_api.read_state() AS result");
      if (!result || typeof result.enabled !== "boolean" || !/^[0-9]+$/.test(result.generation) ||
          !hash(result.configDigest) || !version(result.publicationRevision) || result.publishedAt !== null && !Number.isFinite(Date.parse(result.publishedAt)) || !Array.isArray(result.members) || result.members.length > 20000 ||
          result.members.some(m => !id(m.id) || !id(m.sourceKey) || !uuid(m.groupId) || !id(m.rootId) || !Number.isFinite(Date.parse(m.frozenAt)))) throw new FreezeError("FREEZE_UNAVAILABLE");
      return result;
    },
    async preview(target: string, action: FreezePlan["action"]): Promise<FreezePlan> {
      if (typeof target !== "string" || !target || target.length > 2000 || !["freeze", "permanent", "once"].includes(action)) throw new FreezeError("FREEZE_INPUT_INVALID");
      await verifyFreeze(db);
      const plan = await freezeQuery<FreezePlan>(db, "SELECT nb_freeze_api.preview($1,$2) AS result", [target, action]);
      if (!plan || !hash(plan.digest) || plan.action !== action || !id(plan.rootId) ||
          !/^[0-9]+$/.test(plan.generation) || !version(plan.publicationRevision) || !(plan.groupId === null || uuid(plan.groupId)) ||
          !Array.isArray(plan.members) || plan.members.length !== plan.pages || plan.members.some(m => !m || !id(m.id) || !id(m.sourceKey) || typeof m.title !== "string") ||
          ![plan.pages, plan.images, plan.missingImages].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 20000) ||
          !Array.isArray(plan.media) || plan.media.length !== plan.images || typeof plan.title !== "string" ||
          typeof plan.href !== "string" || !plan.href.startsWith("/") || plan.href.startsWith("//")) throw new FreezeError("FREEZE_UNAVAILABLE");
      plan.media.forEach(validateMedia);
      if (!Array.isArray(plan.thumbnailIds) || new Set(plan.thumbnailIds).size !== plan.thumbnailIds.length || plan.thumbnailIds.some(id => !plan.media.some(m => m.assetId === id))) throw new FreezeError("FREEZE_UNAVAILABLE");
      return plan;
    },
    async freeze(operationId: string, plan: FreezePlan, verifiedMedia: StoredMedia[]) {
      if (!uuid(operationId) || plan.action !== "freeze" || !hash(plan.digest)) throw new FreezeError("FREEZE_INPUT_INVALID");
      verifiedMedia.forEach(validateMedia);
      const result = await freezeQuery<{ operationId: string; groupId: string; pages: number; generation: string }>(db,
        "SELECT nb_freeze_api.freeze($1,$2,$3,$4::jsonb) AS result", [operationId, plan.rootId, plan.digest, JSON.stringify(verifiedMedia)]);
      if (!result || result.operationId !== operationId || !uuid(result.groupId) || result.pages !== plan.pages || !/^[0-9]+$/.test(result.generation)) throw new FreezeError("FREEZE_UNAVAILABLE");
      return result;
    },
    async unfreeze(operationId: string, plan: FreezePlan) {
      if (!uuid(operationId) || plan.action !== "permanent" || !hash(plan.digest)) throw new FreezeError("FREEZE_INPUT_INVALID");
      const result = await freezeQuery<{ operationId: string; generation: string; members: { id: string; sourceKey: string }[] }>(db,
        "SELECT nb_freeze_api.unfreeze($1,$2,$3) AS result", [operationId, plan.rootId, plan.digest]);
      if (!result || result.operationId !== operationId || !/^[0-9]+$/.test(result.generation) || !Array.isArray(result.members) ||
          result.members.length !== plan.pages || result.members.some(m => !m || !id(m.id) || !id(m.sourceKey))) throw new FreezeError("FREEZE_UNAVAILABLE");
      return result;
    },
    async lookup(operationId: string) {
      if (!uuid(operationId)) throw new FreezeError("FREEZE_INPUT_INVALID");
      return freezeQuery<Record<string, unknown> | null>(db, "SELECT nb_freeze_api.read_operation($1) AS result", [operationId]);
    },
    async refresh(operationId: string, groupId: string, generation: string, delta: PreparedPublicationDelta): Promise<DeltaReceipt> {
      if (!uuid(operationId) || !uuid(groupId) || !/^[0-9]+$/.test(generation) || !hash(delta.payloadDigest)) throw new FreezeError("FREEZE_INPUT_INVALID");
      if (preparePublicationDelta(delta).payloadDigest !== delta.payloadDigest) throw new FreezeError("FREEZE_INPUT_INVALID");
      const result = await freezeQuery<DeltaReceipt>(db, "SELECT nb_freeze_api.refresh_delta($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) AS result",
        [operationId, groupId, generation, delta.payloadDigest, delta.expectedRevision, delta.configDigest,
          JSON.stringify(delta.upserts), JSON.stringify(delta.media), JSON.stringify(delta.withdrawals)]);
      if (!result || Object.keys(result).length !== 9 || result.operationId !== operationId || result.payloadDigest !== delta.payloadDigest ||
          !version(result.publicationRevision) || result.committed !== true || ![result.upserts, result.withdrawals, result.removedRecords, result.records, result.media].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 20000)) throw new FreezeError("FREEZE_UNAVAILABLE");
      return result;
    },
  };
}
