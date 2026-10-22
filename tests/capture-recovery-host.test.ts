import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, posix } from "node:path";
import { createDemo, DEMO } from "../scripts/notion-sync/demo.ts";
import { createCollectionCapture } from "../scripts/website-sync/collection-capture.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import type { ReviewedRecoveryTransition } from "../scripts/website-sync/capture-recovery-admission.ts";
import { digest, fixtureSources } from "./helpers/capture-recovery-fixture.ts";

const catalogPath = "database/capture-recovery-compatibility.json";
const sourceRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const shim = `import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {runPrivateWebsiteWorker} from './scripts/website-sync/run-private.mjs';
const configFile=process.argv[2],text=await readFile(configFile,'utf8');
try{const result=await runPrivateWebsiteWorker({configFile,mode:'publish',check:true,
sharedBudget:{runtimeSha256:createHash('sha256').update(text).digest('hex'),storageOrigin:'https://storage.example.test',bridge:{}}});
console.log(JSON.stringify(result));}catch(error){console.log(JSON.stringify({code:error.code??'REJECTED'}));process.exitCode=1;}`;

/** Copy current public modules and their local imports, never old Git objects,
 * private runtime inputs or operator overrides. Only the temporary frozen test
 * project gets a synthetic reviewed entry; the real catalog stays empty. */
