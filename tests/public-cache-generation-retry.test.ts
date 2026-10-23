import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContentServiceError } from "../contracts/repository.ts";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";
import { publicCacheWindow, type PublicCacheScope } from "../src/server/public-cache/policy.ts";
import { readPublicProjection, type PublicCachePorts } from "../src/server/public-cache/read.ts";

function fixture() {
  let generation = "initial", time = 1, stamps = 0, reads = 0;
  const entries = new Map<string, unknown>();
  const ports: PublicCachePorts = {
    now: () => time,
    stamp: async () => { stamps++; return { version: 1, enabled: true, stamp: generation }; },
    async read<T>(key: string, _tags: string[], load: () => Promise<T>) {
      reads++;
      if (!entries.has(key)) entries.set(key, await load());
      return entries.get(key) as T;
    },
  };
  return { ports, entries, change: () => { generation += ":next"; }, setTime: (value: number) => { time = value; },
    counts: () => ({ stamps, reads }) };
}

for (const scope of ["content", "social", "home"] satisfies PublicCacheScope[]) {
  test(`${scope}: two in-flight generation changes discard both old loads and cache only the stable result`, async () => {
    const f = fixture(); let loads = 0;
    const read = () => readPublicProjection(scope, "list", [], "fixture", f.ports, async () => {
      const value = { generation: ++loads };
      if (loads < 3) f.change();
      return value;
    });
    assert.deepEqual(await read(), { generation: 3 });
    assert.equal(loads, 3);
    assert.equal(f.entries.size, 1, "neither rejected result becomes a successful cache entry");
    assert.deepEqual(f.counts(), { stamps: 6, reads: 3 });
    assert.deepEqual(await read(), { generation: 3 });
    assert.equal(loads, 3, "a later request reuses the stable generation");
    assert.deepEqual(f.counts(), { stamps: 7, reads: 4 }, "warm reads retain their single stamp lookup");
  });
}

test("continuous generation changes stop after three complete attempts and do not poison a later request", async () => {
  const f = fixture(); let loads = 0;
  await assert.rejects(readPublicProjection("content", "list", [], "fixture", f.ports, async () => {
    loads++; f.change(); return { stale: true };
  }), error => error instanceof ContentServiceError && error.code === "CONTENT_UNAVAILABLE");
  assert.equal(loads, 3);
  assert.deepEqual(f.counts(), { stamps: 6, reads: 3 });
  assert.equal(f.entries.size, 0);
  assert.equal(await readPublicProjection("content", "list", [], "fixture", f.ports, async () => "stable"), "stable");
  assert.equal(f.entries.size, 1);
});

test("a withdrawal during loading is reread as missing, never returned or cached from the old generation", async () => {
  const f = fixture(); let withdrawn = false, loads = 0;
  const value = await readPublicProjection("content", "detail", ["synthetic-page"], "fixture", f.ports, async () => {
    loads++;
    if (withdrawn) return null;
    withdrawn = true; f.change();
    return { id: "withdrawn-page", image: "/media/withdrawn" };
  });
  assert.equal(value, null);
  assert.equal(loads, 2);
  assert.equal(f.entries.size, 1);
  assert.deepEqual([...f.entries.values()].map(v => (v as { value: unknown }).value), [null]);
});

test("crossing the fixed day boundary restarts with a fresh window instead of extending the old entry", async () => {
  const f = fixture(); let loads = 0;
  f.setTime(publicCacheWindow(1).expiresAt - 1);
  const value = await readPublicProjection("content", "list", [], "fixture", f.ports, async () => {
    if (++loads === 1) f.setTime(publicCacheWindow(1).expiresAt);
    return { load: loads };
  });
  assert.deepEqual(value, { load: 2 });
  assert.equal(f.entries.size, 1);
  assert.deepEqual([...f.entries.values()].map(v => (v as { expiresAt: number }).expiresAt), [publicCacheWindow(86_400_000).expiresAt]);
});

