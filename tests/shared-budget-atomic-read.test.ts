import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, chmod, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

for (const mode of ["advance", "stop", "repeated", "permissions", "hardlink"]) {
  test(`atomic ledger replacement: ${mode}`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "budget-atomic-")));
    await chmod(root, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "probe.mjs");
    const module = new URL("../scripts/website-sync/shared-budget.ts", import.meta.url).href;
    await writeFile(script, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {initializeSharedBudget,openSharedBudget} from ${JSON.stringify(module)};
const root=process.argv[2],mode=process.argv[3];
const limits=Object.fromEntries(['notionRequests','storageRequests','authRequests','imageRequests','httpRequests','notionResponseBytes','storageResponseBytes','authResponseBytes','imageResponseBytes','uploadBodyBytes','sqlRequests','sqlRequestBytes','sqlResponseBytes','cleanupSqlRequests','cleanupSqlRequestBytes','cleanupSqlResponseBytes'].map(k=>[k,1]));
const bridge=initializeSharedBudget(join(root,'ledger'),{format:'qualified-shared-budget-v1',parentPid:process.pid,nonce:randomUUID(),deadline:Date.now()+10000,cleanupMs:200,runtimeSha256:'a'.repeat(64),storageOrigin:'https://storage.test',limits});
const budget=openSharedBudget(bridge),state=join(bridge.directory,'state.json'),open=fs.openSync;
let replacements=0;
fs.openSync=function(path,...args){
 const fd=open.call(this,path,...args);
 if(path===state&&(replacements===0||mode==='repeated')){
  const v=JSON.parse(fs.readFileSync(fd,'utf8'));v.revision++;v.counters.httpRequests=1;
  if(mode==='stop'){v.failure='SHARED_BUDGET_CANCELLED';v.stoppedAt=Date.now();}
  const next=state+'.replacement';fs.writeFileSync(next,JSON.stringify(v),{mode:mode==='permissions'?0o644:0o600});
  fs.renameSync(next,state);replacements++;
  if(mode==='hardlink')fs.linkSync(state,state+'.link');
 }
 return fd;
};
syncBuiltinESMExports();
let code=null,counters=null;
try{counters=budget.read().counters;budget.guard();budget.charge({httpRequests:1});}catch(e){code=e.code;}
console.log(JSON.stringify({code,counters,replacements}));
`, { mode: 0o600 });
    const result = JSON.parse(execFileSync(process.execPath, [script, root, mode], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH } }));
    if (mode === "advance") {
      assert.equal(result.code, "SHARED_BUDGET_LIMIT");
      assert.equal(result.counters.httpRequests, 1);
      assert.equal(result.replacements, 1);
    } else if (mode === "stop") {
      assert.equal(result.code, "SHARED_BUDGET_CANCELLED");
      assert.equal(result.replacements, 1);
    } else {
      assert.equal(result.code, "SHARED_BUDGET_INPUT_INVALID");
      assert.equal(result.replacements, mode === "repeated" ? 3 : 1);
    }
  });
}