async function fixture(t: TestContext, kind: ReviewedRecoveryTransition["kind"], courseOnly: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recovery-host-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const producer = join(root, "producer"), consumer = join(root, "consumer"), inputs = join(root, "inputs");
  for (const path of [producer, consumer, inputs]) await mkdir(path, { mode: 0o700 });
  const files = new Map<string, string>();
  const copyModule = async (path: string) => {
    if (files.has(path)) return;
    assert.ok(!path.startsWith("../"));
    const text = await readFile(join(sourceRoot, path), "utf8"); files.set(path, text);
    if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return;
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      await copyModule(posix.normalize(posix.join(posix.dirname(path), match[1])));
    }
  };
  for (const path of ["scripts/website-sync/run-private.mjs", "scripts/website-sync/run.ts", "scripts/website-sync/qualified-budget-cli.ts",
    "scripts/website-sync/shared-budget-preload.ts", "scripts/website-sync/shared-budget-transport.ts",
    "package-lock.json", "database/website-protocol.json", "database/website-media-protocol.json"]) await copyModule(path);
  files.set("fixture-check.mjs", shim);
  for (const project of [producer, consumer]) {
    for (const [path, text] of files) { await mkdir(dirname(join(project, path)), { recursive: true, mode: 0o700 }); await writeFile(join(project, path), text); }
    await symlink(join(sourceRoot, "node_modules"), join(project, "node_modules"));
  }
  // The producer is deliberately synthetic and never executed.
  await writeFile(join(producer, "scripts/website-sync/run.ts"), fixtureSources.producer["scripts/website-sync/run.ts"]);
  const nodePath = await realpath(process.execPath), node = { nodePath, nodeVersion:process.versions.node, nodeSha256:digest(await readFile(nodePath)) };
  const hashes = async (project: string) => Promise.all([...files.keys()].map(async path=>({path,sha256:digest(await readFile(join(project,path)))})));
  const before = await hashes(producer), after = await hashes(consumer);
  const transition: ReviewedRecoveryTransition = { id:"synthetic-host-course", kind, producerCommit:"a".repeat(40),
    nodePathSha256:digest(nodePath), nodeVersion:node.nodeVersion, nodeSha256:node.nodeSha256,
    producerCatalogSha256:before.find(f=>f.path===catalogPath)!.sha256,
    files:before.filter(f=>f.path!==catalogPath).map(f=>({path:f.path,before:f.sha256,after:after.find(a=>a.path===f.path)!.sha256})) };
  await writeFile(join(consumer,catalogPath),JSON.stringify({format:"capture-recovery-catalog-v1",transitions:[transition]}));
  const manifest = async (project: string, commit: string) => {
    const path=join(root,project===producer?"producer-private.json":"consumer-private.json");
    await writeFile(path,JSON.stringify({format:"website-v2-release-1",commit,...node,files:await hashes(project)}),{mode:0o600});return path;
  };
  const producerManifest=await manifest(producer,"a".repeat(40)), consumerManifest=await manifest(consumer,"d".repeat(40));
  const demo=createDemo(2),previous={schemaVersion:2,sources:demo.config.sources.slice(courseOnly?1:0,2)};
  if(kind==="course-rating-removal"){
    previous.sources.find(s=>s.kind==="course")!.fields={title:"Name",recommendation:"Recommendation"};
    demo.schemas.get(DEMO.courses)!.properties.Recommendation={id:"recommendation",name:"Recommendation",description:null,type:"number",number:{format:"number"}};
    demo.pages.get(DEMO.course)!.properties.Recommendation={id:"recommendation",type:"number",number:4};
  }
  const current=structuredClone(previous);current.sources.find(s=>s.kind==="course")!.fields={title:"Name"};
  const previousText=JSON.stringify(previous),currentText=JSON.stringify(current),config=parseWebsiteNotionConfig(previous);
  const runId=randomUUID(),lease={runId,fence:"1",revision:"1",configDigest:configDigest(config),deniedPageIds:[]};
  const state=join(inputs,"state"),directory=join(state,"website-v2",runId,"collection-private");
  await mkdir(dirname(directory),{recursive:true,mode:0o700});
  await runWebsiteSync({config,client:demo.client,mode:"stage",writer:{begin:async()=>lease,renew:async()=>{},stage:async()=>{},promote:async()=>assert.fail(),fail:async()=>{}},
    storage:{put:async()=>assert.fail(),read:async()=>assert.fail()},captureCollection:await createCollectionCapture(directory,{runId,sourceSha256:digest(previousText),configDigest:lease.configDigest,releaseCommit:"a".repeat(40)})});
  const sourcesFile=join(inputs,"current-source.json"),oldSource=join(inputs,"previous-source.json"),readerEnv=join(inputs,"reader.env"),cache=join(root,"cache");
  await mkdir(cache,{mode:0o700});await mkdir(join(inputs,"bin"),{mode:0o700});
  for(const [path,text] of [
    [sourcesFile,currentText],[oldSource,previousText],[readerEnv,'DATABASE_READER_URL="fixture-only"\n'],
    [join(inputs,"notion-readonly.env"),'NOTION_TOKEN="fake"\n'],
    [join(inputs,"supabase-worker.env"),'SYNC_DATABASE_URL="fixture-only"\nSTORAGE_URL="https://storage.example.test"\nSTORAGE_BUCKET="fixture-only"\nSTORAGE_API_KEY="fixture-only"\n'],
    [join(inputs,"refresh-writer-session.mjs"),"throw new Error('No session refresh is allowed');"],
    [join(inputs,"bin/heic-to-jpeg"),"fixture-converter"],
  ])await writeFile(path,text,{mode:0o600});
  const runtime={format:"website-v2-runtime-1",project:consumer,manifest:consumerManifest,privateRoot:inputs,stateDir:state,
    sourcesFile,sourceSha256:digest(currentText),cacheDirectory:cache,readerEnv,
    refreshSha256:digest(await readFile(join(inputs,"refresh-writer-session.mjs"))),converterSha256:digest("fixture-converter"),timeoutSeconds:1,maxMediaBytes:1024,
    captureCollection:true,resumeRunId:runId,resumeIndexSha256:digest(await readFile(join(directory,"index-private.json"))),resumeRequestReserve:1,resumePostSeconds:0,
    resumeQualification:"fresh",resumeRecovery:transition.id,resumeConsumerManifestSha256:digest(await readFile(consumerManifest)),
    resumeProducer:{project:producer,manifest:producerManifest,manifestSha256:digest(await readFile(producerManifest))},
    ...(kind==="course-rating-removal"?{resumeSource:{file:oldSource,sha256:digest(previousText)}}:{})};
  const configFile=join(inputs,"runtime-private.json");
  const invoke=async(value:unknown=runtime)=>{
    await writeFile(configFile,JSON.stringify(value),{mode:0o600});
    return new Promise<{code:number|null;out:string;err:string}>((done,reject)=>{
      const child=spawn(nodePath,["--require",join(sourceRoot,"scripts/development/offline-network.cjs"),"--conditions=react-server",join(consumer,"fixture-check.mjs"),configFile],
        {cwd:consumer,env:{PATH:"/usr/bin:/bin",NODE_ENV:"test",NOTIONBLOG_DEVELOPMENT_MODE:"offline"},stdio:["ignore","pipe","pipe"]});
      let out="",err="";const timer=setTimeout(()=>child.kill("SIGKILL"),20000);
      child.stdout.on("data",data=>{out+=data;});child.stderr.on("data",data=>{err+=data;});child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("close",code=>{clearTimeout(timer);done({code,out,err});});
    });
  };
  return {runtime,invoke,inputs,state,cache,consumer,directory,index:await readFile(join(directory,"index-private.json"))};
}

