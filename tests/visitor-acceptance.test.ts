import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { Client } from "pg";
import { hostFixture } from "./helpers/incremental-host.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { publicationReader } from "../src/server/database/publication.ts";
import { STUDY_DIRECTORY_SQL,STUDY_NOTE_ELIGIBILITY_SQL,STUDY_NOTE_DETAIL_SQL } from "../src/server/database/study-reads.ts";
import { contentDetailResponse, contentListResponse, courseTreeResponse, statusYearsResponse } from "../src/lib/content/http.ts";
import { contentFeatures } from "../config/features.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { initializeSharedBudget, openSharedBudget, SharedBudgetError } from "../scripts/website-sync/shared-budget.ts";
import { planVisitorAcceptance, VISITOR_MAXIMUM } from "../scripts/visitor-acceptance/plan.ts";
import { checkVisitorResponses } from "../scripts/visitor-acceptance/check.ts";
import { installVisitorTransports } from "../scripts/visitor-acceptance/transport.ts";
import { parseVisitorArguments, visitorSharedLimits, visitorCounters, visitorProfile, visitorMain, visitorBuildBinding } from "../scripts/visitor-acceptance/cli.ts";

const origin = "https://fiction-12345.cos.ap-shanghai.myqcloud.com", localOrigin = "http://127.0.0.1:3257";
function plan(f: Awaited<ReturnType<typeof hostFixture>>, overrides = {}) {
  return planVisitorAcceptance(f.config, f.artifact, [], "UTC", origin, "fiction", { ...VISITOR_MAXIMUM, durationMs: 10000, ...overrides }, "original-only");
}
async function ledger(f: Awaited<ReturnType<typeof hostFixture>>, p: ReturnType<typeof plan>, suffix = randomUUID()) {
  const bridge = initializeSharedBudget(join(f.root, `budget-${suffix}`), { format: "qualified-shared-budget-v1", parentPid: process.pid, nonce: randomUUID(),
    deadline: Date.now() + p.limits.durationMs, cleanupMs: 0, runtimeSha256: p.digest, storageOrigin: origin, limits: visitorSharedLimits(p.limits) });
  return openSharedBudget(bridge);
}
async function network(f: Awaited<ReturnType<typeof hostFixture>>, p: ReturnType<typeof plan>, change?: (url: URL, response: Response) => Promise<Response>) {
  const reader = f.open({ connectionString: f.options.database.readerUrl });
  const features = { ...contentFeatures, status: true, course: true, "study-note": true };
  const repository = createContentService({ provider: "database", features, timeZone: "UTC", databaseRepository: createWebsiteDatabaseRepository(publicationReader(reader, "published"), { timeZone: "UTC" }) }).repository;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input), path = url.pathname.split("/");
    let response: Response;
    if (url.pathname === "/api/health/content") { await repository.getTimeline!({ limit: 1 }); response = Response.json({ data: { provider: "database", databaseVersion: "2" } }, { headers: { "Cache-Control": "private, no-store" } }); }
    else if (url.pathname === "/api/status/years") response = await statusYearsResponse(new Request(url), repository, features);
    else if (url.pathname.startsWith("/api/content/")) response = path.length === 5 ? await contentDetailResponse(new Request(url), path[3], path[4], repository, features) : await contentListResponse(new Request(url), path[3], repository, features);
    else if (url.pathname.startsWith("/api/study/")) response = await courseTreeResponse(new Request(url), path[3], repository, features);
    else if (url.pathname.startsWith("/media/")) response = new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    else {
      const expected = p.requests.find(r => r.path === url.pathname)!.expected;
      response = new Response(`<html><main><h1>${expected.type === "html" ? expected.text : ""}</h1></main></html>`, { headers: { "Cache-Control": "no-store", "Content-Type": "text/html" } });
    }
    return change ? change(url, response) : response;
  };
  return { reader, fetcher };
}
test("same accepted full selects a nested note and binds membership, quotas and samples without I/O", async () => {
  const f = await hostFixture(); try {
    const p = plan(f), note = p.requests.find(r => r.name === "note-detail")!;
    assert.equal(note.expected.type, "detail"); assert.equal(p.state.publicationRevision, f.state.publicationRevision);
    assert.equal(p.mediaSampleAvailable, false); assert.ok(p.requests.length < 64);
    assert.notEqual(plan(f, { httpRequests: 63 }).digest, p.digest);
    const tampered = structuredClone(f.artifact); tampered.state.policyEpoch = "999";
    assert.notEqual(planVisitorAcceptance(f.config, tampered, [], "UTC", origin, "fiction", VISITOR_MAXIMUM, "original-only").digest, p.digest);
    assert.throws(() => planVisitorAcceptance(f.config, f.artifact, [], "UTC", origin, "fiction", VISITOR_MAXIMUM), /VISITOR_THUMBNAIL_SAMPLE_MISSING/);
    assert.throws(() => plan(f, { httpRequests: 1 }), /VISITOR_HTTP_LIMIT/);
    assert.throws(() => plan(f, { sqlQueries: 257 }), /VISITOR_INPUT_INVALID/);
    assert.throws(() => planVisitorAcceptance(f.config, f.artifact, [], "invalid-zone", origin, "fiction", VISITOR_MAXIMUM), /VISITOR_INPUT_INVALID/);
    assert.deepEqual(await readdir(f.root).then(v => v.filter(n => n.includes("budget"))), []);
  } finally { await f.close(); }
});
test("actual published PGlite projections flow through real HTTP helpers and bounded SQL ports", async () => {
  const f = await hostFixture(); try {
    const p = plan(f), b = await ledger(f, p), n = await network(f, p);
    const transport = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, fetch: n.fetcher, sqlPorts: [n.reader], checkConnections: false });
    try {
      const result = await checkVisitorResponses(p, transport.fetch, localOrigin, b.bridge.nonce);
      assert.equal(result.checks.length, p.requests.length); assert.equal(result.browserHydrationVerified, false);
      const c = visitorCounters(b.read().counters); assert.equal(c.httpRequests, p.requests.length); assert.ok(c.sqlQueries > 10); assert.ok(c.sqlRowBytes > 0);
      assert.ok(!JSON.stringify(result).includes(f.artifact.fullRunId));
    } finally { transport.restore(); }
  } finally { await f.close(); }
});
test("compound study reads require exact SQL and both projections retain the accepted version",async()=>{
  const f=await hostFixture();try {
    const p=plan(f),[runId,revision]=p.state.publicationRevision.split(":"),valid={runId,revision,schemaDigest:p.state.schemaDigest};
    const sql=(text:string)=>text.replace(/\bnb_v2_api\.(read_content|read_snapshot)\b/g,"nb_publication_api.$1");
    for(const changed of ["none","detail","course","notes","sql"] as const) {
      const b=await ledger(f,p);let reads=0;
      const port={query:async(..._args:unknown[])=>{reads++;return{rows:[{result:{course:{...valid,...(changed==="course"?{revision:"stale"}:{})},notes:{...valid,...(changed==="notes"?{revision:"stale"}:{})}}}]};}};
      const guard=installVisitorTransports({budget:b,plan:p,readerUrl:f.options.database.readerUrl,role:"supervisor",localOrigin,sqlPorts:[port],checkConnections:false});
      try {
        const text=sql(changed==="detail"?STUDY_NOTE_DETAIL_SQL:changed==="notes"?STUDY_NOTE_ELIGIBILITY_SQL:STUDY_DIRECTORY_SQL);
        if(changed==="none"||changed==="detail")await port.query(text as never);
        else if(changed==="sql")assert.throws(()=>port.query((text+"; DELETE FROM nb_v2.records") as never),/VISITOR_SQL_FORBIDDEN/);
        else await assert.rejects(port.query(text as never),/VISITOR_PUBLICATION_CHANGED/);
        assert.equal(reads,changed==="sql"?0:1);
      } finally {guard.restore();}
    }
  } finally {await f.close();}
});
test("central ancestor withdrawal or publication change fails the same plan rather than returning mock success", async () => {
  const f = await hostFixture(); try {
    const p = plan(f), b = await ledger(f, p), n = await network(f, p);
    const transport = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, fetch: n.fetcher, sqlPorts: [n.reader], checkConnections: false });
    try {
      await f.db.query("SELECT nb_v2_api.set_denied($1,$2)", [[f.artifact.collection.records.find(r => r.detail.item.kind === "course")!.detail.item.id], true]);
      await assert.rejects(checkVisitorResponses(p, transport.fetch, localOrigin, b.bridge.nonce));
      assert.ok(b.read().counters.httpRequests <= p.requests.length);
    } finally { transport.restore(); }
  } finally { await f.close(); }
});
test("HTTP failures/error bodies and refused calls retain counts; no redirects, Source, PUT or refunds", async () => {
  const f = await hostFixture(); try {
    const p = plan(f), b = await ledger(f, p); let calls = 0;
    const transport = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, sqlPorts: [], checkConnections: false,
      fetch: async () => { calls++; return new Response("error-body", { status: 503 }); } });
    try {
      await transport.fetch(new URL(p.requests[0].path, localOrigin)); assert.equal(b.read().counters.storageResponseBytes, 10);
      await assert.rejects(transport.fetch("https://api.notion.com/v1/pages/private"), /VISITOR_HTTP_FORBIDDEN/);
      assert.equal(calls, 1); assert.equal(b.read().counters.httpRequests, 1); assert.ok(b.read().failure);
    } finally { transport.restore(); }
    const b2 = await ledger(f, p), t2 = installVisitorTransports({ budget: b2, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, sqlPorts: [], checkConnections: false,
      fetch: async () => { throw Error("Synthetic DNS failure"); } });
    try { await assert.rejects(t2.fetch(new URL(p.requests[0].path, localOrigin))); assert.equal(b2.read().counters.httpRequests, 1); } finally { t2.restore(); }
  } finally { await f.close(); }
});
test("oversized and late bodies/SQL rows are charged before cancellation; callbacks cannot bypass quota", async () => {
  const f = await hostFixture(); try {
    const p = plan(f, { responseBytes: 3, sqlRowBytes: 3 }), b = await ledger(f, p);
    let resolve!: (v: any) => void;
    const port = { query: (..._args: any[]) => new Promise<any>(ok => { resolve = ok; }) };
    const t = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, sqlPorts: [port], checkConnections: false });
    try {
      const pending = port.query("SELECT nb_delta_api.read_state() AS result" as never);
      t.stop(); resolve({ rows: [{ late: "actual-row" }] }); await assert.rejects(pending);
      assert.equal(b.read().counters.sqlRequests, 1); assert.equal(b.read().counters.sqlResponseBytes, Buffer.byteLength(JSON.stringify([{ late: "actual-row" }])));
    } finally { t.restore(); }
    const b2 = await ledger(f, p), t2 = installVisitorTransports({ budget: b2, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, sqlPorts: [], checkConnections: false,
      fetch: async () => new Response("four") });
    try { await assert.rejects(t2.fetch(new URL(p.requests[0].path, localOrigin))); assert.equal(b2.read().counters.storageResponseBytes, 4); } finally { t2.restore(); }
    const p3 = plan(f, { sqlQueries: 1 }), b3 = await ledger(f, p3); let actual = 0;
    const callbackPort = { query(...args: any[]) { actual++; args.at(-1)(null, { rows: [] }); } };
    const t3 = installVisitorTransports({ budget: b3, plan: p3, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, sqlPorts: [callbackPort], checkConnections: false });
    try {
      await new Promise<void>((ok, reject) => callbackPort.query("SELECT nb_delta_api.read_state() AS result", (err: unknown) => err ? reject(err) : ok()));
      assert.throws(() => callbackPort.query("SELECT nb_delta_api.read_state() AS result", () => {})); assert.equal(actual, 1);
      assert.equal(b3.read().counters.sqlRequests, 1);
    } finally { t3.restore(); }
  } finally { await f.close(); }
});
test("SQL write/target mismatch are blocked before driver; compiled DTO drift and cached/redirected responses fail", async (t) => {
  const f = await hostFixture(); try {
    for (const variant of ["mock", "cache", "dto", "redirect"] as const) await t.test(variant, async () => {
      const p = plan(f), b = await ledger(f, p), n = await network(f, p, async (url, response) => {
        if (url.pathname !== "/api/health/content") return response;
        if (variant === "cache") { response.headers.set("cache-control", "public, max-age=60"); return response; }
        if (variant === "redirect") return new Response("login", { status: 302, headers: { location: "https://example.test" } });
        return Response.json({ data: { provider: variant === "mock" ? "mock" : "database", databaseVersion: "2", ...(variant === "dto" ? { private: "must fail" } : {}) } }, { headers: response.headers });
      });
      const guard = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, fetch: n.fetcher, sqlPorts: [n.reader], checkConnections: false });
      try { await assert.rejects(checkVisitorResponses(p, guard.fetch, localOrigin, b.bridge.nonce)); assert.equal(b.read().counters.httpRequests, 1); } finally { guard.restore(); }
    });
    const p = plan(f), b = await ledger(f, p); let writes = 0;
    const port = { query(..._args: any[]) { writes++; } };
    const guard = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, role: "supervisor", localOrigin, sqlPorts: [port] });
    try {
      assert.throws(() => port.query("DELETE FROM nb_v2.pages"), /VISITOR_SQL_FORBIDDEN/); assert.equal(writes, 0);
    } finally { guard.restore(); }
  } finally { await f.close(); }
});
test("profiles/options cannot smuggle Source/writer or remote target; private defaults and built artifacts are bound", async () => {
  const env = "CONTENT_PROVIDER=database\nDATABASE_CONTENT_VERSION=2\nDATABASE_PUBLICATION_MODE=published\nMEDIA_PROVIDER=storage\nMEDIA_THUMBNAILS=enabled\nSTORAGE_PROVIDER=cos\nDATABASE_TLS=verify\nDATABASE_READER_URL=postgresql://fixture_reader:synthetic@db.example.test:5432/postgres\nCOS_BUCKET=fiction-12345\nCOS_REGION=ap-shanghai\nCOS_PREFIX=fiction\nCOS_SECRET_ID=synthetic\nCOS_SECRET_KEY=synthetic\n";
  assert.equal((await visitorProfile(env)).timeZone, "UTC");
  for (const extra of ["NOTION_TOKEN=bad", "SYNC_DATABASE_URL=bad", "NODE_OPTIONS=bad", "NEXT_PUBLIC_KEY=bad", "STORAGE_WRITE_TOKEN=bad"]) await assert.rejects(visitorProfile(env + extra));
  assert.throws(() => parseVisitorArguments(["run", "--origin", "https://example.test"]), /VISITOR_INPUT_INVALID/);
  const f = await hostFixture(); try {
    const sitePath = join(f.root, "private-site.json"); await writeFile(sitePath, JSON.stringify({ timeZone: "UTC" }), { mode: 0o600 });
    const profile = await visitorProfile(env + "SITE_CONFIG=" + sitePath + "\n");
    await writeFile(sitePath, JSON.stringify({ timeZone: "Asia/Shanghai" }), { mode: 0o600 });
    assert.equal(profile.env.SITE_CONFIG, undefined); assert.deepEqual(JSON.parse(profile.env.SITE_CONFIG_JSON!), { timeZone: "UTC" });
    const project = join(f.root, "built"); await mkdir(join(project, ".next/server"), { recursive: true }); await mkdir(join(project, "scripts/visitor-acceptance"), { recursive: true }); await mkdir(join(project, "scripts/game-sync"), { recursive: true });
    await writeFile(join(project, ".next/BUILD_ID"), "synthetic"); await writeFile(join(project, ".next/server/app.js"), "synthetic");
    for (const name of ["plan.ts", "transport.ts", "check.ts", "server.ts", "cli.ts"]) await writeFile(join(project, "scripts/visitor-acceptance", name), "fixture");
    for (const path of ["package-lock.json", "scripts/game-sync/package-lock.json"]) await writeFile(join(project, path), "fixture");
    const a = await visitorBuildBinding(project); await writeFile(join(project, ".next/server/app.js"), "changed"); assert.notEqual(await visitorBuildBinding(project), a);
    await writeFile(join(project, ".env.local"), "BAD=secret"); await assert.rejects(visitorBuildBinding(project), /VISITOR_BUILD_PRIVATE_DEFAULTS/);
  } finally { await f.close(); }
});

