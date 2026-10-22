import { createHash } from "node:crypto";
import { privateText, verifyRelease, fail } from "./release.mjs";

import freshTransition from "../../database/capture-requalification-compatibility.json" with { type: "json" };
import proofTransition from "../../database/capture-proof-compatibility.json" with { type: "json" };

import reuseTransition from "../../database/capture-media-reuse-compatibility.json" with { type: "json" };
import renewalRepair from "../../database/capture-renewal-timeout-compatibility.json" with { type: "json" };
import externalVideoTransition from "../../database/capture-external-video-compatibility.json" with { type: "json" };
import publicationRepair from "../../database/capture-publication-revalidation-compatibility.json" with { type: "json" };

type Release = { commit: string; nodePath: string; nodeVersion: string; nodeSha256: string; files: { path: string; sha256: string }[] };
const producerCommit = "99352be4a5ce92735fd7f1560ab28689c0c3a300";
const workerPath = "scripts/website-sync/worker.ts";
const oldWorker = "9a302db7b9eaba3b7a7cd1fdc99afbe0c81fe284964d3d7bf3e5285c5642be1f";
const fixedWorker = "b9ccf53f3c08b1aa785f895cd76c6c4b78d64efa4999399fc0ea7b14684992be";
// Only host plumbing and planning are allowed to differ in addition to the
// exact reviewed expiry fix. DTOs, source proofs, projection/mapping, SQL,
// dependency locks, byte validation and the capture format must match exactly.
const plumbing = new Set([
  "scripts/website-sync/run-private.mjs", "scripts/website-sync/run.ts",
  "scripts/website-sync/collection-resume-plan.ts", "scripts/website-sync/capture-release-compatibility.ts",
  "scripts/website-sync/release.d.mts",
]);
const documentation = (path: string) => path.startsWith("docs/") || path.startsWith("tests/");

/** Narrow, reviewed producer transition, not a caller-provided compatibility override. */
export function checkCaptureReleaseCompatibility(producer: Release, consumer: Release) {
  const reject = () => fail("RELEASE_INVALID");
  const videoSpec = "database/capture-external-video-compatibility.json";
  const publicationSpec = "database/capture-publication-revalidation-compatibility.json";
  // Both JSON modules ship with this verifier. Select by the reviewed executable
  // bytes, not import order or spec presence, and refuse an unreviewed combination.
  const current = new Map(consumer.files.map(file => [file.path, file.sha256]));
  const video = producer.commit === externalVideoTransition.producerCommit && externalVideoTransition.files.every(file => current.get(file.path) === file.after);
  const publication = producer.commit === publicationRepair.producerCommit && publicationRepair.files.every(file => current.get(file.path) === file.after);
  if (video && publication) reject();
  if (video) return checkPinnedTransition(producer, consumer, externalVideoTransition, videoSpec, "capture-external-video-links-v1",
    { path: publicationSpec, sha256: "73583a83be5ae11b53a149eaa4c3f2d083c19fc1a58a2b70136fba866c1a6f20" });
  if (publication) return checkPinnedTransition(producer, consumer, publicationRepair, publicationSpec, "capture-publication-revalidation-compatibility-v1",
    { path: videoSpec, sha256: "f907daf22a9c2800d4d58f6a3771a5642798008ecc495646f17eebdc5ff4ca9c" });
  if (producer.commit === reuseTransition.producerCommit) return checkPinnedTransition(producer, consumer, reuseTransition,
    "database/capture-media-reuse-compatibility.json", "capture-bounded-media-reuse-compatibility-v1");
  if (producer.commit === proofTransition.producerCommit) return checkPinnedTransition(producer, consumer, proofTransition,
    "database/capture-proof-compatibility.json", "capture-versioned-proof-compatibility-v1");
  if (producer.commit === freshTransition.producerCommit) return checkPinnedTransition(producer, consumer, freshTransition,
    "database/capture-requalification-compatibility.json", "capture-fresh-verification-compatibility-v1");
  if (producer.commit !== producerCommit || producer.commit === consumer.commit ||
      ["nodePath", "nodeVersion", "nodeSha256"].some(k => producer[k as keyof Release] !== consumer[k as keyof Release])) reject();
  const old = new Map(producer.files.map(f => [f.path, f.sha256]));
  if (old.size !== producer.files.length || current.size !== consumer.files.length || old.get(workerPath) !== oldWorker || current.get(workerPath) !== fixedWorker) reject();
  const changed: string[] = [];
  for (const path of new Set([...old.keys(), ...current.keys()])) {
    if (old.get(path) === current.get(path)) continue;
    changed.push(path);
    if (path !== workerPath && !plumbing.has(path) && !documentation(path)) reject();
  }
  return { format: "capture-expiry-fix-compatibility-v1", producerReleaseCommit: producer.commit,
    consumerReleaseCommit: consumer.commit, changedFiles: changed.sort(), originalCaptureUnchanged: true };
}

