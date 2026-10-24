import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { initializeSharedBudget, type SharedLimits } from "../../scripts/website-sync/shared-budget.ts";
import { commitCatalogDigest as digest } from "../../scripts/public-cache/commit-catalog.ts";
import { prepareCommitMigration, type CommitRolloutFacts, type CommitRolloutPlan } from "../../scripts/public-cache/commit-rollout.ts";
import type { HostGraph, HostPin } from "../../scripts/public-cache/commit-host-files.ts";
import type { CommitHostManifest, HostSlot } from "../../scripts/public-cache/commit-rollout-host.ts";
import { commitSQL } from "./cache-commit-fixture.ts";

export async function hostFixture(root: string, before: CommitRolloutFacts, after: CommitRolloutFacts, targetSHA256: string, actions: (CommitRolloutPlan["action"] | "inspect")[], leaseClosed = true) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const pin = async (path: string): Promise<HostPin> => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"), private: true });
  const kinds = ["source","social","media","consumer","withdrawal","retention"] as const;
  const actors: HostGraph["actors"] = [];
  for (const kind of kinds) {
    const dir = join(root,kind); await mkdir(dir,{mode:0o700});
    const entry=join(dir,"entry.mjs");await writeFile(entry,"// fictional inactive actor; no business program is started\n",{mode:0o600});
    actors.push({id:kind,kind,entries:[await pin(entry)],locks:[join(dir,"worker.lock")]});
  }
  const state=join(root,"baseline.json");await writeFile(state,JSON.stringify({source:"paused",retention:"stopped"}),{mode:0o600});
  const graph:HostGraph={version:1,actors,lockOrder:actors.flatMap(a=>a.locks),statePins:[await pin(state)]};
  const nonce=randomUUID(),now=Date.now(),closure=join(root,"closure.json");
  await writeFile(closure,JSON.stringify({version:1,scopeNonce:nonce,runtimeSHA256:digest(graph),at:now,expires:now+120000,serverLeaseClosed:leaseClosed,drainedActors:actors.map(a=>a.id)}),{mode:0o600});
  const closurePin=await pin(closure),packagePins=[...actors.flatMap(a=>a.entries),closurePin];
  const limits:SharedLimits={notionRequests:0,storageRequests:0,authRequests:0,imageRequests:0,httpRequests:0,notionResponseBytes:0,storageResponseBytes:0,authResponseBytes:0,imageResponseBytes:0,uploadBodyBytes:0,
    sqlRequests:actions.length*80,sqlRequestBytes:2*1024*1024,sqlResponseBytes:actions.length*(262144+8192),cleanupSqlRequests:4,cleanupSqlRequestBytes:65536,cleanupSqlResponseBytes:65536};
  const budget=initializeSharedBudget(join(root,"budget"),{format:"qualified-shared-budget-v1",parentPid:process.pid,nonce,deadline:now+120000,cleanupMs:20000,runtimeSha256:digest(graph),storageOrigin:"https://fixture.invalid",limits});
  const migration=await commitSQL(),body=prepareCommitMigration(migration),slots:HostSlot[]=[];
  for(const action of actions){
    const prior=[...slots].reverse().find(s=>s.kind==="execute");
    const p:CommitRolloutPlan=action==="inspect"?{...prior!.plan,operation:randomUUID()}:{version:1,operation:randomUUID(),action,environment:"project",targetSHA256,packageSHA256:digest(packagePins),runtimeSHA256:digest(graph),migrationBodySHA256:body.bodySHA256,
      beforeFactsSHA256:digest(action==="install"?before:after),afterFactsSHA256:digest(after),beforeTables:(action==="install"?before:after).tables,afterTables:after.tables};
    slots.push({kind:action==="inspect"?"inspect":"execute",plan:p,authority:{approved:true,nonce:randomUUID(),planSHA256:digest(p),issuedAt:now,startBefore:now+30000,businessEnd:now+120000,cleanupEnd:now+140000,maxConnections:2,maxDriverCalls:80,maxLogicalBytes:262144},...(action==="inspect"?{previousOperation:prior!.plan.operation}:{})});
  }
  const manifest:CommitHostManifest={version:1,root,graph,packagePins,closure:closurePin,budget,maxConnections:actions.length*2,slots};
  return {manifest,approval:{approved:true,manifestSHA256:digest(manifest)},migration,closure,state,pin};
}
