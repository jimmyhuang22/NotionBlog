import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSharedProjectionCache, sharedSocialProjectionCache } from "../src/server/public-cache/shared-projection.ts";
import { readPublicProjection, type PublicCachePorts } from "../src/server/public-cache/read.ts";
import { publicCacheTag, PUBLIC_CACHE_DAY_MS } from "../src/server/public-cache/policy.ts";
import { contentReadBudgetIdentity, withContentReadBudget, type ReadBudget } from "../src/server/content-read-budget.ts";

const tags = [publicCacheTag("social")];
const envelope = (value: unknown, expiresAt = Date.now() + 60_000) => ({ value, stamp: "initial", expiresAt });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  let now = 1, generation = "initial", enabled = true, stamps = 0;
  const cache = createSharedProjectionCache({ now: () => now });
  const ports: PublicCachePorts = { read: cache.read, now: () => now,
    stamp: async () => { stamps++; return { version: 1, enabled, stamp: generation } as never; } };
  return { cache, ports, change: () => { generation += ":next"; }, nextDay: () => { now += PUBLIC_CACHE_DAY_MS; },
    disable: () => { enabled = false; }, stamps: () => stamps };
}

test("shared rows keep stamp checks, publication/day/namespace boundaries and caller copies", async () => {
  const f = fixture(); let loads = 0;
  const read = (namespace = "fixture") => readPublicProjection("social", "rows", [], namespace, f.ports, async () => ({ ids: [++loads] }));
  const first = await read(); first.ids.push(100);
  assert.deepEqual(await read(), { ids: [1] }); assert.equal(f.stamps(), 3);
  f.change(); assert.deepEqual(await read(), { ids: [2] });
  f.nextDay(); assert.deepEqual(await read(), { ids: [3] });
  assert.deepEqual(await read("another-reader"), { ids: [4] });
  f.disable(); await assert.rejects(read(), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(loads, 4, "a cached result cannot bypass a disabled capability");
});

test("withdrawal during a shared load discards the old rows and retries with the new generation", async () => {
  const f = fixture(); let loads = 0, withdrawn = false;
  const read = () => readPublicProjection("social", "rows", [], "fixture", f.ports, async () => {
    loads++;
    if (withdrawn) return { ids: [] };
    withdrawn = true; f.change(); return { ids: ["withdrawn"] };
  });
  assert.deepEqual(await read(), { ids: [] }); assert.equal(loads, 2);
  assert.deepEqual(await read(), { ids: [] }); assert.equal(loads, 2);
});

test("one waiter cancelling never transfers its budget or cancellation to another waiter", async () => {
  const cache = createSharedProjectionCache(), gate = deferred(), started = deferred();
  const firstController = new AbortController(), secondController = new AbortController();
  let firstBudget!: ReadBudget, secondBudget!: ReadBudget, loaderBudget!: ReadBudget, loads = 0;
  const load = async () => { loads++; loaderBudget = contentReadBudgetIdentity()!; started.resolve(); await gate.promise; return envelope("rows"); };
  const first = withContentReadBudget(firstController.signal, () => {
    firstBudget = contentReadBudgetIdentity()!; return cache.read("one", tags, load);
  });
  const rejected = assert.rejects(first, { code: "CONTENT_UNAVAILABLE" });
  await started.promise;
  const second = withContentReadBudget(secondController.signal, () => {
    secondBudget = contentReadBudgetIdentity()!; return cache.read("one", tags, load);
  });
  firstController.abort(); await rejected;
  assert.notEqual(loaderBudget, firstBudget); assert.notEqual(loaderBudget, secondBudget);
  assert.notEqual(loaderBudget.sql, firstBudget.sql); assert.equal(loaderBudget.signal.aborted, false);
  gate.resolve(); assert.equal((await second as { value: string }).value, "rows"); assert.equal(loads, 1);
});

test("each waiter's original deadline applies without cancelling a surviving waiter", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = createSharedProjectionCache(), gate = deferred(), started = deferred();
  let loaderSignal!: AbortSignal;
  const load = async () => { loaderSignal = contentReadBudgetIdentity()!.signal; started.resolve(); await gate.promise; return envelope("rows"); };
  const first = withContentReadBudget(new AbortController().signal, () => cache.read("one", tags, load), { timeoutMs: 10 });
  const rejected = assert.rejects(first, { code: "CONTENT_UNAVAILABLE" }); await started.promise;
  const second = withContentReadBudget(new AbortController().signal, () => cache.read("one", tags, load), { timeoutMs: 5000 });
  t.mock.timers.tick(10); await rejected; assert.equal(loaderSignal.aborted, false);
  gate.resolve(); assert.equal((await second as { value: string }).value, "rows");
});

