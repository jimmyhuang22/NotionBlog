import type { ContentKind } from "../../contracts/content.ts";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { PublicContentSnapshot } from "../../contracts/website.ts";
import type { MediaSourceVersion } from "../../src/server/media/notion-source.ts";
import { canonicalJson } from "../../src/server/database/validation.ts";
import { readThumbnail, type ThumbnailWidth } from "../../src/server/database/thumbnail-index.ts";
import { selectThumbnailCandidates, type ThumbnailCandidate } from "./coverage.ts";
import type { ThumbnailPlan } from "./plan.ts";
import type { ThumbnailWidthSelection } from "./widths.ts";

export interface ThumbnailPlanningInventory {
  format: "notionblog-thumbnail-inventory-v1";
  version: MediaSourceVersion;
  runId: string;
  snapshotVersion: string;
  qualifiedAt: string;
  validUntil: string;
  cells: {assetId: string; widthCap: ThumbnailWidth; result: unknown}[];
}
export interface ThumbnailPlanningLimits {
  maxParents: number;
  maxOriginalBytes: number;
  maxUploadRequests: number;
  maxUploadBodyBytes: number;
  maxDurationSeconds: number;
  maxTotalParents: number;
  maxTotalOriginalBytes: number;
  maxTotalUploadBodyBytes: number;
  maxTotalDurationSeconds: number;
  eligibilityReserveSeconds: number;
}
interface CandidateCoverage extends ThumbnailCandidate {
  originalByteSize: number;
  existingWidths: ThumbnailWidth[];
  missingNeededWidths: ThumbnailWidth[];
  generatorMissingWidths: ThumbnailWidth[];
}
export interface ThumbnailCoverageReport {
  status: "PLANNING_ONLY";
  createdAt: string;
  snapshotVersion: string;
  validUntil: string;
  qualification: "EXPORTED_METADATA_ONLY_RECHECK_BEFORE_EXECUTION";
  estimatedUploadBodyBytes: null;
  estimatedNewObjectBytes: null;
  estimatedDurationMs: null;
  limits: ThumbnailPlanningLimits;
  summary: Record<string, number>;
  candidateCoverage: CandidateCoverage[];
  deferred: {assetId: string; reason: "PARENT_READ_LIMIT" | "POST_REQUEST_LIMIT" | "ROUND_BUDGET_OR_TIME_WINDOW"}[];
  batches: {
    number: number;
    plan: ThumbnailPlan;
    widths: ThumbnailWidthSelection;
    budget: Pick<ThumbnailPlanningLimits, "maxParents" | "maxOriginalBytes" | "maxUploadRequests" | "maxUploadBodyBytes" | "maxDurationSeconds"> & {
      requiresRuntimeBudgetGuard: true; requiresRequalification: true; requiresWidthSelection: true;
    };
    stats: {parentCount: number; requestedVariants: number; existingMappings: number; missingVariants: number;
      extraVariantsBeyondUI: number; postRequestUpperBound: number; originalReadUpperBoundBytes: number};
  }[];
}
const WIDTHS: readonly ThumbnailWidth[] = [400, 800];
const GIB = 1024 ** 3;
function fail(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Thumbnail coverage planning could not safely complete."); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value)?.[0] !== value) fail();
  const ms = Date.parse(value);
  // Date.parse normalizes invalid dates and 24:00:00; neither can grant time.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) fail();
  return ms;
}
function parseLimits(input: ThumbnailPlanningLimits): ThumbnailPlanningLimits {
  const maxima: Record<keyof ThumbnailPlanningLimits, number> = {
    maxParents: 20_000, maxOriginalBytes: GIB, maxUploadRequests: 40_000, maxUploadBodyBytes: 2 * GIB,
    maxDurationSeconds: 480, maxTotalParents: 20_000, maxTotalOriginalBytes: 64 * GIB,
    maxTotalUploadBodyBytes: 64 * GIB, maxTotalDurationSeconds: 86400, eligibilityReserveSeconds: 3600,
  };
  if (!exact(input, Object.keys(maxima))) fail();
  for (const [key, maximum] of Object.entries(maxima)) {
    const n = input[key];
    if (!Number.isSafeInteger(n) || (n as number) < (key === "eligibilityReserveSeconds" ? 0 : 1) || (n as number) > maximum) fail();
  }
  return {...input} as unknown as ThumbnailPlanningLimits;
}

