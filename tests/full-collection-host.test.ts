import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDemo } from "../scripts/notion-sync/demo.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { WEBSITE_PROTOCOL, WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { FULL_COLLECTION_LEASE_SQL, type FullCollectionQualification } from "../scripts/website-sync/full-collection.ts";
import { createFullCollectionOwnerBroker, FULL_COLLECTION_OWNER_LIMITS, type OpenFullCollectionOwner } from "../scripts/website-sync/full-collection-owner.ts";
import { acceptFullCollectionPosts, bindFullCollection, parseFullCollectionPlan, prepareFullCollection, verifyFullCollectionBinding,
  type FullCollectionPlan, type FullCollectionPostReceipt } from "../scripts/website-sync/full-collection-control.ts";
import { runPrivateWebsiteWorker } from "../scripts/website-sync/run-private.mjs";
import { initializeSharedBudget, openSharedBudget } from "../scripts/website-sync/shared-budget.ts";

const digest = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const sourceRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
const plan = (hash = "a".repeat(64)): FullCollectionPlan => ({ format: "website-full-collection-plan-v1", postSeconds: 1,
  expectation: { configDigest: hash, revision: "2", epoch: "1", currentRun: randomUUID(), freshnessSeconds: 600, minimumRemainingSeconds: 60 } });
const prepared = () => prepareFullCollection({ runId: randomUUID(), sourceSha256: "b".repeat(64), releaseCommit: "c".repeat(40),
  manifestSha256: "d".repeat(64), runtimeSha256: "e".repeat(64), timeoutSeconds: 1, plan: plan() }, "a".repeat(64));
function qualification(p = prepared()): FullCollectionQualification {
  return { format: "website-full-collection-qualification-v1", qualification: "full-collection", runId: p.runId, fence: "3",
    ...p.plan.expectation, serverNow: new Date().toISOString(), validUntil: new Date(Date.now() + 600000).toISOString() } as FullCollectionQualification;
}
// Do not spread the expectation's reserve/freshness fields into the receipt.
function qualified(p = prepared()): FullCollectionQualification {
  const q = qualification(p) as FullCollectionQualification & { freshnessSeconds?: number; minimumRemainingSeconds?: number };
  delete q.freshnessSeconds; delete q.minimumRemainingSeconds; return q;
}
function metadata(runId: string, p: FullCollectionPlan) {
  const e = p.expectation, now = Date.now();
  return { protocol: WEBSITE_PROTOCOL, schema_digest: WEBSITE_SCHEMA_DIGEST, config_digest: e.configDigest, state_revision: e.revision,
    state_epoch: e.epoch, current_run: e.currentRun, lease_run: runId, state_fence: "3", lease_until: new Date(now + 300000).toISOString(),
    freshness_seconds: e.freshnessSeconds, run_id: runId, run_status: "staging", run_fence: "3", run_revision: e.revision, run_epoch: e.epoch,
    run_digest: e.configDigest, started_at: new Date(now - 1).toISOString(), finished_at: null, valid_until: new Date(now + 599000).toISOString(),
    server_now: new Date(now).toISOString(), has_payload: false };
}
const request = (runId: string, nonce: string) => ({ type: "website-full-collection-owner-request-v1", runId, nonce });

test("parent metadata broker only accepts one fixed new-run query and closes owner before replying", async () => {
  const p = prepared(); let opens = 0, queries = 0, closes = 0;
  const b = createFullCollectionOwnerBroker(p.runId, async signal => {
    opens++; assert.equal(signal.aborted, false);
    return { executor: { async query<T>(sql: string, values?: unknown[]) {
      queries++; assert.equal(sql, FULL_COLLECTION_LEASE_SQL); assert.deepEqual(values, [p.runId]);
      return { rows: [metadata(p.runId, p.plan) as T] };
    } }, close: async () => { closes++; } };
  }, new AbortController().signal);
  for (const bad of [request(randomUUID(), b.nonce), request(p.runId, randomUUID()), { ...request(p.runId, b.nonce), sql: "SELECT secret" }, null])
    await assert.rejects(b.request(bad), /metadata is unavailable/);
  assert.equal(opens, 0);
  const response = await b.request(request(p.runId, b.nonce)); assert.equal(closes, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 4096);
  await assert.rejects(b.request(request(p.runId, b.nonce))); await b.close();
  assert.deepEqual([opens, queries, closes], [1, 1, 1]); assert.equal(b.statistics().failed, false);
});

