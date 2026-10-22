import test from "node:test";
import assert from "node:assert/strict";
import { checkCaptureReleaseCompatibility } from "../scripts/website-sync/capture-release-compatibility.ts";
import transition from "../database/capture-publication-revalidation-compatibility.json" with { type: "json" };

test("publication repair accepts only its exact frozen producer and reviewed byte pairs",()=>{
  const common={nodePath:"/fixture/node",nodeVersion:"24.21.0",nodeSha256:"d".repeat(64)};
  const untouched=["scripts/website-sync/collection-source-proof.ts","src/server/notion/website-repository.ts","scripts/website-sync/runtime-sql.ts"]
    .map(path=>({path,sha256:"f".repeat(64)}));
  const producer={...common,commit:transition.producerCommit,files:[...transition.files.filter(f=>f.before!==null).map(f=>({path:f.path,sha256:f.before!})),...untouched]};
  const consumer={...common,commit:"b".repeat(40),files:[...transition.files.map(f=>({path:f.path,sha256:f.after})),...untouched,
    {path:"database/capture-publication-revalidation-compatibility.json",sha256:"e".repeat(64)}]};
  const checked=checkCaptureReleaseCompatibility(producer,consumer);
  assert.equal(checked.format,"capture-publication-revalidation-compatibility-v1");assert.equal(checked.originalCaptureUnchanged,true);
  for(const path of [...transition.files.map(f=>f.path),...untouched.map(f=>f.path)]){
    const changed=structuredClone(consumer);changed.files.find(f=>f.path===path)!.sha256="a".repeat(64);
    assert.throws(()=>checkCaptureReleaseCompatibility(producer,changed),{code:"RELEASE_INVALID"},path);
  }
  const forged=structuredClone(producer);forged.files[0].sha256="a".repeat(64);
  assert.throws(()=>checkCaptureReleaseCompatibility(forged,consumer),{code:"RELEASE_INVALID"});
  assert.throws(()=>checkCaptureReleaseCompatibility({...producer,nodeVersion:"24.20.0"},consumer),{code:"RELEASE_INVALID"});
  assert.throws(()=>checkCaptureReleaseCompatibility({...producer,commit:"c".repeat(40)},consumer),{code:"RELEASE_INVALID"});
});