test("all waiters leaving aborts the load but retains capacity until the actual loader drains", async () => {
  const cache = createSharedProjectionCache({ maxInflight: 1 }), gate = deferred(), started = deferred();
  const controller = new AbortController(); let signal!: AbortSignal, newLoads = 0;
  const pending = withContentReadBudget(controller.signal, () => cache.read("old", tags, async () => {
    signal = contentReadBudgetIdentity()!.signal; started.resolve(); await gate.promise; return envelope("old");
  }));
  const rejected = assert.rejects(pending, { code: "CONTENT_UNAVAILABLE" }); await started.promise;
  controller.abort(); await rejected; assert.equal(signal.aborted, true);
  await assert.rejects(cache.read("new", tags, async () => { newLoads++; return envelope("new"); }), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(newLoads, 0);
  gate.resolve(); await tick();
  assert.equal((await cache.read("old", tags, async () => envelope("replacement"))).value, "replacement");
});

test("the shared loader has a hard timer even without a request budget and cannot refill after timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = createSharedProjectionCache({ timeoutMs: 25, maxInflight: 1 }), gate = deferred(), started = deferred();
  let signal!: AbortSignal;
  const read = cache.read("one", tags, async () => { signal = contentReadBudgetIdentity()!.signal; started.resolve(); await gate.promise; return envelope("late"); });
  const rejected = assert.rejects(read, { code: "CONTENT_UNAVAILABLE" }); await started.promise;
  t.mock.timers.tick(25); await rejected; assert.equal(signal.aborted, true);
  await assert.rejects(cache.read("one", tags, async () => envelope("replacement")), { code: "CONTENT_UNAVAILABLE" });
  gate.resolve(); await tick();
  assert.equal((await cache.read("one", tags, async () => envelope("replacement"))).value, "replacement");
});

test("tag purge drops stored rows, aborts matching work, and old completion cannot evict its replacement", async () => {
  const cache = createSharedProjectionCache(), gate = deferred(), started = deferred();
  await cache.read("kept", ["other"], async () => envelope("kept"));
  await cache.read("stored", tags, async () => envelope("old"));
  const old = cache.read("pending", tags, async () => { started.resolve(); await gate.promise; throw Error("late old failure"); });
  const rejected = assert.rejects(old, { code: "CONTENT_UNAVAILABLE" }); await started.promise;
  cache.invalidate(tags); await rejected;
  assert.equal((await cache.read("stored", tags, async () => envelope("fresh"))).value, "fresh");
  assert.equal((await cache.read("pending", tags, async () => envelope("replacement"))).value, "replacement");
  gate.resolve(); await tick();
  assert.equal((await cache.read<ReturnType<typeof envelope>>("pending", tags, async () => assert.fail("replacement was lost"))).value, "replacement");
  assert.equal((await cache.read<ReturnType<typeof envelope>>("kept", ["other"], async () => assert.fail("unrelated tag was purged"))).value, "kept");
});

test("cache capacity is bounded by encoded bytes and LRU entries; excess waiters do not start work", async () => {
  const cache = createSharedProjectionCache({ maxEntries: 2, maxBytes: 500, maxWaiters: 1 });
  const load = (value: string) => async () => envelope(value);
  await cache.read("a", tags, load("a")); await cache.read("b", tags, load("b"));
  await cache.read("a", tags, async () => assert.fail("warm a")); await cache.read("c", tags, load("c"));
  assert.equal((await cache.read("b", tags, load("new-b"))).value, "new-b");
  let hugeLoads = 0;
  for (let i = 0; i < 2; i++) await cache.read("huge", tags, async () => { hugeLoads++; return envelope("x".repeat(1000)); });
  assert.equal(hugeLoads, 2, "oversize values are returned but not retained");
  await cache.read("bytes-a", tags, load("a".repeat(300))); await cache.read("bytes-b", tags, load("b".repeat(300)));
  assert.equal((await cache.read("bytes-a", tags, load("reloaded"))).value, "reloaded", "combined byte capacity evicts even below the entry limit");
  const gate = deferred(), started = deferred(); let loads = 0;
  const first = cache.read("pending", tags, async () => { loads++; started.resolve(); await gate.promise; return envelope("first"); });
  await started.promise;
  await assert.rejects(cache.read("pending", tags, async () => assert.fail("extra load")), { code: "CONTENT_UNAVAILABLE" });
  gate.resolve(); await first; assert.equal(loads, 1);
});