test("owner errors, oversized replies, extra rows and abort never expose a driver error or retry", async () => {
  for (const kind of ["error", "large", "rows", "abort"] as const) {
    const p = prepared(), controller = new AbortController(); let queries = 0, closed = 0;
    const b = createFullCollectionOwnerBroker(p.runId, async () => ({ executor: { async query<T>() {
      queries++; if (kind === "error") throw Error("Synthetic owner driver detail");
      if (kind === "abort") controller.abort();
      return { rows: (kind === "large" ? [{ data: "x".repeat(4096) }] : kind === "rows" ? [{}, {}] : [metadata(p.runId, p.plan)]) as T[] };
    } }, close: async () => { closed++; } }), controller.signal);
    await assert.rejects(b.request(request(p.runId, b.nonce)), error => {
      assert.equal(JSON.stringify(error).includes("Synthetic owner driver detail"), false); return /metadata is unavailable/.test(String(error));
    });
    await b.close(); assert.deepEqual([queries, closed], [1, 1]); assert.equal(b.statistics().failed, true);
    await assert.rejects(b.request(request(p.runId, b.nonce))); assert.equal(queries, 1);
  }
});

test("the owner port has a ten-second deadline, closes on timeout and discards a late reply", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = prepared(); let closed = 0, release: (() => void) | undefined, aborted = false;
  const b = createFullCollectionOwnerBroker(p.runId, async signal => {
    signal.addEventListener("abort", () => { aborted = true; });
    return { executor: { async query<T>() { await new Promise<void>(done => { release = done; }); return { rows: [metadata(p.runId, p.plan) as T] }; } },
      close: async () => { closed++; } };
  }, new AbortController().signal);
  const pending = assert.rejects(b.request(request(p.runId, b.nonce)));
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, "function");
  t.mock.timers.tick(FULL_COLLECTION_OWNER_LIMITS.timeoutMs); await pending;
  assert.equal(aborted, true); assert.equal(closed, 1); release!(); await b.close();
  assert.equal(b.statistics().queryCount, 1); assert.equal(b.statistics().failed, true);
});

test("late owner open after cancellation is closed without a metadata query", async () => {
  const p = prepared(), controller = new AbortController(); let resolve!: (value: Awaited<ReturnType<OpenFullCollectionOwner>>) => void, closed = 0;
  const b = createFullCollectionOwnerBroker(p.runId, async () => new Promise(done => { resolve = done; }), controller.signal);
  const rejected = assert.rejects(b.request(request(p.runId, b.nonce)));
  for (let i = 0; i < 10 && !resolve; i++) await Promise.resolve();
  controller.abort(); await rejected;
  resolve({ executor: { query: async () => assert.fail("No query after abort") }, close: async () => { closed++; } });
  await Promise.resolve(); await Promise.resolve(); await b.close(); assert.equal(closed, 1); assert.equal(b.statistics().queryCount, 0);
});

test("a failed owner budget write stops before connection or query and keeps an unknown attempt reserved", async () => {
  const p = prepared(); let opens = 0, queries = 0, closes = 0;
  for (const failAt of [1, 2]) {
    let writes = 0;
    const b = createFullCollectionOwnerBroker(p.runId, async () => {
      opens++; return { executor: { query: async () => { queries++; return { rows: [] }; } }, close: async () => { closes++; } };
    }, new AbortController().signal, async () => { if (++writes === failAt) throw Error("Disk unavailable"); });
    await assert.rejects(b.request(request(p.runId, b.nonce))); await b.close();
    assert.equal(queries, 0); assert.equal(b.statistics().failed, true);
    if (failAt === 1) assert.equal(opens, 0); else assert.equal(b.statistics().outcome, "unknown");
  }
  assert.equal(closes, 1);
});

