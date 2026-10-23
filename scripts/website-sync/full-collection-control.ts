import { ContentServiceError } from "../../contracts/repository.ts";
import type { FullCollectionExpectation, FullCollectionQualification } from "./full-collection.ts";

const invalid = (): never => { throw new ContentServiceError("MISCONFIGURED", "Invalid full collection binding."); };
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const counter = (v: unknown) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
const keys = (v: object, names: string) => Object.keys(v).sort().join(",") === names.split(",").sort().join(",");

export interface FullCollectionPlan {
  format: "website-full-collection-plan-v1";
  expectation: FullCollectionExpectation;
  postSeconds: number;
}
export interface FullCollectionPrepared {
  format: "website-full-collection-prepared-v1";
  runId: string; sourceSha256: string; releaseCommit: string; manifestSha256: string; runtimeSha256: string;
  timeoutSeconds: number; plan: FullCollectionPlan;
}
export interface FullCollectionBinding {
  format: "website-full-collection-binding-v1";
  prepared: FullCollectionPrepared;
  qualification: FullCollectionQualification;
}

/** Pure validation: no connection, budget, lock, source or saved capture. */
export function parseFullCollectionPlan(input: unknown, seconds: number): FullCollectionPlan {
  let p: FullCollectionPlan;
  try { p = structuredClone(input) as FullCollectionPlan; } catch { return invalid(); }
  const e = p?.expectation;
  if (!p || !keys(p, "format,expectation,postSeconds") || p.format !== "website-full-collection-plan-v1" ||
      !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 7200 ||
      !Number.isSafeInteger(p.postSeconds) || p.postSeconds < 0 || p.postSeconds > 7200 ||
      !e || !keys(e, "configDigest,revision,epoch,currentRun,freshnessSeconds,minimumRemainingSeconds") ||
      !hash(e.configDigest) || !counter(e.revision) || !counter(e.epoch) || e.currentRun !== null && !uuid(e.currentRun) ||
      !Number.isSafeInteger(e.freshnessSeconds) || e.freshnessSeconds < 1 || e.freshnessSeconds > 86400 ||
      !Number.isSafeInteger(e.minimumRemainingSeconds) || e.minimumRemainingSeconds < seconds + p.postSeconds ||
      e.minimumRemainingSeconds > e.freshnessSeconds) invalid();
  Object.freeze(e); return Object.freeze(p);
}

export function prepareFullCollection(input: Omit<FullCollectionPrepared, "format">, digest: string): FullCollectionPrepared {
  const p = structuredClone(input);
  if (!keys(p, "runId,sourceSha256,releaseCommit,manifestSha256,runtimeSha256,timeoutSeconds,plan") || !uuid(p.runId) ||
      ![p.sourceSha256, p.manifestSha256, p.runtimeSha256].every(hash) || !/^[a-f0-9]{40}$/.test(p.releaseCommit)) invalid();
  const plan = parseFullCollectionPlan(p.plan, p.timeoutSeconds);
  if (digest !== plan.expectation.configDigest || p.runId === plan.expectation.currentRun) invalid();
  return Object.freeze({ ...p, format: "website-full-collection-prepared-v1", plan });
}

/** An audit binding only. Deserialized JSON never grants source/writer access. */
export function bindFullCollection(prepared: FullCollectionPrepared, qualification: FullCollectionQualification): FullCollectionBinding {
  if (prepared?.format !== "website-full-collection-prepared-v1") invalid();
  const { format: _format, ...input } = prepared;
  const p = prepareFullCollection(input, prepared.plan.expectation.configDigest), e = p.plan.expectation;
  const q = structuredClone(qualification);
  if (!q || !keys(q, "format,qualification,runId,fence,revision,epoch,configDigest,currentRun,serverNow,validUntil") ||
      q.format !== "website-full-collection-qualification-v1" || q.qualification !== "full-collection" || q.runId !== p.runId ||
      !counter(q.fence) || q.revision !== e.revision || q.epoch !== e.epoch || q.configDigest !== e.configDigest || q.currentRun !== e.currentRun ||
      !Number.isFinite(Date.parse(q.serverNow)) || !Number.isFinite(Date.parse(q.validUntil)) ||
      Date.parse(q.validUntil) - Date.parse(q.serverNow) <= e.minimumRemainingSeconds * 1000 ||
      Date.parse(q.validUntil) - Date.parse(q.serverNow) > e.freshnessSeconds * 1000 + 1) invalid();
  return Object.freeze({ format: "website-full-collection-binding-v1", prepared: p, qualification: Object.freeze(q) });
}

export function verifyFullCollectionBinding(prepared: FullCollectionPrepared, value: unknown): FullCollectionBinding {
  const b = value as FullCollectionBinding;
  if (!b || !keys(b, "format,prepared,qualification") || b.format !== "website-full-collection-binding-v1") invalid();
  const result = bindFullCollection(prepared, b.qualification);
  // Canonical construction avoids key-order dependence without accepting extra fields.
  if (!b.prepared || b.prepared.format !== prepared.format) invalid();
  const { format: _format, ...input } = b.prepared;
  const other = prepareFullCollection(input, prepared.plan.expectation.configDigest);
  for (const key of ["runId", "sourceSha256", "releaseCommit", "manifestSha256", "runtimeSha256", "timeoutSeconds"] as const)
    if (other[key] !== result.prepared[key]) invalid();
  if (other.plan.postSeconds !== prepared.plan.postSeconds ||
      Object.entries(prepared.plan.expectation).some(([k, v]) => other.plan.expectation[k as keyof FullCollectionExpectation] !== v)) invalid();
  return result;
}

export interface FullCollectionPostReceipt {
  phase: "thumbnail" | "snapshot" | "visitor" | "body";
  status: "PASS"; runId: string; binding: FullCollectionBinding;
}
/** Controller gate for the complete SAME batch. No missing/stale post is inferred. */
export function acceptFullCollectionPosts(prepared: FullCollectionPrepared, worker: {
  runId: string; cloudRunId: string; mode: string; published: boolean; readerVerified: boolean;
  resumeQualification?: unknown; fullCollectionBinding: unknown;
}, posts: readonly FullCollectionPostReceipt[], now = Date.now()) {
  const b = verifyFullCollectionBinding(prepared, worker.fullCollectionBinding);
  if (worker.runId !== prepared.runId || worker.cloudRunId !== prepared.runId || worker.mode !== "publish" ||
      worker.published !== true || worker.readerVerified !== true || worker.resumeQualification !== undefined || posts.length !== 4 ||
      !Number.isFinite(now) || now < Date.parse(b.qualification.serverNow) || now >= Date.parse(b.qualification.validUntil)) invalid();
  const seen = new Set<string>();
  for (const post of posts) {
    if (!post || !keys(post, "phase,status,runId,binding") || !["thumbnail", "snapshot", "visitor", "body"].includes(post.phase) ||
        seen.has(post.phase) || post.status !== "PASS" || post.runId !== prepared.runId) invalid();
    const actual = verifyFullCollectionBinding(prepared, post.binding);
    if (JSON.stringify(actual) !== JSON.stringify(b)) invalid();
    seen.add(post.phase);
  }
  return Object.freeze({ format: "website-full-collection-posts-v1", runId: prepared.runId, status: "PASS", binding: b });
}
