import { createHash } from "node:crypto";
import { fail } from "./release.mjs";

export const RECOVERY_CATALOG = "database/capture-recovery-compatibility.json";
export interface RecoveryRelease {
  commit: string; nodePath: string; nodeVersion: string; nodeSha256: string;
  files: { path: string; sha256: string }[];
}
export interface ReviewedRecoveryTransition {
  id: string;
  kind: "course-rating-removal" | "course-projection-refresh";
  producerCommit: string;
  nodePathSha256: string; nodeVersion: string; nodeSha256: string;
  producerCatalogSha256: string | null;
  /** Complete union, including unchanged files; only the catalog is separate. */
  files: { path: string; before: string | null; after: string | null }[];
}
declare const admissionBrand: unique symbol;
export type CaptureRecoveryAdmission = Readonly<{
  format: "capture-recovery-admission-v1"; id: string; kind: ReviewedRecoveryTransition["kind"];
  producerReleaseCommit: string; consumerReleaseCommit: string;
  changedFiles: readonly string[]; originalCaptureUnchanged: true;
  [admissionBrand]: true;
}>;
const admissions = new WeakSet<object>();
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const pathDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const pathValid = (path: string) => /^[a-zA-Z0-9_.\/\[\]-]+$/.test(path) &&
  !path.split("/").some(p => !p || p === "." || p === "..") && !/^(node_modules|\.git)\//.test(path);
const reject = (): never => fail("RELEASE_INVALID");

/** Engineering evaluator for a SOURCE-REVIEWED table. The host never reads such
 * a table from operator input: its only caller uses the bundled catalog. Every
 * unchanged file is pinned too, so modifying both manifests cannot hide a delta.
 * Catalog bytes are bound separately to avoid a self-referential SHA-256. */
export function admitReviewedCaptureRecovery(producer: RecoveryRelease, consumer: RecoveryRelease,
  transition: ReviewedRecoveryTransition, consumerCatalogSha256: string): CaptureRecoveryAdmission {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(transition.id) ||
      !["course-rating-removal", "course-projection-refresh"].includes(transition.kind) ||
      !/^[a-f0-9]{40}$/.test(transition.producerCommit) || producer.commit !== transition.producerCommit ||
      !/^[a-f0-9]{40}$/.test(consumer.commit) || consumer.commit === producer.commit ||
      !sha(transition.nodePathSha256) || !/^24\.[0-9]+\.[0-9]+$/.test(transition.nodeVersion) ||
      !sha(transition.nodeSha256) || !sha(consumerCatalogSha256) ||
      (transition.producerCatalogSha256 !== null && !sha(transition.producerCatalogSha256)) ||
      [producer, consumer].some(release => typeof release.nodePath !== "string" || !release.nodePath.startsWith("/") ||
        pathDigest(release.nodePath) !== transition.nodePathSha256 ||
        release.nodeVersion !== transition.nodeVersion || release.nodeSha256 !== transition.nodeSha256)) reject();
  const manifest = (release: RecoveryRelease) => {
    if (!Array.isArray(release.files) || !release.files.length || release.files.length > 5000 ||
        release.files.some(f => !pathValid(f.path) || !sha(f.sha256))) reject();
    const result = new Map(release.files.map(f => [f.path, f.sha256]));
    if (result.size !== release.files.length) reject();
    return result;
  };
  const before = manifest(producer), after = manifest(consumer);
  if ((before.get(RECOVERY_CATALOG) ?? null) !== transition.producerCatalogSha256 ||
      after.get(RECOVERY_CATALOG) !== consumerCatalogSha256 || !Array.isArray(transition.files)) reject();
  const pairs = new Map(transition.files.map(pair => [pair.path, pair]));
  const all = new Set([...before.keys(), ...after.keys()]); all.delete(RECOVERY_CATALOG);
  if (pairs.size !== transition.files.length || pairs.size !== all.size || pairs.has(RECOVERY_CATALOG)) reject();
  for (const [path, pair] of pairs) {
    if (!pathValid(path) || !all.has(path) || (pair.before === null && pair.after === null) ||
        (pair.before !== null && !sha(pair.before)) || (pair.after !== null && !sha(pair.after)) ||
        (before.get(path) ?? null) !== pair.before || (after.get(path) ?? null) !== pair.after) reject();
  }
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path) !== after.get(path)).sort();
  if (!changedFiles.some(path => path !== RECOVERY_CATALOG)) reject();
  const admission = Object.freeze({ format: "capture-recovery-admission-v1", id: transition.id, kind: transition.kind,
    producerReleaseCommit: producer.commit, consumerReleaseCommit: consumer.commit,
    changedFiles: Object.freeze(changedFiles), originalCaptureUnchanged: true }) as CaptureRecoveryAdmission;
  admissions.add(admission); return admission;
}

/** JSON receipts, boolean flags and objects from another process confer nothing. */
export function readCaptureRecoveryAdmission(value: CaptureRecoveryAdmission): CaptureRecoveryAdmission {
  if (!value || !admissions.has(value)) reject();
  return value;
}
