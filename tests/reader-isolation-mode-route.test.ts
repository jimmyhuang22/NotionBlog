import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
for(const mode of ["unset","off","enforce","invalid"])test(`production database route uses the declared reader isolation mode: ${mode}`,async()=>{
  const guard=fileURLToPath(new URL("../scripts/development/offline-network.cjs",import.meta.url));
  const helper=fileURLToPath(new URL("./helpers/reader-isolation-mode-route.ts",import.meta.url));
  const result=await promisify(execFile)(process.execPath,["--require",guard,"--conditions=react-server",helper,mode],{
    env:{PATH:process.env.PATH,NODE_ENV:"production",NOTIONBLOG_DEVELOPMENT_MODE:"offline"},timeout:20000,
  });
  assert.deepEqual(JSON.parse(result.stdout),{mode,verified:true});
});
