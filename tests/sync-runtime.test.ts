import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const adapter = new URL("../scripts/notion-sync/run-private.mjs", import.meta.url).pathname;
async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "notionblog-runtime-test-")));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "release"), inputs = join(root, "inputs"), state = join(root, "state");
  for (const path of [project, inputs, state]) await mkdir(path, { mode: 0o700 });
  await mkdir(join(project, "scripts")); await mkdir(join(project, "scripts/notion-sync"));
  await writeFile(join(inputs, "notion-readonly.env"), 'NOTION_TOKEN="fake"\n', { mode: 0o600 });
  await writeFile(join(inputs, "notion-sources.json"), '{}', { mode: 0o600 });
  await writeFile(join(inputs, "supabase-worker.env"), 'SYNC_DATABASE_URL="fixture-only"\nSTORAGE_URL="fixture-only"\nSTORAGE_BUCKET="fixture-only"\nSTORAGE_API_KEY="fixture-only"\nSYNC_MODE="publish"\nSYNC_MEDIA_PROVIDER="storage"\n', { mode: 0o600 });
  await writeFile(join(inputs, "refresh-writer-session.mjs"), `
import {appendFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
export async function refreshWriterSession(path){
 const token=['fixture',Buffer.from(JSON.stringify({exp:Date.now()/1000+3600})).toString('base64url'),'fixture'].join('.');
 await appendFile(path,'STORAGE_WRITE_TOKEN="'+token+'"\\n');
 await writeFile(join(dirname(path),'refreshed'), 'yes', {mode:0o600});
}`, { mode: 0o600 });
  await writeFile(join(project, "scripts/notion-sync/cli.ts"), `
import {readFile,stat} from 'node:fs/promises';import {parseEnv} from 'node:util';
const args=process.argv.slice(2),path=args[args.indexOf('--env')+1],env=parseEnv(await readFile(path,'utf8'));
console.log(JSON.stringify({called:true,mode:args[args.indexOf('--mode')+1],provider:env.SYNC_MEDIA_PROVIDER,
sourceFile:!!env.NOTION_SOURCES_CONFIG,inlineSources:!!env.NOTION_SOURCES_JSON,permissions:(await stat(path)).mode&511,
inheritedSecret:!!process.env.HOST_SECRET_EXAMPLE}));
`);
  return { root, project, inputs, state, args: [adapter, "--project", project, "--private-root", inputs, "--state-dir", state] };
}
async function invoke(args:string[]) {
  return new Promise<{code:number|null;out:string;err:string}>((resolve,reject) => {
    const child=spawn(process.execPath,args,{env:{...process.env,HOST_SECRET_EXAMPLE:"fixture-only"},stdio:["ignore","pipe","pipe"]});
    let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
    child.once("error",reject);child.once("close",code=>resolve({code,out,err}));
  });
}
async function cleanInputs(inputs:string) {
  assert.equal((await readdir(inputs)).some(n=>n==="manual-run.lock"||n.startsWith(".runtime-env-")),false);
}

test("host check is offline and does not rotate sessions or start a worker",async t=>{
  const f=await fixture(t),r=await invoke([...f.args,"--mode","publish","--media-provider","notion","--check"]);
  assert.equal(r.code,0);assert.equal(JSON.parse(r.out).offlineCheck,true);
  assert.equal(JSON.parse(r.out).networkChecked,false);
  assert.equal((await readdir(f.inputs)).includes("refreshed"),false);await cleanInputs(f.inputs);
});
test("host default stays dry-run and explicit hybrid mode reaches the child without inherited secrets",async t=>{
  const f=await fixture(t),r=await invoke([...f.args,"--media-provider","notion"]);
  assert.equal(r.code,0);const child=JSON.parse(r.out.split("\n")[0]);
  assert.equal(child.mode,"dry-run");assert.equal(child.provider,"notion");assert.equal(child.permissions,0o600);
  assert.equal(child.sourceFile,true);assert.equal(child.inlineSources,false);assert.equal(child.inheritedSecret,false);
  assert.equal((await readdir(f.inputs)).includes("refreshed"),false);await cleanInputs(f.inputs);
});
test("publish refreshes the authoritative file before launching and cleans private temporary inputs",async t=>{
  const f=await fixture(t),r=await invoke([...f.args,"--mode","publish","--media-provider","notion"]);
  assert.equal(r.code,0);assert.equal(JSON.parse(r.out.split("\n")[0]).mode,"publish");
  assert.equal(await readFile(join(f.inputs,"refreshed"),"utf8"),"yes");await cleanInputs(f.inputs);
});
for(const existing of ["manual","worker","session"]){
 test(`host refuses an existing ${existing} lock before rotating Auth`,async t=>{
  const f=await fixture(t),path=existing==="manual"?join(f.inputs,"manual-run.lock"):
   existing==="worker"?join(f.state,"worker.lock"):join(f.inputs,"writer-session.lock");
  await writeFile(path,"do not steal",{mode:0o600});
  const r=await invoke([...f.args,"--mode","publish"]);assert.equal(r.code,75);assert.match(r.err,/RUN_BUSY/);
  assert.equal(await readFile(path,"utf8"),"do not steal");assert.equal((await readdir(f.inputs)).includes("refreshed"),false);
 });
}
test("host rejects a symlink credential and a permissive input root",async t=>{
  const f=await fixture(t),path=join(f.inputs,"notion-readonly.env");
  await rm(path);await symlink(join(f.inputs,"supabase-worker.env"),path);
  const linked=await invoke([...f.args,"--check"]);assert.equal(linked.code,1);
  await chmod(f.inputs,0o755);const loose=await invoke([...f.args,"--check"]);
  assert.equal(loose.code,1);assert.match(loose.err,/PRIVATE_DIRECTORY_INVALID/);await cleanInputs(f.inputs);
});
test("terminating the host forwards cancellation and waits for child cleanup",async t=>{
  const f=await fixture(t);
  await writeFile(join(f.project,"scripts/notion-sync/cli.ts"), `
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',()=>{clearInterval(timer);process.exitCode=23;});
console.log('READY');`);
  const child=spawn(process.execPath,f.args,{stdio:["ignore","pipe","pipe"]});
  let out="",err="";
  child.stderr.on("data",b=>{err=(err+b.toString()).slice(-4096);});
  const completed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
   child.once("close",(code,signal)=>resolve({code,signal}));child.once("error",reject);
  });
  t.after(async()=>{child.kill("SIGKILL");await completed.catch(()=>{});});
  const ready=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Worker did not start"));},5000);
   child.stdout.on("data",b=>{out=(out+b.toString()).slice(-4096);
    if(out.includes("READY")){clearTimeout(timer);resolve();}});
   completed.then(result=>{clearTimeout(timer);reject(new Error(`Host exited before READY: ${JSON.stringify(result)} ${err}`));},
    error=>{clearTimeout(timer);reject(error);});
  });
  await ready;assert.equal(child.kill("SIGTERM"),true);const result=await completed;
  await cleanInputs(f.inputs);assert.deepEqual(result,{code:23,signal:null},err);
});