test("controller bindings pin the complete same batch, raw inputs, deadline and all four posts", () => {
  const p = prepared(), q = qualified(p), b = bindFullCollection(p, q);
  const worker = { runId: p.runId, cloudRunId: p.runId, mode: "publish", published: true, readerVerified: true, fullCollectionBinding: b };
  const posts: FullCollectionPostReceipt[] = (["thumbnail", "snapshot", "visitor", "body"] as const).map(phase => ({ phase, status: "PASS", runId: p.runId, binding: b }));
  assert.equal(acceptFullCollectionPosts(p, worker, posts).status, "PASS");
  for (const key of ["runId", "sourceSha256", "releaseCommit", "manifestSha256", "runtimeSha256"] as const)
    assert.throws(() => verifyFullCollectionBinding(p, { ...b, prepared: { ...p, [key]: key === "runId" ? randomUUID() : "0".repeat(p[key].length) } }));
  for (const values of [posts.slice(1), [posts[0], posts[0], ...posts.slice(2)], posts.map((x, i) => i ? x : { ...x, runId: randomUUID() }),
    posts.map((x, i) => i ? x : { ...x, binding: { ...b, qualification: { ...q, validUntil: new Date(Date.parse(q.validUntil) - 1).toISOString() } } })])
    assert.throws(() => acceptFullCollectionPosts(p, worker, values));
  assert.throws(() => acceptFullCollectionPosts(p, { ...worker, resumeQualification: { qualification: "fresh" } }, posts));
  assert.throws(() => acceptFullCollectionPosts(p, worker, posts, Date.parse(q.validUntil)));
  assert.throws(() => bindFullCollection(p, { ...q, qualification: "fresh" } as unknown as FullCollectionQualification));
  for (const bad of [{ ...p.plan, extra: true }, { ...p.plan, postSeconds: 7200 }, { ...p.plan, expectation: { ...p.plan.expectation, extra: true } }])
    assert.throws(() => parseFullCollectionPlan(bad, 1));
});

const childFixture = `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {createDemo} from '../notion-sync/demo.ts';import {runFullCollection} from './full-collection.ts';
import {fullCollectionOwnerClient} from './full-collection-owner.ts';import {bindFullCollection} from './full-collection-control.ts';
const e=process.env,p=JSON.parse(Buffer.from(e.WEBSITE_FULL_COLLECTION_PREPARED,'base64url')),out=e.WEBSITE_OUTPUT_DIR;
const report={runId:p.runId,cloudRunId:p.runId,mode:'publish',releaseCommit:p.releaseCommit,publicationMode:'qualified',mediaProvider:'notion',published:false,readerVerified:false,promoteRequested:false};
let qualified=false,calls=0;const demo=createDemo(2),client=Object.fromEntries(Object.entries(demo.client).map(([k,fn])=>[k,async(...a)=>{if(!qualified)throw Error('Source before qualification');calls++;return fn(...a);} ]));
const save=()=>writeFile(join(out,'receipt-private.json'),JSON.stringify(report),{mode:0o600});
try{if(Object.keys(e).some(k=>/OWNER.*(URL|TOKEN|PASSWORD)|OWNER_SECRET/.test(k)))throw Error('Owner credential in child');
const result=await runFullCollection({client,config:JSON.parse(await readFile(e.NOTION_SOURCES_CONFIG,'utf8')),mode:'publish',publicationMode:'qualified',
expectation:p.plan.expectation,owner:fullCollectionOwnerClient(p.runId,e.WEBSITE_FULL_COLLECTION_OWNER_NONCE,new AbortController().signal),
writer:{begin:async()=>({runId:p.runId,fence:'3',revision:p.plan.expectation.revision,configDigest:p.plan.expectation.configDigest,deniedPageIds:[]}),renew:async()=>{},stage:async()=>{},promote:async()=>{report.promoteRequested=true;},fail:async()=>{}},
storage:{put:async()=>{},read:async()=>new Uint8Array()},onQualified:async q=>{report.fullCollectionQualification=q;report.fullCollectionBinding=bindFullCollection(p,q);await save();qualified=true;}});
Object.assign(report,result,{outcome:'published-verified',published:true,readerVerified:true,sourceCalls:calls});await save();
}catch(error){Object.assign(report,{outcome:'failed',code:error.code??'CONTENT_UNAVAILABLE',sourceCalls:calls});await save();process.exitCode=1;}
finally{if(process.connected)process.disconnect();}`;