test("actual CLI supervisor uses one ledger per immutable slot, pins live reader state and refuses restart/post after failure", async () => {
  const f = await hostFixture();
  const original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end, fetch: globalThis.fetch, log: console.log };
  const outputs: string[] = [], p = plan(f), n = await network(f, p); let children = 0;
  try {
    const env = "CONTENT_PROVIDER=database\nDATABASE_CONTENT_VERSION=2\nDATABASE_PUBLICATION_MODE=published\nMEDIA_PROVIDER=storage\nMEDIA_THUMBNAILS=enabled\nSTORAGE_PROVIDER=cos\nDATABASE_TLS=verify\nDATABASE_READER_URL=" + f.options.database.readerUrl + "\nCOS_BUCKET=fiction-12345\nCOS_REGION=ap-shanghai\nCOS_PREFIX=fiction\nCOS_SECRET_ID=synthetic\nCOS_SECRET_KEY=synthetic\n";
    const files = { config: join(f.root, "input-config.json"), artifact: join(f.root, "input-full.json"), thumbnails: join(f.root, "input-thumbnails.json"), env: join(f.root, "reader.env") };
    for (const [k, path] of Object.entries(files)) await writeFile(path, k === "env" ? env : JSON.stringify(k === "config" ? f.config : k === "artifact" ? f.artifact : { format: "media-acceptance-thumbnails-v1", entries: [] }), { mode: 0o600 });
    const args = Object.entries(files).flatMap(([k, v]) => [`--${k}`, v]).concat(["--media-policy", "original-only", "--duration-ms", "10000", "--http-requests", "64", "--response-bytes", "67108864", "--sql-queries", "256", "--sql-row-bytes", "8388608"]);
    const actor = f.open({ connectionString: f.options.database.readerUrl });
    Client.prototype.connect = function (this: Client) { assert.equal((this as any).connectionParameters.options, "-c default_transaction_read_only=on"); return Promise.resolve(this); } as any;
    Client.prototype.query = function (sql: string, values?: unknown[]) { return actor.query(sql, values); } as any;
    Client.prototype.end = async function () {} as any;
    globalThis.fetch = n.fetcher; console.log = v => { outputs.push(String(v)); };
    const dependencies = { buildBinding: async () => "a".repeat(64), spawn: ((...forkArgs: any[]) => {
      children++; const child = new EventEmitter() as any; child.pid = process.pid;
      let serverTransport: ReturnType<typeof installVisitorTransports> | undefined, killed = false;
      child.kill = () => { if (killed) return true; killed = true; void (async () => {
        await serverTransport?.drain(); serverTransport?.restore(); child.emit("message", { type: "stopped", drained: true, accountingComplete: true, failure: null }); child.emit("exit", 0);
      })(); return true; };
      setImmediate(async () => {
        const context = JSON.parse(await readFile(forkArgs[2].env.VISITOR_CONTEXT, "utf8")), b = openSharedBudget(context.bridge);
        serverTransport = installVisitorTransports({ budget: b, plan: context.plan, readerUrl: f.options.database.readerUrl, role: "server", localOrigin,
          sqlPorts: [n.reader], checkConnections: false, onStop: () => child.kill() });
        child.emit("message", { type: "ready", pid: child.pid });
      }); return child;
    }) as typeof fork };
    assert.equal(await visitorMain(["plan", ...args], dependencies), 0); const digest = JSON.parse(outputs.at(-1)!).planDigest;
    const operation = join(f.root, "operation"), run = (phase: string) => ["run", ...args, "--operation", operation, "--phase", phase, "--plan-sha256", digest, "--deadline-ms", String(Date.now() + 10000), "--port", "3257"];
    assert.equal(await visitorMain(run("pre"), dependencies), 0);
    const pre = JSON.parse(await readFile(join(operation, "pre.json"), "utf8")); assert.equal(pre.outcome, "passed"); assert.equal(pre.accountingComplete, true); assert.equal(pre.counters.sqlConnectionAttempts, 1);
    await assert.rejects(visitorMain(run("pre"), dependencies)); assert.equal(children, 1);
    assert.equal(await visitorMain(run("post"), dependencies), 0); assert.equal(children, 2);
    const post = JSON.parse(await readFile(join(operation, "post.json"), "utf8"));
    assert.ok(pre.counters.httpRequests + post.counters.httpRequests <= 128); assert.ok(pre.counters.sqlQueries + post.counters.sqlQueries <= 512);
    assert.equal(post.cloudRouteVerified, false); assert.equal(f.counts.sourceCalls, 0);
    await assert.rejects(visitorMain(run("post"), dependencies)); assert.equal(children, 2);
    assert.ok(outputs.every(v => !v.includes(f.artifact.fullRunId) && !v.includes("synthetic") && !v.includes("db.example")));
    const failedOperation = join(f.root, "failed-operation");
    globalThis.fetch = async () => new Response("actual error body", { status: 503, headers: { "Cache-Control": "no-store" } });
    const failedRun = (phase: string) => run(phase).map(v => v === operation ? failedOperation : v);
    assert.equal(await visitorMain(failedRun("pre"), dependencies), 1);
    const failed = JSON.parse(await readFile(join(failedOperation, "pre.json"), "utf8")); assert.equal(failed.counters.httpRequests, 1); assert.equal(failed.counters.responseBytes, 17);
    await assert.rejects(visitorMain(failedRun("post"), dependencies), /VISITOR_PRE_NOT_ACCEPTED/); assert.equal(children, 3);
  } finally {
    Client.prototype.connect = original.connect; Client.prototype.query = original.query; Client.prototype.end = original.end; globalThis.fetch = original.fetch; console.log = original.log; await f.close();
  }
});

