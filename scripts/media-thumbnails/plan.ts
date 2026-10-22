import type { MediaSourceVersion } from "../../src/server/media/notion-source.ts";
import { ContentServiceError } from "../../contracts/repository.ts";

export interface ThumbnailPlan { version: MediaSourceVersion; runId: string; assetIds: string[] }

/** The operator selects one published generation; this is never a source scan. */
export function parseThumbnailPlan(value: unknown): ThumbnailPlan {
  const plan = value as ThumbnailPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan) ||
      Object.keys(plan).length !== 3 || !["version", "runId", "assetIds"].every(key => Object.hasOwn(plan, key)) ||
      !["v1", "v2"].includes(plan.version) || typeof plan.runId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.runId) ||
      !Array.isArray(plan.assetIds) || plan.assetIds.length < 1 || plan.assetIds.length > 20_000 ||
      Array.from(plan.assetIds).some(id => typeof id !== "string" || !/^a1\.[a-f0-9]{64}$/.test(id)) ||
      new Set(plan.assetIds).size !== plan.assetIds.length) {
    throw new ContentServiceError("MISCONFIGURED", "The private thumbnail plan is invalid.");
  }
  return { version: plan.version, runId: plan.runId, assetIds: [...plan.assetIds] };
}