async function frozenHost(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "full-host-"))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"), inputs = join(root, "inputs"), state = join(inputs, "state"), cache = join(root, "cache");
  for (const p of [project, inputs, state, cache]) await mkdir(p, { mode: 0o700 });
  const files = new Map<string, string>();
  async function copy(path: string) {
    if (files.has(path)) return;
    const text = await readFile(join(sourceRoot, path), "utf8"); files.set(path, text);
    if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return;
    for (const m of text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) await copy(posix.normalize(posix.join(posix.dirname(path), m[1])));
  }
  for (const p of ["scripts/website-sync/run-private.mjs", "scripts/website-sync/run.ts", "scripts/notion-sync/demo.ts", "scripts/website-sync/shared-budget-preload.ts",
    "scripts/website-sync/qualified-budget-cli.ts", "package-lock.json", "database/website-protocol.json", "database/website-media-protocol.json"]) await copy(p);
  files.set("scripts/website-sync/run.ts", childFixture);
  for (const [path, text] of files) { await mkdir(dirname(join(project, path)), { recursive: true, mode: 0o700 }); await writeFile(join(project, path), text); }
  await symlink(join(sourceRoot, "node_modules"), join(project, "node_modules"));
  const nodePath = await realpath(process.execPath), manifest = join(inputs, "manifest-private.json");
  await writeFile(manifest, JSON.stringify({ format: "website-v2-release-1", commit: "c".repeat(40), nodePath, nodeVersion: process.versions.node,
    nodeSha256: digest(await readFile(nodePath)), files: [...files].map(([path, text]) => ({ path, sha256: digest(text) })) }), { mode: 0o600 });
  const source = JSON.stringify({ schemaVersion: 2, sources: createDemo(2).config.sources.slice(0, 1) });
  const p = plan(configDigest(parseWebsiteNotionConfig(JSON.parse(source))));
  await mkdir(join(inputs, "bin"), { mode: 0o700 });
  const sourcesFile = join(inputs, "sources.json"), readerEnv = join(inputs, "reader.env");
  for (const [path, text] of [[sourcesFile, source], [readerEnv, 'DATABASE_READER_URL="fixture-only"\n'],
    [join(inputs, "notion-readonly.env"), 'NOTION_TOKEN="fake"\n'],
    [join(inputs, "supabase-worker.env"), 'SYNC_DATABASE_URL="fixture-only"\nSTORAGE_URL="https://storage.example.test"\nSTORAGE_BUCKET="fixture-only"\nSTORAGE_API_KEY="fixture-only"\n'],
    [join(inputs, "refresh-writer-session.mjs"), "throw Error('No session refresh')"], [join(inputs, "bin/heic-to-jpeg"), "fixture-only"]])
    await writeFile(path, text, { mode: 0o600 });
  const runtime = { format: "website-v2-runtime-1", project, manifest, privateRoot: inputs, stateDir: state, sourcesFile, sourceSha256: digest(source),
    cacheDirectory: cache, readerEnv, refreshSha256: digest("throw Error('No session refresh')"), converterSha256: digest("fixture-only"), timeoutSeconds: 1, maxMediaBytes: 1024, fullCollection: p };
  const configFile = join(inputs, "runtime-private.json");
  const saveRuntime = async (value: unknown) => { const text = JSON.stringify(value); await writeFile(configFile, text, { mode: 0o600 }); return digest(text); };
  const runtimeSha256 = await saveRuntime(runtime), shared = { runtimeSha256, storageOrigin: "https://storage.example.test" };
  return { root, inputs, state, cache, runtime, configFile, saveRuntime, shared, plan: p };
}

