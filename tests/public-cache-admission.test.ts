import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";
import { readPublicProjection, type PublicCachePorts, type ProjectionAdmission } from "../src/server/public-cache/read.ts";
import { PUBLIC_CACHE_DAY_MS } from "../src/server/public-cache/policy.ts";

const positive: ProjectionAdmission<unknown> = { policy: "positive-v1", accepts: value => value != null && value !== false && value !== "missing" };
function fixture() {
  const entries = new Map<string, unknown>();
  let stamp = "initial", time = 1;
  const ports: PublicCachePorts = {
    stamp: async () => ({ version: 1, enabled: true, stamp }), now: () => time,
    async read<T>(key: string, _tags: string[], load: () => Promise<T>) {
      if (!entries.has(key)) entries.set(key, await load());
      return structuredClone(entries.get(key)) as T;
    },
  };
  return { entries, ports, change: () => { stamp += ":next"; }, nextDay: () => { time += PUBLIC_CACHE_DAY_MS; } };
}

test("admission skips negative results and isolates legacy entries without changing default caching", async () => {
  for (const value of [null, undefined, false, "missing"]) {
    const f = fixture(); let calls = 0;
    const load = async () => { calls++; return value; };
    for (let i = 0; i < 3; i++) assert.equal(await readPublicProjection("content", "metadata", [i], "fixture", f.ports, load, positive), value);
    assert.equal(f.entries.size, 0);
    assert.equal(calls, 3);
  }
  const f = fixture();
  assert.equal(await readPublicProjection("content", "metadata", [], "fixture", f.ports, async () => null), null);
  const read = () => readPublicProjection("content", "metadata", [], "fixture", f.ports, async () => ({ id: "present" }), positive);
  assert.deepEqual(await read(), { id: "present" });
  assert.equal(f.entries.size, 2, "the new admission policy does not consume the old negative entry");
  assert.deepEqual(await readPublicProjection("content", "metadata", [], "fixture", f.ports, async () => { throw Error("positive cache miss"); }, positive), { id: "present" });
});

test("negative results still cross the complete generation and day guards before returning", async () => {
  for (const change of ["generation", "day"] as const) {
    const f = fixture(); let calls = 0;
    const value = await readPublicProjection("content", "metadata", [], "fixture", f.ports, async () => {
      if (++calls === 1) { if (change === "generation") f.change(); else f.nextDay(); return null; }
      return { id: "new-current" };
    }, positive);
    assert.deepEqual(value, { id: "new-current" }); assert.equal(calls, 2); assert.equal(f.entries.size, 1);
  }
  const f = fixture(); let calls = 0;
  await assert.rejects(readPublicProjection("content", "metadata", [], "fixture", f.ports, async () => {
    calls++; f.change(); return null;
  }, positive));
  assert.equal(calls, 3); assert.equal(f.entries.size, 0);
});

test("cancellation, stamp failure and corrupt admitted entries cannot become a negative success", async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(withContentReadBudget(controller.signal, () => readPublicProjection("content", "metadata", [], "fixture", f.ports, async () => {
    controller.abort(); return null;
  }, positive)));
  assert.equal(f.entries.size, 0);
  let stamps = 0;
  await assert.rejects(readPublicProjection("content", "metadata", [], "fixture", {
    ...f.ports, stamp: async () => { if (++stamps > 1) throw Error("synthetic stamp failure"); return f.ports.stamp(); },
  }, async () => null, positive));
  assert.equal(f.entries.size, 0);
  await assert.rejects(readPublicProjection("content", "metadata", [], "fixture", {
    ...f.ports, async read<T>(_key: string, _tags: string[], load: () => Promise<T>) {
      return { ...await load(), value: null } as T;
    },
  }, async () => ({ id: "present" }), positive));
});

