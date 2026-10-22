import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import catalog from "../../database/capture-recovery-compatibility.json" with { type: "json" };
import { directory, privateText, verifyRelease, fail } from "./release.mjs";
import { admitReviewedCaptureRecovery, type ReviewedRecoveryTransition } from "./capture-recovery-admission.ts";
import { courseRatingRemoval } from "./mapped-capture.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface CaptureRecoveryInputs {
  transitionId: string;
  producerProject: string; producerManifest: string; producerManifestSha256: string;
  consumerProject: string; consumerManifest: string; consumerManifestSha256: string;
  currentSourceText: string;
  previousSource?: { file: string; sha256: string };
}

/** No fallback to a historical transition and no caller-supplied allow table.
 * The empty initial catalog deliberately authorizes no real producer. */
export async function prepareHostCaptureRecovery(input: CaptureRecoveryInputs) {
  const entries: ReviewedRecoveryTransition[] = catalog.transitions;
  const entry = entries.find(candidate => candidate.id === input.transitionId);
  if (catalog.format !== "capture-recovery-catalog-v1" || !entry || entries.filter(e => e.id === entry.id).length !== 1 ||
      input.consumerProject !== resolve(fileURLToPath(new URL("../..", import.meta.url))) ||
      !/^[a-f0-9]{64}$/.test(input.producerManifestSha256) ||
      hash(await privateText(input.producerManifest)) !== input.producerManifestSha256 ||
      !/^[a-f0-9]{64}$/.test(input.consumerManifestSha256) ||
      hash(await privateText(input.consumerManifest)) !== input.consumerManifestSha256) fail("RELEASE_INVALID");
  const producer = await verifyRelease(input.producerProject, input.producerManifest);
  const consumer = await verifyRelease(input.consumerProject, input.consumerManifest);
  if (hash(await privateText(input.producerManifest)) !== input.producerManifestSha256 ||
      hash(await privateText(input.consumerManifest)) !== input.consumerManifestSha256) fail("RELEASE_INVALID");
  const catalogBytes = await readFile(new URL("../../database/capture-recovery-compatibility.json", import.meta.url), "utf8");
  const admission = admitReviewedCaptureRecovery(producer, consumer, entry, hash(catalogBytes));
  if (entry.kind === "course-rating-removal") {
    if (!input.previousSource || !/^[a-f0-9]{64}$/.test(input.previousSource.sha256)) fail("PRIVATE_INPUT_INVALID");
    await directory(dirname(input.previousSource.file));
    const previous = await privateText(input.previousSource.file);
    if (hash(previous) !== input.previousSource.sha256) fail("PRIVATE_INPUT_INVALID");
    return { admission, mapping: courseRatingRemoval(previous, input.currentSourceText) };
  }
  if (input.previousSource !== undefined) fail("PRIVATE_INPUT_INVALID");
  return { admission, mapping: undefined };
}