test("HTML/SQL ledger contention waits for the short existing owner without network retry; persistent lock marks missing bytes", async context => {
  const f = await hostFixture(); let restoreClock = () => {}; try {
    const p = plan(f), b = await ledger(f, p), lock = join(b.bridge.directory, "ledger.lock");
    // Keep the real exclusive ledger lock, but make its owner's release deterministic.
    // A scheduled worker sleeping for 50ms is not guaranteed another CPU turn within 250ms.
    writeFileSync(lock, "fixture", { mode: 0o600 });
    let elapsed = 0, released = false, waits = 0;
    const clock = context.mock.method(performance, "now", () => elapsed);
    const wait = context.mock.method(Atomics, "wait", (_array: Int32Array | BigInt64Array, _index: number, _value: number | bigint, timeout?: number) => {
      elapsed += timeout ?? 0; waits++;
      if (!released && elapsed >= 50) { unlinkSync(lock); released = true; }
      return "timed-out" as const;
    });
    restoreClock = () => { wait.mock.restore(); clock.mock.restore(); };
    let calls = 0;
    const t = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, localOrigin, role: "supervisor", checkConnections: false, sqlPorts: [],
      fetch: async () => { calls++; return new Response("abc"); } });
    try { await t.fetch(new URL(p.requests[0].path, localOrigin)); assert.equal(calls, 1); assert.ok(waits > 0); assert.equal(elapsed, 50); assert.equal(released, true); assert.equal(b.read().counters.storageResponseBytes, 3); assert.equal(t.accountingComplete(), true); }
    finally { t.restore(); }
    const b2 = await ledger(f, p), lock2 = join(b2.bridge.directory, "ledger.lock");
    let observationStarted: number | undefined, stopStarted: number | undefined;
    const measured = { ...b2,
      observe(...args: Parameters<typeof b2.observe>) { observationStarted ??= elapsed; return b2.observe(...args); },
      stop(...args: Parameters<typeof b2.stop>) { stopStarted ??= elapsed; return b2.stop(...args); } };
    const t2 = installVisitorTransports({ budget: measured, plan: p, readerUrl: f.options.database.readerUrl, localOrigin, role: "supervisor", checkConnections: false, sqlPorts: [],
      fetch: async () => { writeFileSync(lock2, "fixture", { mode: 0o600 }); return new Response("four"); } });
    try {
      await assert.rejects(t2.fetch(new URL(p.requests[0].path, localOrigin))); assert.equal(t2.accountingComplete(), false);
      assert.notEqual(observationStarted, undefined); assert.notEqual(stopStarted, undefined);
      assert.equal(stopStarted! - observationStarted!, 250, "byte accounting keeps its original 250ms lock bound");
      assert.equal(elapsed - stopStarted!, 250, "stop accounting keeps its separate 250ms lock bound");
      assert.equal(b2.read().counters.httpRequests, 1); assert.equal(b2.read().counters.storageResponseBytes, 0); assert.ok(b2.read().failure);
    } finally { await unlink(lock2); t2.restore(); }
  } finally { restoreClock(); await f.close(); }
});