for(const kind of ["course-rating-removal","course-projection-refresh"] as const)for(const courseOnly of [false,true])test(`frozen host resolves ${kind} (${courseOnly?"course-only":"mixed"}) through its bundled reviewed entry without SQL, session, locks or a child`,async t=>{
  const f=await fixture(t,kind,courseOnly),result=await f.invoke();assert.equal(result.code,0,result.err+result.out);
  const value=JSON.parse(result.out);assert.equal(value.offlineCheck,true);assert.equal(value.networkChecked,false);
  assert.equal(value.workerStarted,false);assert.equal(value.sessionRefreshed,false);assert.equal(value.publicationEnabled,false);
  assert.equal(value.resumePlan.compatibility.kind,kind);assert.equal(value.resumePlan.courseProjectionRefresh.forcedCoursePages,1);
  assert.equal(value.resumePlan.savedPages,courseOnly?0:2);
  assert.deepEqual(await readFile(join(f.directory,"index-private.json")),f.index);
  assert.deepEqual(await readdir(f.cache),[]);assert.deepEqual(await readdir(f.state),["website-v2"]);
  for(const extra of [
    {resumeConsumerManifestSha256:"0".repeat(64)},
    {resumeProducer:{...f.runtime.resumeProducer,manifestSha256:"0".repeat(64)}},
    {resumeRecovery:"unknown"},{resumeQualification:"original"},{resumeIndexSha256:"0".repeat(64)},
    ...(f.runtime.resumeSource?[{resumeSource:{...f.runtime.resumeSource,sha256:"0".repeat(64)}}]:[]),
  ]){
    const rejected=await f.invoke({...f.runtime,...extra});assert.equal(rejected.code,1,rejected.out+rejected.err);
    assert.equal((await readdir(f.inputs)).some(name=>name.endsWith(".lock")),false);
    assert.deepEqual(await readFile(join(f.directory,"index-private.json")),f.index);
  }
  const oldIndex=JSON.parse(f.index.toString());
  await writeFile(join(f.directory,"index-private.json"),JSON.stringify({...oldIndex,pages:[],order:oldIndex.collectionComplete?[]:null}),{mode:0o600});
  const empty=await f.invoke({...f.runtime,resumeIndexSha256:digest(await readFile(join(f.directory,"index-private.json")))});
  assert.equal(empty.code,1,"An actually empty historical capture must still fail");
  await writeFile(join(f.directory,"index-private.json"),f.index,{mode:0o600});
  const actual=JSON.parse(await readFile(join(sourceRoot,catalogPath),"utf8"));assert.deepEqual(actual.transitions,[]);
});