test("a cache hit that crosses expiry is discarded before the next window is read", async () => {
  const f = fixture(); let loads = 0, crossBoundary = false;
  const ports: PublicCachePorts = { ...f.ports, async read(key, tags, load) {
    const value = await f.ports.read(key, tags, load);
    if (crossBoundary) { crossBoundary = false; f.setTime(publicCacheWindow(1).expiresAt); }
    return value;
  } };
  const read = () => readPublicProjection("content", "list", [], "fixture", ports, async () => ++loads);
  assert.equal(await read(), 1);
  crossBoundary = true;
  assert.equal(await read(), 2);
  assert.equal(loads, 2);
});

test("an oversized value from a changed generation cannot bypass the guard", async () => {
  const f = fixture(); let loads = 0;
  const value = await readPublicProjection("content", "detail", [], "fixture", f.ports, async () => {
    if (++loads === 1) { f.change(); return "old".repeat(1024 * 1024); }
    return "new".repeat(1024 * 1024);
  });
  assert.equal(value, "new".repeat(1024 * 1024));
  assert.equal(loads, 2);
  assert.equal(f.entries.size, 0, "validated oversized documents still bypass storage");
});

test("provider, cancellation, cache and stamp errors propagate without retrying or matching error text", async () => {
  for (const error of [new Error("offline"), new ContentServiceError("CONTENT_UNAVAILABLE", "Publication changed while preparing cached content."),
    new ContentServiceError("CONTENT_UNAVAILABLE", "The content operation was cancelled or exceeded its deadline.")]) {
    const f = fixture(); let loads = 0;
    await assert.rejects(readPublicProjection("content", "detail", [], "fixture", f.ports, async () => { loads++; throw error; }), actual => actual === error);
    assert.equal(loads, 1);
    assert.deepEqual(f.counts(), { stamps: 1, reads: 1 });
    assert.equal(f.entries.size, 0);
  }
  for (const failedPort of ["stamp", "read"] as const) {
    const f = fixture(); let failures = 0, loads = 0;
    const error = new Error("synthetic transport failure");
    const ports: PublicCachePorts = { ...f.ports, [failedPort]: async () => { failures++; throw error; } };
    await assert.rejects(readPublicProjection("content", "detail", [], "fixture", ports, async () => ++loads), actual => actual === error);
    assert.equal(failures, 1);
    assert.equal(loads, 0);
  }
});

test("withdrawal or capability failure during a retry remains an error, rather than returning the first result", async () => {
  for (const failure of ["provider", "capability"] as const) {
    const f = fixture(); let loads = 0, stamps = 0;
    const ports: PublicCachePorts = { ...f.ports, async stamp() {
      if (++stamps === 3 && failure === "capability") return { version: 1, enabled: false, stamp: "disabled" } as never;
      return f.ports.stamp();
    } };
    await assert.rejects(readPublicProjection("content", "detail", [], "fixture", ports, async () => {
      if (++loads === 1) { f.change(); return "formerly-public"; }
      throw new ContentServiceError("CONTENT_UNAVAILABLE", "Current qualification failed.");
    }), error => error instanceof ContentServiceError && error.code === "CONTENT_UNAVAILABLE");
    assert.equal(loads, failure === "provider" ? 2 : 1);
    assert.equal(f.entries.size, 0);
  }
});

test("a retry never starts a new deadline after the caller's existing read budget expires", async () => {
  const f = fixture(); let time = 0, loads = 0;
  await assert.rejects(withContentReadBudget(new AbortController().signal, () =>
    readPublicProjection("home", "list", [], "fixture", f.ports, async () => {
      loads++; f.change(); time = 10; return "discarded";
    }), { now: () => time, timeoutMs: 10 }), /cancelled or exceeded its deadline/);
  assert.equal(loads, 1);
  assert.deepEqual(f.counts(), { stamps: 2, reads: 1 });
  assert.equal(f.entries.size, 0);
});

