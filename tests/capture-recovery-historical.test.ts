import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkCaptureReleaseCompatibility } from "../scripts/website-sync/capture-release-compatibility.ts";
import { recoveryRuntimeSources } from "./helpers/recovery-runtime-sources.ts";
import { digest } from "./helpers/capture-recovery-fixture.ts";

for (const name of ["requalification", "proof", "media-reuse", "external-video", "publication-revalidation"]) {
  test(`frozen ${name} transition retains its result and rejects the recovery candidate`, async () => {
    const path = `database/capture-${name}-compatibility.json`;
    const spec = JSON.parse(await readFile(new URL("../" + path, import.meta.url), "utf8")) as {
      producerCommit:string; files:{path:string;before:string|null;after:string}[];
    };
    const node = { nodePath:"/fixture/node", nodeVersion:"24.21.0", nodeSha256:"b".repeat(64) };
    const producer = { ...node, commit:spec.producerCommit, files:spec.files.filter(f=>f.before!==null).map(f=>({path:f.path,sha256:f.before!})) };
    const consumer = { ...node, commit:"d".repeat(40), files:[...spec.files.map(f=>({path:f.path,sha256:f.after})),{path,sha256:digest(await readFile(new URL("../"+path,import.meta.url)))}] };
    assert.equal(checkCaptureReleaseCompatibility(producer,consumer).originalCaptureUnchanged,true);
    const files = new Map(consumer.files.map(f=>[f.path,f.sha256]));
    for(const file of recoveryRuntimeSources){
      assert.equal(digest(await readFile(new URL("../"+file.path,import.meta.url))),file.sha256);
      files.set(file.path,file.sha256);
    }
    assert.throws(()=>checkCaptureReleaseCompatibility(producer,{...consumer,files:[...files].map(([path,sha256])=>({path,sha256}))}),{code:"RELEASE_INVALID"});
  });
}
