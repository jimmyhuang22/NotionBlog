import test from "node:test";
import assert from "node:assert/strict";
import { spawn,execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod,mkdtemp,mkdir,readFile,realpath,rm,stat,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { MAC_LAUNCHER_BUNDLE,macLauncherSource,prepareNativeLauncher,prepareExistingBridgeLauncher } from "../scripts/social-sync/native-launcher.ts";
import { nativeFrame,readNativeMessage } from "../scripts/social-sync/native-host.ts";

const origin="chrome-extension://"+"a".repeat(32)+"/";
const macOnly={skip:process.platform!=="darwin"};
const run=promisify(execFile);
async function fixture(t:{after:(f:()=>Promise<void>)=>void}){
  const root=await realpath(await mkdtemp(join(tmpdir(),"nb-native-launcher-")));await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=join(root,"data"),directory=join(root,"package");await mkdir(runtime,{mode:0o700});
  return {root,runtime,directory,node:process.execPath,host:fileURLToPath(new URL("../scripts/social-sync/native-host.ts",import.meta.url)),origin};
}
async function message(path:string,args:string[],value:unknown,env=process.env){
  const child=spawn(path,args,{stdio:["pipe","pipe","pipe"],env});let output=Buffer.alloc(0),stderr="",timedOut=false;
  // Native launch plus cold TypeScript imports can exceed five seconds under
  // CI load. Keep a finite watchdog, without treating startup as a speed test.
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    child.once("close",(code,signal)=>resolve({code,signal}));child.once("error",reject);
  });
  child.stdout.on("data",b=>{output=Buffer.concat([output,b]);});
  child.stderr.on("data",b=>{stderr=(stderr+b.toString()).slice(-8192);});
  child.stdin.on("error",()=>{});child.stdin.write(nativeFrame(value));
  const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},30000);
  try{const result=await closed;return {...result,output,diagnostic:JSON.stringify({...result,timedOut,stderr})};}
  finally{clearTimeout(timer);child.stdin.destroy();}
}

test("launcher input cannot turn paths or origins into C source or arguments",()=>{
  const input={directory:"/example/package",node:"/example/node",host:"/example/中文 '\" $(echo hi).ts",runtime:"/example/data \\ example",origin};
  const source=macLauncherSource(input);
  assert(!source.includes(input.host));assert(!source.includes("$(echo hi)"));
  for(const bad of [{...input,node:"node"},{...input,host:"/example/../escape"},{...input,host:"/example/\\module.ts"},{...input,runtime:"/example/data\n"},{...input,origin:origin+'";exit(0);//'}])assert.throws(()=>macLauncherSource(bad),{code:"USAGE"});
});

test("generated host pins origin, preserves actual framed settings and exits with stdin open",async t=>{
  const f=await fixture(t);await writeFile(join(f.runtime,"bridge-config.json"),JSON.stringify({version:1,origin,enabled:false}),{mode:0o600});
  const launcher=await prepareNativeLauncher(f);
  assert.equal(launcher.kind,process.platform==="darwin"?"mac-app":"shell");
  assert.equal((await stat(launcher.path)).mode&0o077,0);
  const reply=await message(launcher.path,[origin],{op:"settings"},{...process.env,NODE_OPTIONS:"--require /example/missing.cjs",NODE_PATH:"/example/foreign-modules"});
  assert.equal(reply.code,0,reply.diagnostic);assert.deepEqual(await readNativeMessage(Readable.from([reply.output])),{enabled:false,periodMinutes:15,cadenceHours:24});
  for(const args of [[],[origin.replaceAll("a","b")],[origin,"/example/extra"]]){
    const denied=await message(launcher.path,args,{op:"settings"});assert.equal(denied.code,64,denied.diagnostic);assert.equal(denied.output.length,0);
  }
  await assert.rejects(prepareNativeLauncher(f),{code:"REFRESH_PACKAGE_EXISTS"});
  const review=JSON.parse(await readFile(join(f.directory,"native-launcher-review.json"),"utf8"));assert.equal(review.installed,false);assert.equal(review.enabled,false);
  if(process.platform==="darwin")await run("/usr/bin/codesign",["--verify","--strict",join(f.directory,MAC_LAUNCHER_BUNDLE)]);
});

test("adapter recovery reuses the extension identity without changing enabled state or installed files",async t=>{
  const f=await fixture(t),before=JSON.stringify({version:1,origin,enabled:true});
  await writeFile(join(f.runtime,"bridge-config.json"),before,{mode:0o600});
  const result=await prepareExistingBridgeLauncher(f.runtime,f.directory);
  assert.deepEqual(result,{kind:process.platform==="darwin"?"mac-app":"shell",originReused:true,installed:false,enabled:false});
  assert.equal(await readFile(join(f.runtime,"bridge-config.json"),"utf8"),before);
  const native=JSON.parse(await readFile(join(f.directory,"com.notionblog.social_refresh.json"),"utf8"));
  assert.deepEqual(native.allowed_origins,[origin]);
  const actual=await message(native.path,[origin],{op:"settings"});assert.equal(actual.code,0,actual.diagnostic);assert.equal((await readNativeMessage(Readable.from([actual.output])) as {enabled:boolean}).enabled,true);
  const saved=await readFile(native.path);
  await assert.rejects(prepareExistingBridgeLauncher(f.runtime,f.directory),{code:"REFRESH_PACKAGE_EXISTS"});
  assert.deepEqual(await readFile(native.path),saved);assert.equal(await readFile(join(f.runtime,"bridge-config.json"),"utf8"),before);
});

test("Mac launcher treats unusual UTF-8 paths as data and forwards termination to its child",macOnly,async t=>{
  const f=await fixture(t),odd=join(f.root,"中文 ' \" \\ $(example)");await mkdir(odd,{mode:0o700});
  const host=join(f.root,"child 中文 ' \" $(example).mjs"),runtime=odd;
  await writeFile(host,`import {writeFileSync} from "node:fs";import {join} from "node:path";
process.on("SIGTERM",()=>process.exit(42));
writeFileSync(join(process.argv[2],"ready.json"),JSON.stringify({args:process.argv.slice(2),nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null}),{mode:0o600});
setInterval(()=>{},1000);
`,{mode:0o600});
  const launcher=await prepareNativeLauncher({...f,host,runtime});
  const child=spawn(launcher.path,[origin],{stdio:["pipe","pipe","pipe"],env:{...process.env,NODE_OPTIONS:"--require /example/missing.cjs",NODE_PATH:"/example/foreign-modules"}});
  let stderr="";child.stderr.on("data",b=>{stderr+=b.toString();});
  const closed=new Promise<number|null>((resolve,reject)=>{child.once("close",resolve);child.once("error",reject);});
  const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
  try{
    let ready:Record<string,unknown>|null=null;
    for(let i=0;i<100;i++){
      try{ready=JSON.parse(await readFile(join(odd,"ready.json"),"utf8"));break;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      await new Promise(r=>setTimeout(r,20));
    }
    assert(ready,stderr||"Child did not become ready");
    assert.deepEqual(ready,{args:[runtime,origin],nodeOptions:null,nodePath:null});
    child.kill("SIGTERM");assert.equal(await closed,42);
  }finally{clearTimeout(timer);child.kill("SIGTERM");child.stdin.destroy();}
});