/** Offline proposals only: no source scan, credential use, object access or qualification grant. */
export async function planThumbnailCoverage(input: {
  snapshot: PublicContentSnapshot; inventory: ThumbnailPlanningInventory;
  enabledKinds: readonly ContentKind[]; limits: ThumbnailPlanningLimits;
}, now = Date.now()): Promise<ThumbnailCoverageReport> {
  try {
    if (!exact(input, ["snapshot", "inventory", "enabledKinds", "limits"]) || !Number.isFinite(now)) fail();
    const inventory = input.inventory as unknown as ThumbnailPlanningInventory;
    const snapshot = input.snapshot as unknown as PublicContentSnapshot;
    const limits = parseLimits(input.limits as unknown as ThumbnailPlanningLimits);
    if (!exact(inventory, ["format", "version", "runId", "snapshotVersion", "qualifiedAt", "validUntil", "cells"]) ||
        inventory.format !== "notionblog-thumbnail-inventory-v1" || !["v1", "v2"].includes(inventory.version) ||
        typeof inventory.runId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(inventory.runId) ||
        typeof inventory.snapshotVersion !== "string" || !inventory.snapshotVersion.startsWith(`${inventory.runId}:`) ||
        !/^[0-9]+$/.test(inventory.snapshotVersion.slice(37)) || snapshot?.version !== inventory.snapshotVersion ||
        !Array.isArray(inventory.cells) || inventory.cells.length > 40_000) fail();
    const checked = timestamp(inventory.qualifiedAt), expiry = timestamp(inventory.validUntil);
    if (checked > now + 30_000 || checked >= expiry || now >= expiry) fail();
    const selection = selectThumbnailCandidates(snapshot, inventory.version, input.enabledKinds as readonly ContentKind[]);
    const chosen = new Map(selection.assets.map(asset => [asset.assetId, asset]));
    if (inventory.cells.length !== chosen.size * 2) fail();
    const cells = new Map<string, unknown>();
    for (const cell of inventory.cells) {
      if (!exact(cell, ["assetId", "widthCap", "result"]) || !chosen.has(cell.assetId as string) ||
          (cell.widthCap !== 400 && cell.widthCap !== 800) || cell.result === null) fail();
      const key = `${cell.assetId}:${cell.widthCap}`;
      if (cells.has(key)) fail(); cells.set(key, cell.result);
    }
    const candidateCoverage: CandidateCoverage[] = [];
    for (const candidate of selection.assets) {
      const projections = await Promise.all(WIDTHS.map(width => readThumbnail({query: async <T>() => ({
        rows: [{result: cells.get(`${candidate.assetId}:${width}`)} as T],
      })}, inventory.version, candidate.assetId, width)));
      const [four, eight] = projections;
      if (!four || !eight || four.runId !== inventory.runId || eight.runId !== inventory.runId ||
          canonicalJson(four.source) !== canonicalJson(eight.source) || four.source.media.ownerPageId !== candidate.ownerPageId) fail();
      const existingWidths = WIDTHS.filter((_, index) => projections[index]?.thumbnail !== null);
      candidateCoverage.push({...candidate, originalByteSize: four.source.media.byteSize,
        existingWidths, missingNeededWidths: candidate.neededWidths.filter(w => !existingWidths.includes(w)),
        generatorMissingWidths: candidate.neededWidths.filter(w => !existingWidths.includes(w)),
      });
    }
    const pending = candidateCoverage.filter(a => a.missingNeededWidths.length).sort((a, b) =>
      a.originalByteSize - b.originalByteSize || a.assetId.localeCompare(b.assetId));
    const batches: ThumbnailCoverageReport["batches"] = [], deferred: ThumbnailCoverageReport["deferred"] = [];
    const secondsAvailable = Math.max(0, Math.floor((expiry - now) / 1000) - limits.eligibilityReserveSeconds);
    const durationBudget = Math.min(limits.maxTotalDurationSeconds, secondsAvailable);
    let totalParents = 0, totalOriginalBytes = 0;
    for (const candidate of pending) {
      if (candidate.originalByteSize > limits.maxOriginalBytes) {deferred.push({assetId:candidate.assetId,reason:"PARENT_READ_LIMIT"});continue;}
      if (candidate.generatorMissingWidths.length > limits.maxUploadRequests) {deferred.push({assetId:candidate.assetId,reason:"POST_REQUEST_LIMIT"});continue;}
      let batch = batches.at(-1);
      if (batch && (batch.stats.parentCount >= limits.maxParents ||
          batch.stats.originalReadUpperBoundBytes + candidate.originalByteSize > limits.maxOriginalBytes ||
          batch.stats.postRequestUpperBound + candidate.generatorMissingWidths.length > limits.maxUploadRequests)) batch = undefined;
      if (totalParents >= limits.maxTotalParents || totalOriginalBytes + candidate.originalByteSize > limits.maxTotalOriginalBytes ||
          (!batch && ((batches.length + 1) * limits.maxUploadBodyBytes > limits.maxTotalUploadBodyBytes ||
            (batches.length + 1) * limits.maxDurationSeconds > durationBudget))) {
        deferred.push({assetId:candidate.assetId,reason:"ROUND_BUDGET_OR_TIME_WINDOW"});continue;
      }
      if (!batch) {
        batch = {number:batches.length + 1,plan:{version:inventory.version,runId:inventory.runId,assetIds:[]},
          widths:{format:"notionblog-thumbnail-widths-v1",version:inventory.version,runId:inventory.runId,assets:[]},
          budget:{maxParents:limits.maxParents,maxOriginalBytes:limits.maxOriginalBytes,maxUploadRequests:limits.maxUploadRequests,
            maxUploadBodyBytes:limits.maxUploadBodyBytes,maxDurationSeconds:limits.maxDurationSeconds,
            requiresRuntimeBudgetGuard:true,requiresRequalification:true,requiresWidthSelection:true},
          stats:{parentCount:0,requestedVariants:0,existingMappings:0,missingVariants:0,extraVariantsBeyondUI:0,
            postRequestUpperBound:0,originalReadUpperBoundBytes:0}};
        batches.push(batch);
      }
      batch.plan.assetIds.push(candidate.assetId); batch.stats.parentCount++; totalParents++;
      batch.widths.assets.push({assetId:candidate.assetId,widthCaps:[...candidate.neededWidths]});
      batch.stats.requestedVariants += candidate.neededWidths.length;
      batch.stats.existingMappings += candidate.neededWidths.filter(w => candidate.existingWidths.includes(w)).length;
      batch.stats.missingVariants += candidate.generatorMissingWidths.length;
      batch.stats.extraVariantsBeyondUI += candidate.generatorMissingWidths.filter(w => !candidate.neededWidths.includes(w)).length;
      batch.stats.postRequestUpperBound += candidate.generatorMissingWidths.length;
      batch.stats.originalReadUpperBoundBytes += candidate.originalByteSize; totalOriginalBytes += candidate.originalByteSize;
    }
    return {status:"PLANNING_ONLY",createdAt:new Date(now).toISOString(),snapshotVersion:inventory.snapshotVersion,
      validUntil:inventory.validUntil,qualification:"EXPORTED_METADATA_ONLY_RECHECK_BEFORE_EXECUTION",
      estimatedUploadBodyBytes:null,estimatedNewObjectBytes:null,estimatedDurationMs:null,limits,
      summary:{recordCount:snapshot.records.length,recordsConsidered:selection.recordsConsidered,candidateParents:chosen.size,
        requestedUIVariants:candidateCoverage.reduce((n,a)=>n+a.neededWidths.length,0),
        uiCoveredParents:candidateCoverage.filter(a=>!a.missingNeededWidths.length).length,
        existingRequestedMappings:candidateCoverage.reduce((n,a)=>n+a.neededWidths.filter(w=>a.existingWidths.includes(w)).length,0),
        uiMissingVariants:candidateCoverage.reduce((n,a)=>n+a.missingNeededWidths.length,0),
        pendingParents:pending.length,pendingOriginalReadUpperBoundBytes:pending.reduce((n,a)=>n+a.originalByteSize,0),
        generatorMissingVariantsForPendingParents:pending.reduce((n,a)=>n+a.generatorMissingWidths.length,0),
        proposedParents:totalParents,proposedBatches:batches.length,
        proposedPostRequestUpperBound:batches.reduce((n,b)=>n+b.stats.postRequestUpperBound,0),
        proposedOriginalReadUpperBoundBytes:totalOriginalBytes,reservedUploadBodyLimitBytes:batches.length*limits.maxUploadBodyBytes,
        reservedDurationLimitSeconds:batches.length*limits.maxDurationSeconds,deferredParents:deferred.length,
        directExternalOccurrences:selection.directExternalOccurrences,unloadedDocuments:selection.unloadedDocuments,
        partialDocuments:selection.partialDocuments},candidateCoverage,deferred,batches};
  } catch { return fail(); }
}
