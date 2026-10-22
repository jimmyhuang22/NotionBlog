import test from "node:test";
import assert from "node:assert/strict";
import { checkCaptureReleaseCompatibility } from "../scripts/website-sync/capture-release-compatibility.ts";
import { collectionResumePlan } from "../scripts/website-sync/collection-resume-plan.ts";
import type { CollectedPage } from "../scripts/website-sync/collection-capture.ts";
import { demoId } from "../scripts/notion-sync/demo.ts";
import { laterRecoveryRuntime } from "./helpers/recovery-runtime-sources.ts";
import publicationRepair from "../database/capture-publication-revalidation-compatibility.json" with { type: "json" };

function laterPublicationRepair(path:string,current:string,prior:string,producer:Parameters<typeof checkCaptureReleaseCompatibility>[0],consumer:Parameters<typeof checkCaptureReleaseCompatibility>[1]):boolean {
  const reviewed=publicationRepair.reviewedSourceFiles.find(file=>file.path===path);
  if(!reviewed||current===prior)return false;
  assert.equal(current,reviewed.after,path);
  // These historical transitions continue to reject the new repair executable;
  // only its independently pinned producer/runtime transition may admit it.
  const changed=structuredClone(consumer);changed.files.find(file=>file.path===path)!.sha256=current;
  assert.throws(()=>checkCaptureReleaseCompatibility(producer,changed),{code:"RELEASE_INVALID"});
  return true;
}

function releases() {
  const old = { commit: "99352be4a5ce92735fd7f1560ab28689c0c3a300", nodePath: "/node", nodeVersion: "24.21.0", nodeSha256: "a".repeat(64), files: [
    { path: "scripts/website-sync/worker.ts", sha256: "9a302db7b9eaba3b7a7cd1fdc99afbe0c81fe284964d3d7bf3e5285c5642be1f" },
    ...["src/server/notion/website-repository.ts", "scripts/website-sync/collection-source-proof.ts", "contracts/website-sync.ts", "package-lock.json"].map(path => ({ path, sha256: "b".repeat(64) })),
  ] };
  const current = structuredClone(old); current.commit = "c".repeat(40);
  current.files[0].sha256 = "b9ccf53f3c08b1aa785f895cd76c6c4b78d64efa4999399fc0ea7b14684992be";
  current.files.push({ path: "scripts/website-sync/capture-release-compatibility.ts", sha256: "d".repeat(64) });
  return { old, current };
}
test("only the reviewed expiry fix may consume the old producer projection", () => {
  const { old, current } = releases();
  assert.equal(checkCaptureReleaseCompatibility(old, current).originalCaptureUnchanged, true);
  for (const mutation of [
    (v: typeof current) => { v.files[0].sha256 = "0".repeat(64); },
    ...[1, 2, 3, 4].map(i => (v: typeof current) => { v.files[i].sha256 = "0".repeat(64); }),
    (v: typeof current) => { v.files.splice(1, 1); },
    (v: typeof current) => { v.files.push({ path: "src/server/notion/new-mapper.ts", sha256: "0".repeat(64) }); },
    (v: typeof current) => { v.nodeVersion = "24.22.0"; },
  ]) {
    const changed = structuredClone(current); mutation(changed);
    assert.throws(() => checkCaptureReleaseCompatibility(old, changed), { code: "RELEASE_INVALID" });
  }
  assert.throws(() => checkCaptureReleaseCompatibility({ ...old, commit: "e".repeat(40) }, current), { code: "RELEASE_INVALID" });
});

test("largest-page scenario stays visible without becoming the known-work admission estimate", () => {
  const page = { sourceReads: [{ method: "listBlocks", id: demoId(1), digest: "a".repeat(64), requestUpperBound: 39 }],
    record: { detail: { item: { id: demoId(2) } } }, media: [], bindings: [] } as unknown as CollectedPage;
  const plan = collectionResumePlan([page], Array.from({ length: 2244 }, (_, i) => demoId(i + 2)));
  assert.equal(plan.knownWorkEstimate, 2283);
  assert.equal(plan.estimatedRemainingRequests, 87555);
  assert.equal(plan.unseenCostBounded, false); assert.equal(plan.guaranteedCompletion, false);
  const afterDiscovery=collectionResumePlan([page],[demoId(2)],0);
  assert.equal(afterDiscovery.savedVerificationRequests,39);
  assert.equal(afterDiscovery.alreadyReadVerificationRequests,39);
  assert.equal(afterDiscovery.knownWorkEstimate,1,"Final owner checks remain reserved after discovery fulfilled the proof reads");
  for(const invalid of [-1,40,0.5])assert.throws(()=>collectionResumePlan([page],[demoId(2)],invalid),{code:"CHECKPOINT_FAILED"});
});