/** Exact reviewed byte pairs for the capacity/fresh-verification repair. This
 * cannot waive a mapper/proof/DTO/dependency change via an operator input. */
function checkPinnedTransition(producer: Release, consumer: Release,
  transition: { files: { path: string; before: string | null; after: string }[] }, specPath: string, format: string,
  supportingSpec?: { path: string; sha256: string }) {
  const reject = () => fail("RELEASE_INVALID");
  if (producer.commit === consumer.commit || ["nodePath","nodeVersion","nodeSha256"].some(k => producer[k as keyof Release] !== consumer[k as keyof Release])) reject();
  const old=new Map(producer.files.map(f=>[f.path,f.sha256])),current=new Map(consumer.files.map(f=>[f.path,f.sha256]));
  if(old.size!==producer.files.length||current.size!==consumer.files.length)reject();
  const pairs=new Map(transition.files.map(f=>[f.path,f]));
  // Pin all reviewed files even if a forged pair of manifests makes one appear unchanged.
  for(const [path,pair] of pairs)if((old.get(path)??null)!==pair.before||current.get(path)!==pair.after)reject();
  // This transport-only fix can accompany an already pinned transition. It
  // cannot authorize another mapper, proof, dependency or qualification change.
  const renewalSpec="database/capture-renewal-timeout-compatibility.json";
  const repairedRenewal=old.get(renewalRepair.path)===renewalRepair.before&&current.get(renewalRepair.path)===renewalRepair.after&&current.has(renewalSpec);
  const changed:string[]=[];
  for(const path of new Set([...old.keys(),...current.keys()])){
    if(old.get(path)===current.get(path))continue;
    changed.push(path);
    // The other imported JSON is data only, pinned to its exact reviewed bytes.
    const supportedSpec = supportingSpec?.path === path && current.get(path) === supportingSpec.sha256;
    if(!pairs.has(path)&&!documentation(path)&&path!=="scripts/website-sync/capture-release-compatibility.ts"&&path!==specPath&&
      !supportedSpec&&!(repairedRenewal&&(path===renewalRepair.path||path===renewalSpec)))reject();
  }
  if(!current.has(specPath))reject();
  return {format,producerReleaseCommit:producer.commit,
    consumerReleaseCommit:consumer.commit,changedFiles:changed.sort(),originalCaptureUnchanged:true};
}

export async function verifyCaptureProducer(input: {
  producerProject: string; producerManifest: string; producerManifestSha256: string;
  consumerProject: string; consumerManifest: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.producerManifestSha256) ||
      createHash("sha256").update(await privateText(input.producerManifest)).digest("hex") !== input.producerManifestSha256) fail("RELEASE_INVALID");
  const producer = await verifyRelease(input.producerProject, input.producerManifest);
  const consumer = await verifyRelease(input.consumerProject, input.consumerManifest);
  return checkCaptureReleaseCompatibility(producer, consumer);
}
