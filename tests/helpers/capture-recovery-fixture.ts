import { createHash } from "node:crypto";
import fixture from "../fixtures/capture-recovery-releases.json" with { type: "json" };
import { RECOVERY_CATALOG, admitReviewedCaptureRecovery, type RecoveryRelease, type ReviewedRecoveryTransition } from "../../scripts/website-sync/capture-recovery-admission.ts";

export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const fixtureSources = fixture;
/** Public synthetic snapshots; no git-show, old repository objects or private package. */
export function recoveryFixture(kind: ReviewedRecoveryTransition["kind"] = "course-projection-refresh") {
  const node = { nodePath: "/node", nodeVersion: "24.21.0", nodeSha256: "b".repeat(64) };
  const release = (source: Record<string, string>, commit: string): RecoveryRelease => ({ ...node, commit,
    files: Object.entries(source).map(([path, text]) => ({ path, sha256: digest(text) })) });
  const producer = release(fixture.producer, "a".repeat(40)), consumer = release(fixture.consumer, "d".repeat(40));
  const before = new Map(producer.files.map(f => [f.path, f.sha256])), after = new Map(consumer.files.map(f => [f.path, f.sha256]));
  const transition: ReviewedRecoveryTransition = { nodePathSha256:digest(node.nodePath), nodeVersion:node.nodeVersion, nodeSha256:node.nodeSha256, id: "synthetic-course-recovery", kind,
    producerCommit: producer.commit, producerCatalogSha256: null,
    files: [...new Set([...before.keys(), ...after.keys()])].filter(path => path !== RECOVERY_CATALOG)
      .map(path => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null })) };
  const catalogSha256 = digest(fixture.consumer[RECOVERY_CATALOG]);
  return { producer, consumer, transition, catalogSha256,
    admit: () => admitReviewedCaptureRecovery(producer, consumer, transition, catalogSha256) };
}