test("expired, rejected and failed post-load stamps never become cached success", async () => {
  let now = 1;
  const cache = createSharedProjectionCache({ now: () => now });
  await cache.read("expires", tags, async () => envelope("old", 10)); now = 10;
  assert.equal((await cache.read("expires", tags, async () => envelope("new", 20))).value, "new");
  await assert.rejects(cache.read("fail", tags, async () => { throw Error("source failed"); }), /source failed/);
  assert.equal((await cache.read("fail", tags, async () => envelope("recovered", 20))).value, "recovered");
  const f = fixture(); let loads = 0, checks = 0;
  const ports: PublicCachePorts = { ...f.ports, stamp: async () => { if (++checks === 2) throw Error("stamp failed"); return f.ports.stamp(); } };
  const read = () => readPublicProjection("social", "rows", [], "fixture", ports, async () => ({ value: ++loads }));
  await assert.rejects(read(), /stamp failed/); assert.deepEqual(await read(), { value: 2 });
});

test("separately evaluated route modules share row data and purge state, including pending work", async () => {
  const other = (await import(new URL("../src/server/public-cache/shared-projection.ts?separate-route", import.meta.url).href)).sharedSocialProjectionCache as typeof sharedSocialProjectionCache;
  assert.notEqual(other, sharedSocialProjectionCache, "route-local functions retain their own budget accessors");
  const ownTags = ["fixture-cross-route"];
  const expected = envelope("shared");
  await sharedSocialProjectionCache.read("cross-route", ownTags, async () => expected);
  assert.deepEqual(await other.read("cross-route", ownTags, async () => assert.fail("route did not share stored rows")), expected);
  other.invalidate(ownTags);
  assert.equal((await sharedSocialProjectionCache.read("cross-route", ownTags, async () => envelope("fresh"))).value, "fresh");
  const gate = deferred(), started = deferred();
  const first = sharedSocialProjectionCache.read("cross-route-pending", ownTags, async () => { started.resolve(); await gate.promise; return envelope("late"); });
  const rejected = assert.rejects(first, { code: "CONTENT_UNAVAILABLE" }); await started.promise;
  const second = other.read("cross-route-pending", ownTags, async () => assert.fail("route did not share pending rows"));
  const secondRejected = assert.rejects(second, { code: "CONTENT_UNAVAILABLE" });
  other.invalidate(ownTags); await Promise.all([rejected, secondRejected]); gate.resolve(); await tick();
});

test("cross-module waiters preserve generation retries and non-stored results from the leader", async () => {
  const otherRead = (await import(new URL("../src/server/public-cache/read.ts?separate-route", import.meta.url).href)).readPublicProjection as typeof readPublicProjection;
  const f = fixture(), gate = deferred(), started = deferred(); let loads = 0, withdrawn = false;
  const load = async () => {
    loads++;
    if (withdrawn) return { ids: [] };
    started.resolve(); await gate.promise; withdrawn = true; f.change(); return { ids: ["withdrawn"] };
  };
  const first = readPublicProjection("social", "rows", [], "fixture", f.ports, load); await started.promise;
  const second = otherRead("social", "rows", [], "fixture", f.ports, load);
  await tick(); gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ ids: [] }, { ids: [] }]); assert.equal(loads, 2);
  for (const oversize of [false, true]) {
    const a = fixture(), held = deferred(), began = deferred(); let count = 0;
    const value = oversize ? { text: "x".repeat(2 * 1024 * 1024) } : { text: "not-admitted" };
    const admission = oversize ? undefined : { policy: "reject-fixture", accepts: () => false };
    const source = async () => { count++; began.resolve(); await held.promise; return value; };
    const one = readPublicProjection("social", "rows", [], "fixture", a.ports, source, admission); await began.promise;
    const two = otherRead("social", "rows", [], "fixture", a.ports, source, admission);
    await tick(); held.resolve(); const results = await Promise.all([one, two]);
    assert.deepEqual(results, [value, value]); assert.notEqual(results[0], results[1]); assert.equal(count, 1);
    await otherRead("social", "rows", [], "fixture", a.ports, source, admission); assert.equal(count, 2, "not stored");
  }
});

