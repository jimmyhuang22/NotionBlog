import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, chmod, mkdir, writeFile, readFile, rm, copyFile, readdir, symlink, cp } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import https from "node:https";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { initializeSharedBudget, openSharedBudget, type SharedLimits } from "../scripts/website-sync/shared-budget.ts";
import { installSharedTransports } from "../scripts/website-sync/shared-budget-transport.ts";
import { parseQualifiedBudgetInput } from "../scripts/website-sync/qualified-budget-cli.ts";

const rootProject = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const digest = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const limits: SharedLimits = { notionRequests: 10, storageRequests: 10, authRequests: 10, imageRequests: 10, httpRequests: 20,
  notionResponseBytes: 4096, storageResponseBytes: 4096, authResponseBytes: 4096, imageResponseBytes: 4096, uploadBodyBytes: 4096,
  sqlRequests: 10, sqlRequestBytes: 4096, sqlResponseBytes: 4096, cleanupSqlRequests: 4, cleanupSqlRequestBytes: 4096, cleanupSqlResponseBytes: 4096 };
async function privateRoot(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shared-budget-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function ledger(t: TestContext, overrides: Partial<SharedLimits> = {}, ms = 10000) {
  const root = await privateRoot(t), bridge = initializeSharedBudget(join(root, "ledger"), { format: "qualified-shared-budget-v1", parentPid: process.pid,
    nonce: randomUUID(), runtimeSha256: "a".repeat(64), storageOrigin: "https://storage.test", deadline: Date.now() + ms, cleanupMs: 200, limits: { ...limits, ...overrides } });
  return { root, bridge, budget: openSharedBudget(bridge) };
}
async function invoke(node: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const child = spawn(node, args, { env: { NODE_ENV: "test", PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    child.stdout.on("data", x => { out += x; }); child.stderr.on("data", x => { err += x; });
    child.once("error", reject); child.once("close", code => done({ code, out, err }));
  });
}
test("parent and actual direct child consume one durable cap; failure cannot reset or refund", async t => {
  const f = await ledger(t, { httpRequests: 2, notionRequests: 2 }); f.budget.charge({ httpRequests: 1, notionRequests: 1 });
  const script = join(f.root, "child.ts");
  await writeFile(script, `import {openSharedBudget} from ${JSON.stringify(join(rootProject, "scripts/website-sync/shared-budget.ts"))};const b=openSharedBudget(JSON.parse(process.argv[2]));b.charge({httpRequests:1,notionRequests:1});console.log(b.read().counters.httpRequests);`, { mode: 0o600 });
  const result = await invoke(process.execPath, [script, JSON.stringify(f.bridge)]); assert.equal(result.code, 0, result.err); assert.equal(result.out.trim(), "2");
  assert.throws(() => f.budget.charge({ httpRequests: 1, notionRequests: 1 }), /SHARED_BUDGET_LIMIT/);
  assert.equal(openSharedBudget(f.bridge).read().counters.httpRequests, 2);
  assert.throws(() => openSharedBudget(f.bridge).guard(), /SHARED_BUDGET_LIMIT/);
  assert.throws(() => initializeSharedBudget(f.bridge.directory, f.budget.plan), /EEXIST/);
});
test("lock contention and replaced input fail closed without deleting another owner's lock", async t => {
  const f = await ledger(t), path = join(f.bridge.directory, "ledger.lock"); await writeFile(path, "another owner", { mode: 0o600 });
  assert.throws(() => f.budget.charge({ httpRequests: 1 }), /SHARED_BUDGET_LOCK_BUSY/); assert.equal(await readFile(path, "utf8"), "another owner");
  assert.equal(f.budget.read().counters.httpRequests, 0); await rm(path);
  await chmod(join(f.bridge.directory, "plan.json"), 0o644); assert.throws(() => openSharedBudget(f.bridge), /SHARED_BUDGET_INPUT_INVALID/);
});
test("failed auth and ignored storage response bodies are charged; unknown uploads and redirects never get transport", async t => {
  const f = await ledger(t); let calls = 0;
  const transport = installSharedTransports(f.budget, { fetch: async (_url, options) => { calls++; assert.equal(options?.redirect, "error");
    return new Response("rejected", { status: 401 }); }, sql: [] }); t.after(() => transport.restore());
  const response = await fetch("https://storage.test/auth/v1/token", { method: "POST", body: "token" }); assert.equal(response.status, 401);
  assert.equal(f.budget.read().counters.authResponseBytes, 8); assert.equal(f.budget.read().counters.storageResponseBytes, 0);
  await fetch("https://storage.test/storage/v1/object/fixture", { method: "POST", body: "bytes" });
  assert.equal(f.budget.read().counters.storageResponseBytes, 8); assert.equal(f.budget.read().counters.uploadBodyBytes, 10);
  await assert.rejects(fetch("https://storage.test/upload", { method: "POST", body: new ReadableStream() as unknown as BodyInit }), /SHARED_BUDGET_BODY_INVALID/);
  assert.equal(calls, 2); assert.equal(f.budget.read().failure, "SHARED_BUDGET_BODY_INVALID");
});
test("actual received over-limit and late cancellation chunks remain on ledger; further attempts are blocked", async t => {
  const f = await ledger(t, { notionResponseBytes: 3 }); let calls = 0;
  const transport = installSharedTransports(f.budget, { fetch: async () => { calls++; return new Response("12345"); }, sql: [] }); t.after(() => transport.restore());
  await assert.rejects(fetch("https://api.notion.com/v1/pages"), /SHARED_BUDGET_LIMIT/); assert.equal(f.budget.read().counters.notionResponseBytes, 5);
  assert.throws(() => f.budget.observe({ notionResponseBytes: 2 }), /SHARED_BUDGET_LIMIT/); assert.equal(f.budget.read().counters.notionResponseBytes, 7);
  await assert.rejects(fetch("https://api.notion.com/v1/pages"), /SHARED_BUDGET_LIMIT/); assert.equal(calls, 1);
});
test("native HTTPS preserves pinned IP, logical Host/SNI and named imports while charging stream production", async t => {
  const f = await ledger(t); let calls = 0;
  const native = ((options: https.RequestOptions, callback: (r: unknown) => void) => {
    calls++; assert.equal(options.hostname, "203.0.113.9"); assert.equal(options.servername, "image.test");
    assert.deepEqual(options.headers, { Host: "image.test" }); assert.equal(options.rejectUnauthorized, true);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => { const response = new PassThrough(); callback(response); response.end("image"); response.on("end", () => req.emit("close")); };
    return req;
  }) as typeof https.request;
  const transport = installSharedTransports(f.budget, { request: native, sql: [] }); t.after(() => transport.restore());
  const { request } = await import("node:https");
  await new Promise<void>((done, reject) => { const req = request({ hostname: "203.0.113.9", servername: "image.test", headers: { Host: "image.test" }, rejectUnauthorized: true }, r => { r.once("error", reject); r.resume(); r.once("end", done); }); req.once("error", reject); req.end(); });
  await transport.drain(); assert.equal(calls, 1); assert.equal(f.budget.read().counters.imageResponseBytes, 5); assert.equal(f.budget.read().counters.imageRequests, 1);
});
test("SQL promise and callback ports count before transport, and only exact fenced cleanup survives stop", async t => {
  const f = await ledger(t, { sqlRequests: 1, cleanupSqlRequests: 1 }); let calls = 0;
  const port = { query(...args: unknown[]) { calls++; const callback = args.at(-1);
    if (typeof callback === "function") { queueMicrotask(() => callback(null, { rows: [{ result: null }] })); return; }
    return Promise.resolve({ rows: [{ result: 1 }] }); } };
  const transport = installSharedTransports(f.budget, { sql: [port] }); t.after(() => transport.restore());
  await port.query("SELECT 1"); assert.throws(() => port.query("SELECT 2"), /SHARED_BUDGET_LIMIT/); assert.equal(calls, 1);
  assert.throws(() => port.query("SELECT nb_v2_api.promote_run($1,$2) AS result", [randomUUID(), 1]), /SHARED_BUDGET_LIMIT/);
  await new Promise<void>((done, reject) => port.query("SELECT nb_v2_api.fail_run($1,$2) AS result", [randomUUID(), 1], (e: unknown) => e ? reject(e) : done()));
  assert.equal(calls, 2); assert.equal(f.budget.read().counters.cleanupSqlRequests, 1); assert.ok(f.budget.read().counters.cleanupSqlResponseBytes > 0);
  assert.throws(() => port.query("SELECT nb_v2_api.fail_run($1,$2) AS result", [randomUUID(), 1]), /SHARED_BUDGET_LIMIT/); assert.equal(calls, 2);
  await transport.drain();
});
test("absolute deadline and bounded cleanup cannot be extended or used for session refresh", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = await ledger(t, {}, -1); assert.throws(() => f.budget.guard(), /SHARED_BUDGET_DEADLINE/);
  f.budget.charge({ cleanupSqlRequests: 1 }, true); assert.throws(() => f.budget.charge({ storageRequests: 1 }), /SHARED_BUDGET_DEADLINE/);
  now += 210; assert.throws(() => f.budget.charge({ cleanupSqlRequests: 1 }, true), /SHARED_BUDGET_DEADLINE/);
});
test("actual runtime Notion SDK and pinned image downloader use the installed ports and share byte counters", async t => {
  const f = await ledger(t); let sourceCalls = 0, imageCalls = 0;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
  const json = JSON.stringify({ object: "list", results: [], has_more: false, next_cursor: null });
  const native = ((options: https.RequestOptions, callback: (r: unknown) => void) => {
    imageCalls++; assert.equal(options.hostname, "93.184.216.34"); assert.equal(options.servername, "image.test"); assert.equal(options.rejectUnauthorized, true);
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }; req.destroy = () => { req.emit("close"); };
    req.end = () => { const response = Object.assign(new PassThrough(), { headers: { "content-type": "image/png", "content-length": String(png.length) }, statusCode: 200, complete: true });
      callback(response); queueMicrotask(() => response.end(png)); response.once("end", () => req.emit("close")); }; return req;
  }) as typeof https.request;
  const transport = installSharedTransports(f.budget, { fetch: async () => { sourceCalls++; return new Response(json, { headers: { "content-type": "application/json" } }); }, request: native, sql: [] }); t.after(() => transport.restore());
  const { createRuntimeNotionReader } = await import("../scripts/website-sync/runtime-reader.ts");
  const reader = createRuntimeNotionReader({ token: "fixture" }, new AbortController().signal);
  assert.deepEqual(await reader.client.listBlocks("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), []);
  const { createWebsiteImageDownloader } = await import("../scripts/website-sync/download.ts");
  const download = createWebsiteImageDownloader({ resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  const image = await download("https://image.test/fixture.png"); assert.deepEqual(Buffer.from(image.bytes), png);
  await transport.drain(); const counters = f.budget.read().counters;
  assert.equal(sourceCalls, 1); assert.equal(imageCalls, 1); assert.equal(counters.httpRequests, 2);
  assert.equal(counters.notionResponseBytes, Buffer.byteLength(json)); assert.equal(counters.imageResponseBytes, png.length);
});
test("a stop during counter-lock contention is durable and blocks the other actor after unlock", async t => {
  const f = await ledger(t), path = join(f.bridge.directory, "ledger.lock"); await writeFile(path, "existing owner", { mode: 0o600 });
  assert.throws(() => f.budget.stop(), /SHARED_BUDGET_LOCK_BUSY/); assert.equal(await readFile(path, "utf8"), "existing owner");
  await rm(path); assert.throws(() => openSharedBudget(f.bridge).charge({ httpRequests: 1 }), /SHARED_BUDGET_CANCELLED/);
  assert.equal(f.budget.read().counters.httpRequests, 0);
});

async function hostFixture(t: TestContext, probe: string) {
  // These fixtures verify host identity/recovery/transport boundaries, not
  // deadline expiry. Leave room for cold imports and manifest checks on the
  // background runner. Dedicated ledger/CLI expiry tests keep their short caps.
  const fixtureSeconds = 120;
  const root = await privateRoot(t), project = join(root, "release"), inputs = join(root, "inputs"), state = join(inputs, "state"), cache = join(root, "cache"), node = join(root, "node");
  for (const path of [project, inputs, state, cache, join(inputs, "bin")]) await mkdir(path, { mode: 0o700 });
  await copyFile(await realpath(process.execPath), node, constants.COPYFILE_FICLONE); await chmod(node, 0o700);
  const tracked = execFileSync("git", ["ls-files"], { cwd: rootProject, encoding: "utf8" }).trim().split("\n");
  const extras = ["shared-budget.ts", "shared-budget-transport.ts", "shared-budget-preload.ts", "qualified-budget-cli.ts", "release.d.mts", "run-private.d.mts", "collection-source-proof.ts", "collection-resume-plan.ts", "capture-release-compatibility.ts"].map(n => "scripts/website-sync/" + n);
  const files = [...new Set([...tracked.filter(p => /^(scripts|src|contracts|database|config|fixtures|adapters)\//.test(p) || /^package(-lock)?\.json$/.test(p)), ...extras, "database/fresh-qualification-protocol.json", "database/capture-requalification-compatibility.json"])];
  for (const path of files) { await mkdir(dirname(join(project, path)), { recursive: true }); await copyFile(join(rootProject, path), join(project, path)); await chmod(join(project, path), 0o644); }
  await symlink(join(rootProject, "node_modules"), join(project, "node_modules"), "dir");
  await writeFile(join(project, "scripts/website-sync/run.ts"), `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';${probe}
const e=process.env;await writeFile(join(e.WEBSITE_OUTPUT_DIR,'receipt-private.json'),JSON.stringify({runId:e.WEBSITE_RUN_ID,mode:'dry-run',published:false,readerVerified:false,promoteRequested:false,outcome:'failed'}),{mode:384});console.log('PROBE_FINISHED');process.exitCode=1;`, { mode: 0o644 });
  const source = "{}", refresh = "export async function refreshWriterSession(){await fetch('https://storage.test/auth/v1/token',{method:'POST',body:'fixture'});}", converter = "fixture";
  for (const [name, text] of Object.entries({ "notion-readonly.env": 'NOTION_TOKEN="fixture"\n', "supabase-worker.env": 'SYNC_DATABASE_URL="fixture"\nSTORAGE_URL="https://storage.test/storage/v1"\nSTORAGE_BUCKET="fixture"\nSTORAGE_API_KEY="fixture"\nNODE_OPTIONS="must-not-forward"\n', "reader.env": 'DATABASE_READER_URL="fixture"\n', "sources.json": source, "refresh-writer-session.mjs": refresh })) await writeFile(join(inputs, name), text, { mode: 0o600 });
  await writeFile(join(inputs, "bin/heic-to-jpeg"), converter, { mode: 0o700 });
  const manifest = join(root, "manifest.json"); await writeFile(manifest, JSON.stringify({ format: "website-v2-release-1", commit: "a".repeat(40), nodePath: node, nodeVersion: process.versions.node, nodeSha256: digest(await readFile(node)), files: await Promise.all(files.map(async path => ({ path, sha256: digest(await readFile(join(project, path))) }))) }), { mode: 0o600 });
  const config = join(root, "runtime.json"), bytes = JSON.stringify({ format: "website-v2-runtime-1", project, manifest, privateRoot: inputs, stateDir: state, sourcesFile: join(inputs, "sources.json"), sourceSha256: digest(source), cacheDirectory: cache, readerEnv: join(inputs, "reader.env"), refreshSha256: digest(refresh), converterSha256: digest(converter), timeoutSeconds: fixtureSeconds, maxMediaBytes: 1024 });
  await writeFile(config, bytes, { mode: 0o600 });
  const budget = join(root, "budget.json"), ledger = join(root, "ledger"); await writeFile(budget, JSON.stringify({ format: "qualified-budget-input-v1", runtimeSha256: digest(bytes), storageOrigin: "https://storage.test", durationMs: fixtureSeconds * 1000, cleanupMs: 200, limits: { ...limits, notionRequests: 0, storageRequests: 0, authRequests: 0, imageRequests: 0, sqlRequests: 0, httpRequests: 0 } }), { mode: 0o600 });
  return { root, project, inputs, state, node, config, budget, ledger, args: [join(project, "scripts/website-sync/qualified-budget-cli.ts"), "--config", config, "--budget", budget, "--ledger", ledger, "--mode", "dry-run"] };
}
test("guarded host default check and digest rejection start no child or ledger and preserve legacy whitelisting", async t => {
  const f = await hostFixture(t, "throw new Error('must not execute');"), checked = await invoke(f.node, f.args);
  assert.equal(checked.code, 0, checked.err); assert.equal(JSON.parse(checked.out).workerStarted, false); assert.equal((await readdir(f.root)).includes("ledger"), false);
  assert.deepEqual(await readdir(f.state), []); await writeFile(f.config, (await readFile(f.config, "utf8")) + " ");
  assert.equal((await invoke(f.node, f.args)).code, 1); assert.equal((await readdir(f.root)).includes("ledger"), false);
});
for (const [name, probe] of Object.entries({
  SDK: "import {Client} from '@notionhq/client';try{await new Client({auth:'fixture',maxRetries:0}).pages.retrieve({page_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});}catch{}",
  HTTPS: "import {request} from 'node:https';try{request({hostname:'203.0.113.9',servername:'image.test',headers:{Host:'image.test'}}).end();}catch{}",
  session: "try{const m=await import(process.env.WEBSITE_PRIVATE_ROOT+'/refresh-writer-session.mjs');await m.refreshWriterSession();}catch{}",
  PG: "import pg from 'pg';try{await new pg.Client({connectionString:'postgresql://fixture:fixture@127.0.0.1:1/fixture'}).query('SELECT 1');}catch{}"
})) test(`actual verified parent/child preload blocks ${name} at zero before any upstream call`, async t => {
  const f = await hostFixture(t, probe + "if(process.env.NODE_OPTIONS||process.env.HOST_SECRET_EXAMPLE)throw new Error('inherited secret');");
  const result = await invoke(f.node, [...f.args, "--execute"], { HOST_SECRET_EXAMPLE: "fixture" }); assert.equal(result.code, 1, result.err); assert.match(result.out, /PROBE_FINISHED/);
  const receipt = JSON.parse(result.out.trim().split("\n").at(-1)!); assert.equal(receipt.failure, "SHARED_BUDGET_LIMIT");
  assert.equal(receipt.counters.httpRequests, 0); assert.equal(receipt.counters.sqlRequests, 0);
  assert.equal((await readdir(f.inputs)).includes("manual-run.lock"), false); assert.equal((await readdir(f.state)).includes("worker.lock"), false);
});
test("budget input rejects absent counters, unknown keys and cleanup outside reviewed maximum", () => {
  const input = { format: "qualified-budget-input-v1", runtimeSha256: "a".repeat(64), storageOrigin: "https://storage.test", durationMs: 1000, cleanupMs: 200, limits };
  assert.equal(parseQualifiedBudgetInput(input).durationMs, 1000);
  assert.equal(parseQualifiedBudgetInput({...input,durationMs:7200000}).durationMs,7200000);
  assert.throws(()=>parseQualifiedBudgetInput({...input,durationMs:7200001}),/SHARED_BUDGET_INPUT_INVALID/);
  assert.throws(() => parseQualifiedBudgetInput({ ...input, hidden: 1 }), /SHARED_BUDGET_INPUT_INVALID/);
  assert.throws(() => parseQualifiedBudgetInput({ ...input, limits: { ...limits, cleanupSqlRequests: 5 } }), /SHARED_BUDGET_INPUT_INVALID/);
  assert.throws(() => parseQualifiedBudgetInput({ ...input, limits: { httpRequests: 1 } }), /SHARED_BUDGET_INPUT_INVALID/);
});


for (const qualification of ["original", "fresh"]) for (const crossVersion of [false, true]) test(`verified host binds recovery inputs (${qualification}, cross-version=${crossVersion})`, async t=>{
  const f=await hostFixture(t,`if(process.env.WEBSITE_RESUME_PRODUCER_PROJECT){const {verifyCaptureProducer}=await import('./capture-release-compatibility.ts');const c=await verifyCaptureProducer({producerProject:process.env.WEBSITE_RESUME_PRODUCER_PROJECT,producerManifest:process.env.WEBSITE_RESUME_PRODUCER_MANIFEST,producerManifestSha256:process.env.WEBSITE_RESUME_PRODUCER_MANIFEST_SHA256,consumerProject:process.cwd(),consumerManifest:process.env.WEBSITE_CONSUMER_MANIFEST});if(c.consumerReleaseCommit!==process.env.WEBSITE_RELEASE_COMMIT)throw new Error('version mismatch');}console.log(JSON.stringify({resume:process.env.WEBSITE_RESUME_RUN_ID,hash:process.env.WEBSITE_RESUME_INDEX_SHA256,reserve:process.env.WEBSITE_RESUME_REQUEST_RESERVE,post:process.env.WEBSITE_RESUME_POST_SECONDS,capture:process.env.WEBSITE_CAPTURE_COLLECTION,qualification:process.env.WEBSITE_RESUME_QUALIFICATION,capacity:process.env.WEBSITE_COLLECTION_MAX_BYTES}));`);
  let resumeProducer: {project:string;manifest:string;manifestSha256:string}|undefined;
  const producerCommit=crossVersion?"99352be4a5ce92735fd7f1560ab28689c0c3a300":"a".repeat(40);
  if(crossVersion){
    // This fixture exercises the historical expiry-only compatibility transition.
    const fixedWorker="scripts/website-sync/worker.ts", consumerManifest=join(f.root,"manifest.json");
    await writeFile(join(f.project,fixedWorker),await readFile(new URL("./fixtures/capture-expiry-compatibility/consumer-worker.ts.txt",import.meta.url)),{mode:0o644});
    const fixed=JSON.parse(await readFile(consumerManifest,"utf8"));fixed.files.find((v:{path:string})=>v.path===fixedWorker).sha256=digest(await readFile(join(f.project,fixedWorker)));
    await writeFile(consumerManifest,JSON.stringify(fixed),{mode:0o600});
    const project=join(f.root,"producer"),manifest=join(f.root,"producer-manifest.json");await cp(f.project,project,{recursive:true});await chmod(project,0o700);
    const worker="scripts/website-sync/worker.ts";
    await writeFile(join(project,worker),await readFile(new URL("./fixtures/capture-expiry-compatibility/producer-worker.ts.txt",import.meta.url)),{mode:0o644});
    const old=JSON.parse(await readFile(join(f.root,"manifest.json"),"utf8"));old.commit=producerCommit;
    old.files.find((v:{path:string})=>v.path===worker).sha256=digest(await readFile(join(project,worker)));
    const bytes=JSON.stringify(old);await writeFile(manifest,bytes,{mode:0o600});resumeProducer={project,manifest,manifestSha256:digest(bytes)};
  }
  const {createDemo}=await import("../scripts/notion-sync/demo.ts");
  const {parseWebsiteNotionConfig}=await import("../src/server/notion/website-config.ts");
  const {configDigest}=await import("../src/server/database/website-validation.ts");
  const {createCollectionCapture}=await import("../scripts/website-sync/collection-capture.ts");
  const {runWebsiteSync}=await import("../scripts/website-sync/worker.ts");
  const demo=createDemo(1),config=parseWebsiteNotionConfig({schemaVersion:2,sources:[{...demo.config.sources[0],kind:"game"}]}),source=JSON.stringify(config),old=randomUUID();
  await writeFile(join(f.inputs,"sources.json"),source,{mode:0o600});
  const parent=join(f.state,"website-v2",old);await mkdir(parent,{recursive:true,mode:0o700});
  const directory=join(parent,"collection-private"),identity={runId:old,sourceSha256:digest(source),releaseCommit:producerCommit,configDigest:configDigest(config)};
  const capture=await createCollectionCapture(directory,identity);
  await runWebsiteSync({client:demo.client,config,mode:"dry-run",captureCollection:{...capture,save:page=>capture.save({...page,lease:{runId:old,fence:"1",revision:"1",configDigest:identity.configDigest,deniedPageIds:[]}})}});
  const index=join(directory,"index-private.json"),indexHash=digest(await readFile(index));
  const runtime=JSON.parse(await readFile(f.config,"utf8"));Object.assign(runtime,{sourceSha256:digest(source),captureCollection:true,maxCollectionBytes:67108864,resumeQualification:qualification,resumeProducer,resumeRunId:old,resumeIndexSha256:indexHash,resumeRequestReserve:20,resumePostSeconds:60});
  const runtimeBytes=JSON.stringify(runtime);await writeFile(f.config,runtimeBytes,{mode:0o600});
  const budget=JSON.parse(await readFile(f.budget,"utf8"));budget.runtimeSha256=digest(runtimeBytes);budget.limits.notionRequests=100;budget.limits.httpRequests=100;await writeFile(f.budget,JSON.stringify(budget),{mode:0o600});
  const args=[...f.args.slice(0,-1),"publish"];
  const checked=await invoke(f.node,args);assert.equal(checked.code,0,checked.err);
  assert.equal(JSON.parse(checked.out).resumePlan.savedPages,1);
  if(crossVersion)assert.equal(JSON.parse(checked.out).resumePlan.compatibility.producerReleaseCommit,producerCommit);assert.equal((await readdir(f.root)).includes("ledger"),false);
  const result=await invoke(f.node,[...args,"--execute"]);assert.match(result.out,/PROBE_FINISHED/);
  const env=JSON.parse(result.out.split("\n")[0]);assert.deepEqual(env,{resume:old,hash:indexHash,reserve:"20",post:"60",capture:"true",qualification,capacity:"67108864"});
  assert.equal((await readdir(f.inputs)).includes("manual-run.lock"),false);
  if(resumeProducer){
    const path=join(resumeProducer.project,"scripts/website-sync/worker.ts"),bytes=await readFile(path);
    await writeFile(path,Buffer.concat([bytes,Buffer.from(" ")]));
    const rejected=await invoke(f.node,args);assert.equal(rejected.code,1);assert.doesNotMatch(rejected.out,/PROBE_FINISHED/);
    await writeFile(path,bytes);
  }
  assert.equal(digest(await readFile(index)),indexHash);
  await writeFile(index,(await readFile(index,"utf8"))+" ",{mode:0o600});
  const drift=await invoke(f.node,args);assert.equal(drift.code,1);assert.doesNotMatch(drift.out,/PROBE_FINISHED/);
});
