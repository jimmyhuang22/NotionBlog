import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReaderIsolationRelease } from "../src/server/database/reader-isolation-release.ts";
const evidence = "a".repeat(64);
test("release declarations reject premature enforcement and forgotten enforcement after verification", () => {
  for(const mode of ["unset","off"]) assert.deepEqual(checkReaderIsolationRelease({phase:"deferred",mode}),{phase:"deferred",mode:"off"});
  assert.deepEqual(checkReaderIsolationRelease({phase:"verified",mode:"enforce",evidenceSHA256:evidence}),{phase:"verified",mode:"enforce"});
  for(const input of [null,[],{}, {phase:"deferred"},{phase:"verified",mode:"off",evidenceSHA256:evidence},
    {phase:"verified",mode:"unset",evidenceSHA256:evidence},{phase:"deferred",mode:"enforce"},{phase:"unknown",mode:"off"},
    {phase:"verified",mode:"enforce"},{phase:"verified",mode:"enforce",evidenceSHA256:"bad"},
    {phase:"deferred",mode:"off",evidenceSHA256:evidence},{phase:"deferred",mode:"off",unexpected:"private"},
    ...["",undefined,false,{},"OFF"].map(mode=>({phase:"deferred",mode}))]) {
    assert.throws(()=>checkReaderIsolationRelease(input),{code:"READER_ISOLATION_RELEASE_INVALID"});
  }
});
test("release CLI is offline, checks only its explicit declaration and sanitizes invalid arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(),"reader-release-"));
  try {
    await writeFile(join(directory,".env"),"DATABASE_READER_ISOLATION=enforce\n",{mode:0o600});
    const script=fileURLToPath(new URL("../scripts/check-reader-isolation-release.ts",import.meta.url));
    const guard=fileURLToPath(new URL("../scripts/development/offline-network.cjs",import.meta.url));
    const run=(args:string[])=>promisify(execFile)(process.execPath,["--require",guard,script,...args],{
      cwd:directory,env:{PATH:process.env.PATH,NODE_ENV:"test",NOTIONBLOG_DEVELOPMENT_MODE:"offline",DATABASE_READER_ISOLATION:"enforce"},timeout:10000,
    });
    assert.deepEqual(JSON.parse((await run(["--phase","deferred","--mode","unset"])).stdout),{phase:"deferred",mode:"off"});
    const good=await run(["--phase","verified","--mode","enforce","--evidence-sha256",evidence]);
    assert.deepEqual(JSON.parse(good.stdout),{phase:"verified",mode:"enforce"});assert.equal(good.stdout.includes(evidence),false);
    assert.match((await run(["--help"])).stdout,/declaration/);
    for(const args of [[],["--phase","deferred"],["--phase","deferred","--mode","enforce"],
      ["--phase","deferred","--mode","off","--mode","off"],
      ["--phase","deferred","--mode","off","--private","private-value"],
      ["--phase","verified","--mode","enforce","--evidence-sha256","private-value"]]) {
      await assert.rejects(run(args),error=>{
        const e=error as {code?:number;stdout?:string;stderr?:string};assert.equal(e.code,2);assert.equal(e.stdout,"");
        assert.equal(e.stderr,"READER_ISOLATION_RELEASE_INVALID\n");return true;
      });
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
