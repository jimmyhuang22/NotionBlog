import type { ContentRepository } from "../../../contracts/repository.ts";
import type { ReadinessSample } from "./protocol.ts";

/** Same uncached website repository and qualification rules, with a known public Status sample. */
export async function probeContentReadiness(repository: ContentRepository, runId: string, sample: ReadinessSample) {
  if (!repository.readSnapshot) throw Error("READINESS_UNAVAILABLE");
  const first = await repository.readSnapshot([], false);
  const revision = first.version.slice(runId.length + 1);
  if (!first.version.startsWith(runId + ":") || !/^\d+$/.test(revision) || first.records.length !== 0) throw Error("READINESS_UNAVAILABLE");
  const detail = await repository.get("status", sample.slug);
  if (!detail || detail.item.kind !== "status" || detail.item.id !== sample.id || detail.item.slug !== sample.slug || !detail.document ||
    detail.document.completeness !== "complete" || !Array.isArray(detail.document.blocks) || !Array.isArray(detail.document.toc)) throw Error("READINESS_UNAVAILABLE");
  const last = await repository.readSnapshot([], false);
  if (last.version !== first.version || last.records.length !== 0) throw Error("READINESS_UNAVAILABLE");
}