test("frozen opt-in host checks without opening owner or budget; real IPC recollects and binds one new batch", async t => {
  const f = await frozenHost(t); let opens = 0, queries = 0, closes = 0;
  const runHost: typeof runPrivateWebsiteWorker = (await import(pathToFileURL(join(f.runtime.project, "scripts/website-sync/run-private.mjs")).href)).runPrivateWebsiteWorker;
  const ownerMetadata: OpenFullCollectionOwner = async () => { opens++; return { executor: { async query<T>(sql: string, values?: unknown[]) {
    queries++; assert.equal(sql, FULL_COLLECTION_LEASE_SQL); return { rows: [metadata(values![0] as string, f.plan) as T] };
  } }, close: async () => { closes++; } }; };
  const checked = await runHost({ configFile: f.configFile, mode: "publish", check: true, sharedBudget: f.shared, ownerMetadata });
  assert.deepEqual(checked.fullCollectionPlan, f.plan); assert.equal(opens, 0); assert.deepEqual(await readdir(f.state), []);
  await assert.rejects(runHost({ configFile: f.configFile, mode: "publish", sharedBudget: f.shared }));
  assert.deepEqual(await readdir(f.state), []);
  for (const extra of [{ resumeRunId: randomUUID() }, { resumeQualification: "fresh" }, { resumeRecovery: "old" }, { resumeSource: {} }, { fullCollection: false }]) {
    const runtimeSha256 = await f.saveRuntime({ ...f.runtime, ...extra });
    await assert.rejects(runHost({ configFile: f.configFile, mode: "publish", check: true, sharedBudget: { ...f.shared, runtimeSha256 } }));
    assert.equal(opens, 0); assert.deepEqual(await readdir(f.state), []);
  }
  await f.saveRuntime(f.runtime);
  const bridge = initializeSharedBudget(join(f.root, "ledger"), { format: "qualified-shared-budget-v1", parentPid: process.pid, nonce: randomUUID(),
    deadline: Date.now() + 60000, cleanupMs: 1000, ...f.shared, limits: { notionRequests: 100, httpRequests: 100, storageRequests: 10, authRequests: 10, imageRequests: 10,
      notionResponseBytes: 1048576, storageResponseBytes: 1048576, authResponseBytes: 1048576, imageResponseBytes: 1048576, uploadBodyBytes: 1048576,
      sqlRequests: 10, sqlRequestBytes: 1048576, sqlResponseBytes: 1048576, cleanupSqlRequests: 4, cleanupSqlRequestBytes: 65536, cleanupSqlResponseBytes: 65536 } });
  const result = await runHost({ configFile: f.configFile, mode: "publish", sharedBudget: { ...f.shared, bridge }, ownerMetadata });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.published, true); assert.equal(result.readerVerified, true);
  assert.deepEqual([opens, queries, closes], [1, 1, 1]); assert.equal(openSharedBudget(bridge).read().failure, null);
  const binding = result.fullCollectionBinding!; assert.equal(binding.qualification.qualification, "full-collection");
  assert.equal(binding.prepared.runtimeSha256, f.shared.runtimeSha256);
  const receipt = JSON.parse(await readFile(join(f.state, "website-v2", binding.prepared.runId, "receipt-private.json"), "utf8"));
  assert.ok(receipt.sourceCalls > 0); assert.equal(receipt.resumeQualification, undefined);
  assert.equal((await readdir(f.inputs)).some(p => p.endsWith(".lock") || p.startsWith(".website-runtime-env-")), false);
  assert.deepEqual(await readdir(f.cache), []);
  const successPath = join(f.state, "website-v2", "last-success-private.json"), priorSuccess = await readFile(successPath, "utf8");
  const budgetPlan = openSharedBudget(bridge).plan;
  const failedBridge = initializeSharedBudget(join(f.root, "failed-ledger"), { ...budgetPlan, nonce: randomUUID() });
  const failed = await runHost({ configFile: f.configFile, mode: "publish", sharedBudget: { ...f.shared, bridge: failedBridge },
    ownerMetadata: async () => ({ executor: { query: async () => { throw Error("Private driver failure"); } }, close: async () => {} }) });
  assert.equal(failed.exitCode, 1); assert.equal(failed.requiresReceiptCheck, true);
  assert.equal(await readFile(successPath, "utf8"), priorSuccess);
  const runs = await readdir(join(f.state, "website-v2"));
  const failedId = runs.find(name => /^[a-f0-9-]{36}$/.test(name) && name !== binding.prepared.runId)!;
  const failedReceipt = JSON.parse(await readFile(join(f.state, "website-v2", failedId, "receipt-private.json"), "utf8"));
  assert.equal(failedReceipt.sourceCalls, 0); assert.equal(failedReceipt.promoteRequested, false);
  const ownerBudget = JSON.parse(await readFile(join(f.state, "website-v2", failedId, "full-collection-owner-budget-private.json"), "utf8"));
  assert.equal(ownerBudget.queryCount, 1); assert.equal(ownerBudget.outcome, "unknown"); assert.equal(ownerBudget.failed, true);
});
