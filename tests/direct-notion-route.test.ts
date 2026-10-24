import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
test("actual direct m1 route requires central policy and returns checked bytes instead of a redirect",async()=>{
  const result=await promisify(execFile)(process.execPath,["--conditions=react-server",fileURLToPath(new URL("./helpers/direct-notion-route.ts",import.meta.url))],{timeout:15000});
  assert.deepEqual(JSON.parse(result.stdout),{missingBinding:true,missingCapability:true,bytes:true,withdrawal:true,versionRace:true});
});