test("capacity/fresh verification transition pins every reviewed runtime byte and preserves proof/DTO restrictions", async()=>{
  const {readFile}=await import("node:fs/promises");const {createHash}=await import("node:crypto");
  const spec=JSON.parse(await readFile(new URL("../database/capture-requalification-compatibility.json",import.meta.url),"utf8")) as {producerCommit:string;files:{path:string;before:string|null;after:string}[]};
  const base={nodePath:"/node",nodeVersion:"24.21.0",nodeSha256:"a".repeat(64)};
  const producer={...base,commit:spec.producerCommit,files:spec.files.filter(f=>f.before!==null).map(f=>({path:f.path,sha256:f.before!}))};
  const consumer={...base,commit:"d".repeat(40),files:spec.files.map(f=>({path:f.path,sha256:f.after}))};
  consumer.files.push({path:"database/capture-requalification-compatibility.json",sha256:"b".repeat(64)});
  assert.equal(checkCaptureReleaseCompatibility(producer,consumer).originalCaptureUnchanged,true);
  for(const pair of spec.files){
    const current=createHash("sha256").update(await readFile(new URL("../"+pair.path,import.meta.url))).digest("hex");
    if(laterRecoveryRuntime(pair.path,current,pair.after,producer,consumer)||laterPublicationRepair(pair.path,current,pair.after,producer,consumer)) {
      // Exact newer bytes are checked above without weakening this old spec.
    } else if(pair.path==="src/server/notion/website-repository.ts" || pair.path==="src/server/database/website-repository.ts") {
      // New mapper/website reader releases (including reader-only filtering) stay
      // outside this frozen sync transition; the newer digest must still reject.
      const expected=pair.path==="src/server/notion/website-repository.ts"
        ? "553482c9d9c2528fd7867c9bb1634cdd45cbd21153583748c5d7da3e773c4e88"
        : "7953e4da3832eb8bfb4564923612057e89f4a48648276d62680e852a1cc05a9c";
      assert.equal(current,expected);
      const newMapper=structuredClone(consumer);newMapper.files.find(f=>f.path===pair.path)!.sha256=current;
      assert.throws(()=>checkCaptureReleaseCompatibility(producer,newMapper),{code:"RELEASE_INVALID"});
    } else assert.equal(current,pair.after,pair.path);
    const changed=structuredClone(consumer);changed.files.find(f=>f.path===pair.path)!.sha256="0".repeat(64);
    assert.throws(()=>checkCaptureReleaseCompatibility(producer,changed),{code:"RELEASE_INVALID"});
  }
  const originalBlocks=structuredClone(producer),unchangedBlocks=structuredClone(consumer);
  originalBlocks.files.push({path:"src/server/notion/blocks.ts",sha256:"9".repeat(64)});
  unchangedBlocks.files.push({path:"src/server/notion/blocks.ts",sha256:"9".repeat(64)});
  assert.equal(checkCaptureReleaseCompatibility(originalBlocks,unchangedBlocks).originalCaptureUnchanged,true);
  unchangedBlocks.files.find(f=>f.path==="src/server/notion/blocks.ts")!.sha256=createHash("sha256").update(await readFile(new URL("../src/server/notion/blocks.ts",import.meta.url))).digest("hex");
  assert.throws(()=>checkCaptureReleaseCompatibility(originalBlocks,unchangedBlocks),{code:"RELEASE_INVALID"});
  for(const path of ["scripts/website-sync/collection-source-proof.ts","contracts/website-sync.ts","package-lock.json"]){
    const changed=structuredClone(consumer);changed.files.push({path,sha256:"0".repeat(64)});
    assert.throws(()=>checkCaptureReleaseCompatibility(producer,changed),{code:"RELEASE_INVALID"});
  }
});