test("real Next caching and the internal handler store only positive route and nested qualification results", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {AsyncLocalStorage} from 'node:async_hooks';
    import {randomBytes} from 'node:crypto';
    globalThis.AsyncLocalStorage??=AsyncLocalStorage;
    Object.assign(process.env,{CONTENT_PROVIDER:'database',PUBLIC_CONTENT_CACHE:'tagged-v1',PUBLIC_CACHE_SITE_KEY:'fixture-site',CACHE_PURGE_SECRET:randomBytes(32).toString('hex'),PUBLIC_CACHE_ORIGIN:'https://fixture.example',DATABASE_CONTENT_VERSION:'2',DATABASE_READ_PROJECTION:'legacy',DATABASE_PUBLICATION_MODE:'qualified',DATABASE_TLS:'disable',DATABASE_READER_URL:'postgresql://fixture:fixture@127.0.0.1:1/fixture',DATABASE_READER_ISOLATION:'off',SITE_CONFIG_JSON:'{}',VERCEL:'0'});
    delete process.env.PUBLIC_CACHE_PURGE_SECRET;
    const {createMockRepository}=await import('./adapters/mock-repository.ts');
    const {getDatabaseRuntime}=await import('./src/server/database/runtime.ts');
    const repository=createMockRepository(), original=await repository.getCourseMetadata('demo101');
    let calls=0,failed=false,generation='initial';
    repository.getContentMetadata=async(kind,slug)=>{calls++;if(failed)throw Error('synthetic provider failure');return kind==='course'&&slug==='course'?{...original,slug:'course',href:'/study/course'}:null;};
    repository.isStudyNoteAvailable=async(course,note)=>{calls++;return course==='course'&&note==='known-note';};
    const runtime=getDatabaseRuntime();runtime.repository=repository;
    runtime.db.query=async()=>{throw Error('No real SQL is permitted.');};
    runtime.cacheStateDb.query=async sql=>{assert.equal(sql,'SELECT nb_cache_api.read_stamp() AS result');return {rows:[{result:{version:1,enabled:true,stamp:generation}}]};};
    const entries=new Map();
    globalThis.__incrementalCache={generateSimpleCacheKey:async key=>key,get:async key=>entries.get(key),set:async(key,value)=>{entries.set(key,{value,isStale:false});}};
    const {GET}=await import('./src/app/api/internal/cache/route/route.ts');
    const {fetchCachedRouteVerdict}=await import('./src/server/public-cache/route-lookup.ts');
    const config={siteKey:process.env.PUBLIC_CACHE_SITE_KEY,secret:process.env.CACHE_PURGE_SECRET,origin:process.env.PUBLIC_CACHE_ORIGIN};
    let requests=0;
    const transport=async(input,init)=>{requests++;return GET(new Request(input,init));};
    const check=target=>fetchCachedRouteVerdict(target,config,transport);
    for(const make of [i=>'/study/absent-'+i,i=>'/status?focus=absent-'+i,i=>'/study/course/notes/absent-'+i]){
      for(let i=0;i<32;i++)assert.equal(await check(make(i)),'missing');
      assert.equal(entries.size,0,'both outer and nested negative results remain unstored');
    }
    const missingCalls=calls;
    for(let mask=0;mask<64;mask++){
      const slug=[...'course'].map((c,i)=>mask&(1<<i)?'%'+c.charCodeAt(0).toString(16):c).join('');
      assert.equal(await check('/study/'+slug),'found');
    }
    assert.equal(entries.size,2);assert.equal(calls,missingCalls+1);
    assert.equal(await check('/study/course/notes/known-note'),'found');assert.equal(entries.size,4);
    assert.equal(await check('/study/wrong-course/notes/known-note'),'missing');assert.equal(entries.size,4);
    const beforeInvalid={requests,calls,entries:entries.size};
    for(const target of ['/study/a%2fb','/study/%','/status?focus=','/status?focus=a&focus=b','/study/course/notes/n/extra'])assert.equal(await check(target),'missing');
    assert.deepEqual({requests,calls,entries:entries.size},beforeInvalid);
    failed=true;await assert.rejects(check('/study/provider-failure'),/ROUTE_CACHE_UNAVAILABLE/);assert.equal(entries.size,4);
    generation='withdrawn';
    await assert.rejects(check('/study/course'),/ROUTE_CACHE_UNAVAILABLE/);
    assert.equal(entries.size,4,'the old positive cache cannot hide a failure in a new generation');
    console.log(JSON.stringify({missingInputs:96,positiveVariants:64,positiveEntries:4,invalidTargets:5,realNetworkRequests:0}));
  `], { cwd: new URL("../", import.meta.url), timeout: 20_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { missingInputs: 96, positiveVariants: 64, positiveEntries: 4, invalidTargets: 5, realNetworkRequests: 0 });
});