test("a corrupt cache entry fails immediately instead of retrying or reusing its payload", async () => {
  for (const wrong of [{ stamp: "wrong" }, { expiresAt: -1 }]) {
    const f = fixture(); let loads = 0;
    const ports: PublicCachePorts = { ...f.ports, async read(key, tags, load) {
      return Object.assign({}, await f.ports.read(key, tags, load), wrong);
    } };
    await assert.rejects(readPublicProjection("content", "list", [], "fixture", ports, async () => ++loads));
    assert.equal(loads, 1);
    assert.deepEqual(f.counts(), { stamps: 2, reads: 1 });
  }
});

test("real RSC course memoization requalifies after a retry while still deduplicating within one generation", async () => {
  const execute = promisify(execFile);
  const { stdout } = await execute(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", `
    import React from 'react';
    import {renderToReadableStream} from 'next/dist/compiled/react-server-dom-webpack/server.node.js';
    import {contentRepository} from './src/lib/content/index.ts';
    import {getDatabaseRuntime} from './src/server/database/runtime.ts';
    import {createMockRepository} from './adapters/mock-repository.ts';
    import {readPublicProjection} from './src/server/public-cache/read.ts';
    import {AsyncLocalStorage} from 'node:async_hooks';
    globalThis.AsyncLocalStorage??=AsyncLocalStorage;
    const {unstable_cache}=await import('next/cache.js');
    Object.assign(process.env,{CONTENT_PROVIDER:'database',PUBLIC_CONTENT_CACHE:'disabled',DATABASE_CONTENT_VERSION:'2',DATABASE_READ_PROJECTION:'legacy',DATABASE_PUBLICATION_MODE:'qualified',DATABASE_TLS:'disable',DATABASE_READER_URL:'postgresql://fixture:fixture@127.0.0.1:1/fixture',SITE_CONFIG_JSON:'{}'});
    const repository=createMockRepository(),course=await repository.getCourseMetadata('demo101');
    let calls=0,loads=0,generation='before',withdrawn=false;
    repository.getCourseMetadata=async()=>{calls++;return withdrawn?null:course;};
    repository.readStudyNote=async()=>{throw Error('No note body was requested.');};
    const runtime=getDatabaseRuntime();runtime.repository=repository;
    runtime.db.query=runtime.cacheStateDb.query=async()=>{throw Error('No SQL is permitted in this synthetic RSC test.');};
    const entries=new Map();
    globalThis.__incrementalCache={generateSimpleCacheKey:async key=>key,get:async key=>entries.get(key),set:async(key,value)=>{entries.set(key,{value,isStale:false});}};
    const ports={stamp:async()=>({version:1,enabled:true,stamp:generation}),read:(key,tags,load)=>unstable_cache(load,[key],{tags,revalidate:false})()};
    async function Child(){
      const result=await readPublicProjection('content','metadata',[],'fixture',ports,async()=>{
        const [one,two]=await Promise.all([contentRepository.getCourseMetadata('demo101'),contentRepository.getCourseMetadata('demo101')]);
        if(one!==two)throw Error('Metadata was not deduplicated.');
        if(++loads===1){withdrawn=true;generation='after';}
        return one;
      });
      return React.createElement('p',null,result===null?'withdrawn':'stale');
    }
    const errors=[];
    const text=await new Response(await renderToReadableStream(React.createElement(Child),{},{onError:error=>{errors.push(error.message);return 'synthetic-render-error';}})).text();
    const cached=await readPublicProjection('content','metadata',[],'fixture',ports,async()=>{throw Error('The stable result was not cached.');});
    if(cached!==null)throw Error('The cached result is stale.');
    console.log(JSON.stringify({calls,loads,cachedEntries:entries.size,withdrawn:text.includes('withdrawn'),stale:text.includes('stale'),errors}));
  `], { cwd: new URL("../", import.meta.url), timeout: 15_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { calls: 2, loads: 2, cachedEntries: 1, withdrawn: true, stale: false, errors: [] });
});