test("actual Next App Router caching reuses the production shared-row port across outer misses", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {AsyncLocalStorage} from 'node:async_hooks';
    import {randomBytes} from 'node:crypto';
    globalThis.AsyncLocalStorage??=AsyncLocalStorage;
    Object.assign(process.env,{CONTENT_PROVIDER:'database',PUBLIC_CONTENT_CACHE:'tagged-v1',PUBLIC_CACHE_SITE_KEY:'fixture-site',CACHE_PURGE_SECRET:randomBytes(32).toString('hex'),PUBLIC_CACHE_ORIGIN:'https://fixture.example',DATABASE_CONTENT_VERSION:'2',DATABASE_READ_PROJECTION:'legacy',DATABASE_PUBLICATION_MODE:'qualified',DATABASE_TLS:'disable',DATABASE_READER_URL:'postgresql://fixture:fixture@127.0.0.1:1/fixture',DATABASE_READER_ISOLATION:'off',SITE_CONFIG_JSON:'{}',VERCEL:'0'});
    delete process.env.PUBLIC_CACHE_PURGE_SECRET;
    const {getDatabaseRuntime}=await import('./src/server/database/runtime.ts');
    const {publicProjection,sharedSocialProjection}=await import('./src/server/public-cache/runtime.ts');
    const {sharedSocialProjectionCache}=await import('./src/server/public-cache/shared-projection.ts');
    const {workAsyncStorage}=await import('next/dist/server/app-render/work-async-storage.external.js');
    const {workUnitAsyncStorage}=await import('next/dist/server/app-render/work-unit-async-storage.external.js');
    let generation='initial',enabled=true,stamps=0,rows=0,baselineRows=0;
    const runtime=getDatabaseRuntime();
    runtime.db.query=async()=>{throw Error('No real SQL is permitted.');};
    runtime.cacheStateDb.query=async sql=>{assert.equal(sql,'SELECT nb_cache_api.read_stamp() AS result');stamps++;return {rows:[{result:{version:1,enabled,stamp:generation}}]};};
    const entries=new Map();
    const cache={generateSimpleCacheKey:async key=>key,get:async key=>entries.get(key),set:async(key,value)=>{entries.set(key,{value,isStale:false});}};
    globalThis.__incrementalCache=cache;
    async function request(read){
      const store={route:'/works',incrementalCache:cache,isDraftMode:false,isOnDemandRevalidate:false,isStaticGeneration:false,nextFetchId:1};
      const value=await workAsyncStorage.run(store,()=>workUnitAsyncStorage.run({type:'request',phase:'render',url:{pathname:'/works',search:''}},read));
      await Promise.all(Object.values(store.pendingRevalidates??{}));return value;
    }
    const load=async()=>{rows++;await new Promise(r=>setImmediate(r));return {version:generation,items:generation==='initial'?[{id:'visible',cover:null}]:[]};};
    const read=query=>request(()=>publicProjection('social','outer',[query],()=>sharedSocialProjection(load)));
    await Promise.all(['one','two','three'].map(read));assert.equal(rows,1);assert.equal(stamps,10);
    const before=stamps;await read('one');assert.equal(rows,1);assert.equal(stamps,before+1);
    for(const query of ['one','two','three'])await request(()=>publicProjection('social','baseline-outer',[query],()=>publicProjection('social','baseline-rows',[],async()=>{baselineRows++;return {items:[]};})));
    assert.equal(baselineRows,3,'the unchanged nested framework path remains the comparison');
    generation='withdrawn';assert.deepEqual((await read('one')).items,[]);assert.equal(rows,2);
    sharedSocialProjectionCache.invalidate(['nb:public:v1:social']);await read('uncached-after-purge');assert.equal(rows,3);
    enabled=false;await assert.rejects(read('one'),{code:'CONTENT_UNAVAILABLE'});
    enabled=true;
    const {POST}=await import('./src/app/api/internal/cache/purge/route.ts');
    const {signCacheEvent}=await import('./src/server/public-cache/events.ts');
    const event={id:'00000000-0000-4000-8000-000000000001',scope:'social',generation:'2',status:'pending'};
    const stampQuery=runtime.cacheStateDb.query;
    runtime.cacheStateDb.query=async(sql,values)=>sql==='SELECT nb_cache_api.read_event($1) AS result'?{rows:[{result:event}]}:stampQuery(sql,values);
    const signed=signCacheEvent(event,{siteKey:process.env.PUBLIC_CACHE_SITE_KEY,secret:process.env.CACHE_PURGE_SECRET});
    const purge=signature=>POST(new Request('https://fixture.example/api/internal/cache/purge',{method:'POST',headers:{'content-type':'application/json','x-nb-cache-signature':signature},body:signed.body}));
    assert.equal((await purge('0'.repeat(64))).status,401);await sharedSocialProjection(load);assert.equal(rows,3,'untrusted purge cannot invalidate rows');
    // Missing Next work store deliberately fails revalidateTag before any CDN call.
    assert.equal((await purge(signed.signature)).status,503);await sharedSocialProjection(load);assert.equal(rows,4,'signed purge clears local rows even when the later platform purge fails');
    console.log(JSON.stringify({baselineRows,sharedRowsForThreeKeys:1,afterWithdrawalAndPurge:rows,realNetworkRequests:0}));
  `], { cwd: new URL("../", import.meta.url), timeout: 20_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { baselineRows: 3, sharedRowsForThreeKeys: 1, afterWithdrawalAndPurge: 4, realNetworkRequests: 0 });
});