for (const path of ["database/capture-proof-compatibility.json", "database/capture-media-reuse-compatibility.json"]) test(`${path} admits only pinned runtime changes`, async () => {
  const { readFile } = await import("node:fs/promises"), { createHash } = await import("node:crypto");
  const spec = JSON.parse(await readFile(new URL("../" + path, import.meta.url), "utf8"));
  const base = { nodePath: "/node", nodeVersion: "24.21.0", nodeSha256: "a".repeat(64) };
  const producer = { ...base, commit: spec.producerCommit, files: spec.files.filter((p:{before:string|null})=>p.before!==null).map((p:{path:string;before:string})=>({path:p.path,sha256:p.before})) };
  const consumer = { ...base, commit: "d".repeat(40), files: [...spec.files.map((p:{path:string;after:string})=>({path:p.path,sha256:p.after})), { path, sha256: "b".repeat(64) }] };
  assert.equal(checkCaptureReleaseCompatibility(producer, consumer).format, path.includes("media-reuse") ? "capture-bounded-media-reuse-compatibility-v1" : "capture-versioned-proof-compatibility-v1");
  for(const pair of spec.files) {
    const current=createHash("sha256").update(await readFile(new URL("../"+pair.path,import.meta.url))).digest("hex");
    if(laterRecoveryRuntime(pair.path,current,pair.after,producer,consumer)||laterPublicationRepair(pair.path,current,pair.after,producer,consumer))continue;
    // New website/development capabilities remain outside these frozen transitions.
    // Pin the current cloud-preview launcher without admitting it into the old capture runtime.
    const expected = pair.path === "scripts/dev-real.mjs"
      ? "0fd0db196fe51324f0824d9a1a2bd6c3fa4245f44c368e4443cbac7904bc918d"
      : pair.path === "src/server/database/cos-storage.ts"
        ? "b49fdc2b2e67a6d5e3f565f63f96ed3f33a7d51a932ffe77f50872b668ac8cc4"
      : pair.path === "src/server/database/cos-config.ts"
        ? "75314feb52e05f2fa6606698e38c9e9abf51cc2ecc12267e71b80e83cb9b866f"
      : pair.path === "src/app/media/v2/[assetId]/route.ts"
        ? "e2e085608893f8e1387a03994581a6b7ce7c8f0169fe3b0177c7f2bafb55b483"
      : pair.path === "src/server/database/runtime.ts"
        ? "53c58db7e384010581671d858832595535210736d705c9a87df0965e133d59e1"
      : pair.path === "src/server/media/thumbnail.ts"
        ? "d8daa3226e30451f36dee6637537141b8a5d3632583a90400e77a1a7fc6dab54"
        : null;
    if(expected) {
      assert.equal(current,expected,pair.path);
      const newerReader=structuredClone(consumer);newerReader.files.find((file:{path:string})=>file.path===pair.path).sha256=current;
      assert.throws(()=>checkCaptureReleaseCompatibility(producer,newerReader),{code:"RELEASE_INVALID"});
    } else assert.equal(current,pair.after,pair.path);
  }
  for (const pair of spec.files) {
    const changed = structuredClone(consumer);
    changed.files.find((file: { path: string }) => file.path === pair.path)!.sha256 = "0".repeat(64);
    assert.throws(() => checkCaptureReleaseCompatibility(producer, changed), { code: "RELEASE_INVALID" }, pair.path);
  }
  for (const mutate of [
    (v: typeof consumer) => { v.files[0].sha256 = "0".repeat(64); },
    (v: typeof consumer) => { v.files.splice(1, 1); },
    (v: typeof consumer) => { v.files.push({ path: "scripts/website-sync/worker.ts", sha256: "0".repeat(64) }); },
    (v: typeof consumer) => { v.files.push({ path: "src/server/notion/website-repository.ts", sha256: "0".repeat(64) }); },
    (v: typeof consumer) => { v.files.push({ path: "src/server/database/shared-reader-pool.ts", sha256: "0".repeat(64) }); },
  ]) {
    const changed = structuredClone(consumer); mutate(changed);
    assert.throws(() => checkCaptureReleaseCompatibility(producer, changed), { code: "RELEASE_INVALID" });
  }
});