test("late HTTP chunks are counted after cancellation before the failed return", async () => {
  const f = await hostFixture(); try {
    const p = plan(f), b = await ledger(f, p); let t: ReturnType<typeof installVisitorTransports>;
    t = installVisitorTransports({ budget: b, plan: p, readerUrl: f.options.database.readerUrl, localOrigin, role: "supervisor", checkConnections: false, sqlPorts: [],
      fetch: async () => { t.stop(); return new Response("late"); } });
    try { await assert.rejects(t.fetch(new URL(p.requests[0].path, localOrigin))); assert.equal(b.read().counters.storageResponseBytes, 4); assert.equal(t.accountingComplete(), true); }
    finally { t.restore(); }
  } finally { await f.close(); }
});

test("guard tolerates proven atomic inode replacement but still refuses a corrupt stable ledger", async () => {
  const f = await hostFixture(); try {
    const p = plan(f), b = await ledger(f, p), state = join(b.bridge.directory, "state.json"); let once = true, calls = 0;
    const replace = { ...b, guard() {
      if (once) { once = false; const temp = join(b.bridge.directory, "fixture-atomic.json"); writeFileSync(temp, readFileSync(state), { mode: 0o600 }); renameSync(temp, state); throw new SharedBudgetError("SHARED_BUDGET_INPUT_INVALID"); }
      b.guard();
    } };
    const t = installVisitorTransports({ budget: replace, plan: p, readerUrl: f.options.database.readerUrl, localOrigin, role: "supervisor", checkConnections: false, sqlPorts: [], fetch: async () => { calls++; return new Response("abc"); } });
    try { await t.fetch(new URL(p.requests[0].path, localOrigin)); assert.equal(calls, 1); assert.equal(b.read().counters.httpRequests, 1); }
    finally { t.restore(); }
    const b2 = await ledger(f, p), corrupt = { ...b2, guard() { throw new SharedBudgetError("SHARED_BUDGET_INPUT_INVALID"); } };
    const t2 = installVisitorTransports({ budget: corrupt, plan: p, readerUrl: f.options.database.readerUrl, localOrigin, role: "supervisor", checkConnections: false, sqlPorts: [], fetch: async () => { calls++; return new Response("abc"); } });
    try { await assert.rejects(t2.fetch(new URL(p.requests[0].path, localOrigin))); assert.equal(calls, 1); assert.equal(b2.read().counters.httpRequests, 0); }
    finally { t2.restore(); }
  } finally { await f.close(); }
});
