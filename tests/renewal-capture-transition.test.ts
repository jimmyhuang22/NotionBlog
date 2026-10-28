import test from "node:test";
import assert from "node:assert/strict";
import { checkCaptureReleaseCompatibility } from "../scripts/website-sync/capture-release-compatibility.ts";
import renewalRepair from "../database/capture-renewal-timeout-compatibility.json" with { type: "json" };
import { zeroRetryRuntimeSources } from "./helpers/zero-retry-runtime-sources.ts";

test("the pinned renewal repair preserves an existing transition and rejects every unreviewed difference", async () => {
  const {readFile}=await import("node:fs/promises"),{createHash}=await import("node:crypto");
  const spec=JSON.parse(await readFile(new URL("../database/capture-media-reuse-compatibility.json",import.meta.url),"utf8"));
  const common={nodePath:"/node",nodeVersion:"24.21.0",nodeSha256:"a".repeat(64)};
  const producer={...common,commit:spec.producerCommit,files:[...spec.files.filter((f:{before:string|null})=>f.before!==null).map((f:{path:string;before:string})=>({path:f.path,sha256:f.before})),{path:renewalRepair.path,sha256:renewalRepair.before}]};
  const consumer={...common,commit:"b".repeat(40),files:[...spec.files.map((f:{path:string;after:string})=>({path:f.path,sha256:f.after})),
    {path:"database/capture-media-reuse-compatibility.json",sha256:"c".repeat(64)},
    {path:renewalRepair.path,sha256:renewalRepair.after},
    {path:"database/capture-renewal-timeout-compatibility.json",sha256:"d".repeat(64)}]};
  const actualRenewal = createHash("sha256").update(await readFile(new URL("../"+renewalRepair.path,import.meta.url))).digest("hex");
  assert.equal(actualRenewal,zeroRetryRuntimeSources[renewalRepair.path]);
  assert.equal(checkCaptureReleaseCompatibility(producer,consumer).format,"capture-bounded-media-reuse-compatibility-v1");
  const zeroRetry = structuredClone(consumer);
  zeroRetry.files.find(f=>f.path===renewalRepair.path)!.sha256=actualRenewal;
  assert.throws(()=>checkCaptureReleaseCompatibility(producer,zeroRetry),{code:"RELEASE_INVALID"});
  for(const path of [renewalRepair.path,"src/server/notion/blocks.ts","src/server/notion/website-repository.ts","scripts/website-sync/worker.ts","contracts/content.ts","package-lock.json"]){
    const changed=structuredClone(consumer),row=changed.files.find(f=>f.path===path);
    if(row)row.sha256="0".repeat(64);else changed.files.push({path,sha256:"0".repeat(64)});
    assert.throws(()=>checkCaptureReleaseCompatibility(producer,changed),{code:"RELEASE_INVALID"},path);
  }
  const alteredProducer=structuredClone(producer);alteredProducer.files.find(f=>f.path===renewalRepair.path)!.sha256="0".repeat(64);
  assert.throws(()=>checkCaptureReleaseCompatibility(alteredProducer,consumer),{code:"RELEASE_INVALID"});
  const missingSpec=structuredClone(consumer);missingSpec.files=missingSpec.files.filter(f=>f.path!=="database/capture-renewal-timeout-compatibility.json");
  assert.throws(()=>checkCaptureReleaseCompatibility(producer,missingSpec),{code:"RELEASE_INVALID"});
});
