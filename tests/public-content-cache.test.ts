import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { publicCacheKey, publicCacheNamespace, publicCacheEnabled, publicCacheWindow, publicResponseHeaders } from "../src/server/public-cache/policy.ts";
import { readPublicProjection, type PublicCachePorts } from "../src/server/public-cache/read.ts";
import { signCacheEvent, cachePurgeResponse, type CacheRefreshEvent } from "../src/server/public-cache/events.ts";
import { publicHttpResponse } from "../src/server/public-cache/http.ts";
import { executeWithdrawal, type WithdrawalPlan, type WithdrawalJournal, withdrawalTarget } from "../scripts/public-cache/withdraw.ts";
import { enqueuePublicationRefresh, flushCacheEvent } from "../scripts/public-cache/control.ts";
import { fetchCachedRouteVerdict, routeCacheLookupResponse } from "../src/server/public-cache/route-lookup.ts";
import { hasSafeMediaCachePolicy } from "../src/server/media/cache.ts";
import cacheProtocol from "../database/public-cache-protocol.json" with { type: "json" };
import { createHash } from "node:crypto";

const config = { siteKey: "fixture-site", origin: "https://site.example", secret: "ab".repeat(32) };
const event: CacheRefreshEvent = { id: randomUUID(), scope: "withdraw", generation: "1", status: "pending" };

test("cache keys preserve semantic query/provider boundaries and the one-day hard boundary", async () => {
  assert.equal(publicCacheEnabled({}), false);
  assert.throws(() => publicCacheEnabled({ PUBLIC_CONTENT_CACHE: "tagged-v1" }));
  assert.equal(publicCacheKey({ a: 1, b: 2 }), publicCacheKey({ b: 2, a: 1 }));
  for (const value of [{ year: 2025 }, { year: 2026 }, { order: "views" }, { platform: "xiaohongshu" }, { cursor: "next" }])
    assert.notEqual(publicCacheKey(value), publicCacheKey({}));
  assert.notEqual(publicCacheNamespace({ DATABASE_READER_URL: "first" }, {}, {}), publicCacheNamespace({ DATABASE_READER_URL: "second" }, {}, {}));
  assert.throws(() => publicCacheKey({ cursor: "x".repeat(20_000) }));
  let time = 1, stamp = "a", loads = 0;
  const entries = new Map<string, unknown>();
  const ports: PublicCachePorts = { now: () => time, stamp: async () => ({ version: 1, enabled: true, stamp }),
    async read<T>(key: string, _tags: string[], load: () => Promise<T>) { if (!entries.has(key)) entries.set(key, await load()); return entries.get(key) as T; } };
  const read = () => readPublicProjection("content", "list", { year: 2025 }, "fixture", ports, async () => ({ revision: ++loads }));
  const first = await read(); first.revision = 999;
  assert.equal((await read()).revision, 1, "a caller cannot mutate another request's DTO");
  time = publicCacheWindow(time).expiresAt;
  assert.equal((await read()).revision, 2, "the old entry cannot be served stale after a day");
  stamp = "withdrawn";
  assert.equal((await read()).revision, 3, "a new withdrawal/publication generation misses the old cache");
  const headers = publicResponseHeaders("home", 86_399_500);
  assert.equal(headers["Vercel-CDN-Cache-Control"], "no-store", "the CDN cannot restart the remaining half second as another day");
  assert.match(headers["Cache-Control"]!, /no-cache/);
});

test("a withdrawal during a cold read prevents its result entering the reusable cache; failures retry normally", async () => {
  let stamp = "before", stored = 0;
  const ports: PublicCachePorts = { stamp: async () => ({ version: 1, enabled: true, stamp }), async read(_k, _t, load) { const value = await load(); stored++; return value; } };
  await assert.rejects(readPublicProjection("content", "detail", [], "fixture", ports, async () => { stamp = "after"; return { private: false }; }));
  assert.equal(stored, 0);
  await assert.rejects(readPublicProjection("content", "detail", [], "fixture", ports, async () => { throw Error("unavailable"); }));
  assert.equal(stored, 0);
  assert.equal(await readPublicProjection("content", "detail", [], "fixture", ports, async () => "fresh"), "fresh");
  let largeReads = 0;
  for (let i = 0; i < 2; i++) {
    const large = await readPublicProjection("content", "large", [], "fixture", ports, async () => { largeReads++; return "x".repeat(2 * 1024 * 1024); });
    assert.equal(large.length, 2 * 1024 * 1024);
  }
  assert.equal(largeReads, 2, "valid large documents bypass storage instead of becoming unavailable");
  assert.equal(stored, 1);
});

test("origin cache headers never turn a missing/failed image into a cached 304", async () => {
  const previous = { ...process.env };
  // This fixture uses a synthetic local origin, independently of a hosting builder's metadata.
  Object.assign(process.env, { VERCEL: "", PUBLIC_CONTENT_CACHE: "tagged-v1", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_PUBLICATION_MODE: "qualified", PUBLIC_CACHE_SITE_KEY: config.siteKey, PUBLIC_CACHE_PURGE_SECRET: config.secret, PUBLIC_CACHE_ORIGIN: config.origin });
  try {
    const url = "https://site.example/media/v2/a1." + "a".repeat(64);
    const full = await publicHttpResponse(new Request(url), new Response("bytes", { headers: { "Content-Type": "image/webp" } }), "media");
    assert.match(full.headers.get("Cache-Control")!, /no-cache/);
    assert.match(full.headers.get("Vercel-CDN-Cache-Control")!, /max-age=/);
    assert.equal(hasSafeMediaCachePolicy(full, url), true);
    const conditional = new Request(url, { headers: { "If-None-Match": full.headers.get("ETag")! } });
    assert.equal((await publicHttpResponse(conditional, new Response("bytes"), "media")).status, 304);
    for (const status of [400, 404, 503]) {
      const result = await publicHttpResponse(conditional, new Response(null, { status, headers: { "Cache-Control": "no-store" } }), "media");
      assert.equal(result.status, status); assert.equal(result.headers.get("Vercel-Cache-Tag"), null);
    }
    const old304 = await publicHttpResponse(conditional, new Response(null, { status: 304, headers: { "Cache-Control": "private, max-age=86400" } }), "media");
    assert.match(old304.headers.get("Cache-Control")!, /no-cache/);
  } finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
});

test("purge accepts only the authenticated site's committed event and reports failures as pending", async () => {
  const now = 100000, signed = signCacheEvent(event, config, now); let reads = 0, purges = 0;
  const request = (body = signed.body, sig = signed.signature) => new Request(config.origin + "/api/internal/cache/purge", { method: "POST", headers: { "Content-Type": "application/json", "x-nb-cache-signature": sig }, body });
  const ports = { enabled: () => true, config, now: () => now, read: async () => { reads++; return event; }, purge: async (tags: string[]) => { purges++; assert.ok(tags.includes("nb:public:v1:media")); } };
  assert.equal((await cachePurgeResponse(request(signed.body + " "), ports)).status, 401);
  assert.equal(reads, 0);
  assert.equal((await cachePurgeResponse(request(), { ...ports, now: () => now + 120001 })).status, 401);
  assert.equal((await cachePurgeResponse(request(), { ...ports, config: { ...config, siteKey: "another-site" } })).status, 401);
  assert.equal((await cachePurgeResponse(request("x".repeat(2049)), ports)).status, 401);
  assert.equal((await cachePurgeResponse(request(), ports)).status, 200);
  assert.equal(purges, 1);
  assert.equal((await cachePurgeResponse(request(), { ...ports, read: async () => ({ ...event, generation: "2" }) })).status, 409);
  assert.equal((await cachePurgeResponse(request(), { ...ports, purge: async () => { throw Error("offline"); } })).status, 503);
});

const migration = new URL("../supabase/migrations/20261020203508_public_content_cache.sql", import.meta.url);
test("restricted real SQL: deny is atomic, keeps shared bytes, covers descendants, rejects busy/stale plans and persists publication events", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE nb_reader NOLOGIN; CREATE ROLE nb_writer NOLOGIN;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.exec("CREATE SCHEMA social_sync; CREATE TABLE social_sync.retained_publications(id text PRIMARY KEY,value text); CREATE TABLE social_sync.cover_bindings(id text PRIMARY KEY,value text)");
    const migrationText = await readFile(migration, "utf8");
    assert.equal(createHash("sha256").update(migrationText).digest("hex"), cacheProtocol.migration.sha256);
    await db.exec(migrationText);
    const run = randomUUID(), assetA = "a1." + "a".repeat(64), assetB = "a1." + "b".repeat(64);
    await db.query("INSERT INTO nb_v2.sources(key,kind,mode,data_source_id) VALUES('status','status','all','fixture-status')");
    await db.query("INSERT INTO nb_v2.runs(id,fence,revision,epoch,config_digest,valid_until,status) VALUES($1,1,1,1,$2,clock_timestamp()+interval '1 hour','published')", [run, "a".repeat(64)]);
    await db.query("UPDATE nb_v2.state SET current_run=$1,revision=1,epoch=1,config_digest=$2,schema_digest=$2", [run, "a".repeat(64)]);
    for (const id of ["a", "b"]) await db.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,ordinal,item,document) VALUES($1,$2,'status','status',1,$3::jsonb,$4::jsonb)", [run, id, JSON.stringify({ id, href: "/status#" + id, kind: "status", slug: id, cover: { src: "/media/v2/" + (id === "a" ? assetA : assetB) } }), JSON.stringify({ blocks: [] })]);
    for (const [id, asset] of [["a", assetA], ["b", assetB]]) await db.query("INSERT INTO nb_v2.media(run_id,asset_id,owner_page_id,descriptor) VALUES($1,$2,$3,$4::jsonb)", [run, asset, id, JSON.stringify({ objectKey: "same-private-file", sha256: "c".repeat(64) })]);
    const role = async (name: string, sql: string, values: unknown[] = []) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<{ result: any }>(sql, values); });
    assert.equal((await role("nb_reader", "SELECT nb_cache_api.read_stamp() AS result")).rows[0].result.enabled, false);
    await t.test("website readers cannot plan, deny, mutate events or read underlying tables", async () => {
      for (const sql of ["SELECT * FROM nb_cache.events", "SELECT nb_cache_api.plan_withdraw('a')", `SELECT nb_cache_api.enqueue_refresh('${randomUUID()}','content','${"a".repeat(64)}')`]) await assert.rejects(role("nb_reader", sql));
      await assert.rejects(role("nb_cache_publisher", "SELECT nb_cache_api.plan_withdraw('a')"));
    });
    await t.test("a foreign owner URL must be rebound before withdrawal; shared physical bytes alone do not block it", async () => {
      await db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE id='b'", [JSON.stringify({ blocks: [{ image: { src: "/media/v2/" + assetA + "?thumbnail=800" } }] })]);
      const shared = (await role("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw('a') AS result")).rows[0].result;
      assert.equal(shared.sharedOwnerUrl, true);
      await assert.rejects(role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [randomUUID(), JSON.stringify(shared)]), /NB_CACHE_PLAN_CHANGED/);
      await db.query("UPDATE nb_v2.records SET document='{}' WHERE id='b'");
    });
    const plan = (await role("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw($1) AS result", ["/status#a"])).rows[0].result;
    assert.deepEqual(plan.assets, [assetA]); assert.equal(plan.sharedOwnerUrl, false);
    await db.query("UPDATE nb_v2.state SET lease_run=$1", [randomUUID()]);
    await assert.rejects(role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [randomUUID(), JSON.stringify(plan)]), /NB_CACHE_SYNC_BUSY/);
    assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_v2.denied")).rows[0].n, 0);
    await db.query("UPDATE nb_v2.state SET lease_run=NULL,revision=revision+1");
    await assert.rejects(role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [randomUUID(), JSON.stringify(plan)]), /NB_CACHE_PLAN_CHANGED/);
    const fresh = (await role("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw('a') AS result")).rows[0].result, id = randomUUID();
    await role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [id, JSON.stringify(fresh)]);
    await role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [id, JSON.stringify(fresh)]);
    assert.equal((await db.query<{ generation: number }>("SELECT generation FROM nb_cache.state")).rows[0].generation, 1);
    assert.equal((await role("nb_reader", "SELECT nb_v2_api.read_media($1) AS result", [assetA])).rows[0].result.media, null);
    assert.equal((await role("nb_reader", "SELECT nb_v2_api.read_media($1) AS result", [assetB])).rows[0].result.media.objectKey, "same-private-file");
    assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_v2.media")).rows[0].n, 2);
    assert.equal((await role("nb_cache_operator", "SELECT nb_cache_api.read_withdraw($1) AS result", [id])).rows[0].result.denied, true);
    await assert.rejects(role("nb_cache_publisher", "SELECT nb_cache_api.complete_event($1,1) AS result", [id]));
    assert.equal((await role("nb_cache_publisher", "SELECT nb_cache_api.complete_refresh_event($1,1) AS result", [id])).rows[0].result, false);
    await t.test("a course deny removes its real permitted descendant chain", async () => {
      await db.query("INSERT INTO nb_v2.sources(key,kind,mode,data_source_id,database_parent_id) VALUES('course','course','allowlist','fixture-course',NULL),('notes','study-note','allowlist','fixture-notes','course-c')");
      for (const [id, kind, parent] of [["course-c", "course", null], ["note-n", "study-note", "course-c"], ["note-n2", "study-note", "note-n"]]) {
        const source = kind === "course" ? "course" : "notes", course = kind === "course" ? null : "course-c";
        await db.query("INSERT INTO nb_v2.permits(id,kind,source_key,course_id,parent_id) VALUES($1,$2,$3,$4,$5)", [id, kind, source, course, parent]);
        await db.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,course_id,parent_id,ordinal,item,document) VALUES($1,$2,$3,$4,$5,$6,1,$7::jsonb,'{}')", [run, id, kind, source, course, parent, JSON.stringify({ id, kind, slug: id, href: kind === "course" ? "/study/course-c" : "/study/course-c/notes/" + id })]);
      }
      const coursePlan = (await role("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw('course-c') AS result")).rows[0].result;
      assert.equal(coursePlan.pages.length, 3);
      const notesSql = "SELECT nb_v2_api.read_content('study-note',NULL,NULL,'{}',0,20,NULL,NULL,false) AS result";
      assert.equal((await role("nb_reader", notesSql)).rows[0].result.records.length, 2);
      await role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [randomUUID(), JSON.stringify(coursePlan)]);
      assert.equal((await role("nb_reader", notesSql)).rows[0].result.records.length, 0);
    });
    await t.test("a publication and its durable refresh event commit or roll back together", async () => {
      await db.query("UPDATE nb_cache.state SET enabled=true");
      const next = randomUUID();
      await db.query("INSERT INTO nb_v2.runs SELECT $1,fence,revision,epoch,config_digest,started_at,finished_at,valid_until,status,record_count,media_count FROM nb_v2.runs WHERE id=$2", [next, run]);
      await assert.rejects(db.transaction(async tx => { await tx.query("UPDATE nb_v2.state SET current_run=$1", [next]); throw Error("rollback"); }));
      assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_cache.events WHERE scope='content'")).rows[0].n, 0);
      await db.query("UPDATE nb_v2.state SET current_run=$1", [next]);
      assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_cache.events WHERE scope='content' AND status='pending'")).rows[0].n, 1);
    });
    await t.test("social and derivative writes enqueue one event per scope per committed transaction", async () => {
      await db.transaction(async tx => {
        await tx.exec("INSERT INTO social_sync.retained_publications VALUES('first','1'),('second','2'); UPDATE social_sync.retained_publications SET value='3'; INSERT INTO social_sync.cover_bindings VALUES('cover','1')");
      });
      assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_cache.events WHERE scope='social'")).rows[0].n, 1);
      assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_cache.events WHERE scope='media'")).rows[0].n, 1);
      await assert.rejects(db.transaction(async tx => { await tx.exec("UPDATE social_sync.retained_publications SET value='failed'"); throw Error("rollback"); }));
      assert.equal((await db.query<{ n: number }>("SELECT count(*) AS n FROM nb_cache.events WHERE scope='social'")).rows[0].n, 1);
    });
  } finally { await db.close(); }
});

test("middleware qualification uses one fixed authenticated Node endpoint, bounded responses, and never accepts unknown as found", async () => {
  let reads = 0;
  const request: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, config.origin);
    assert.equal(new URL(String(input)).pathname, "/api/internal/cache/route");
    return routeCacheLookupResponse(new Request(input, init), config, async (path, params) => {
      reads++; assert.equal(path, "/study/course"); assert.equal(params.get("x"), "1"); return "found";
    });
  };
  assert.equal(await fetchCachedRouteVerdict("/study/course?x=1", config, request), "found");
  assert.equal(reads, 1);
  assert.equal((await routeCacheLookupResponse(new Request(config.origin + "/api/internal/cache/route?target=/study/course"), config, async () => { reads++; return "found"; })).status, 401);
  assert.equal(reads, 1);
  await assert.rejects(fetchCachedRouteVerdict("https://elsewhere.example/private", config, request));
  await assert.rejects(fetchCachedRouteVerdict("/study/course", config, async () => Response.json({ version: 1, verdict: "unknown" })));
  await assert.rejects(fetchCachedRouteVerdict("/study/course", config, async () => new Response("x".repeat(2049))));
});

test("withdrawal resume reads the committed intent, never repeats an unknown mutation, and never reports a failed purge complete", async () => {
  const plan: WithdrawalPlan = { version: 1, target: "a", runId: randomUUID(), revision: "1", epoch: "1", pages: [{ id: "a", href: "/status#a", kind: "status", slug: "a" }], assets: ["a1." + "a".repeat(64)], sharedOwnerUrl: false, leaseActive: false };
  const journal: WithdrawalJournal = { version: 1, id: event.id, siteKey: config.siteKey, origin: config.origin, databaseHash: "fixture", plan, phase: "PLANNED" };
  const calls: string[] = [], phases: string[] = [];
  const db = { async query<T>(sql: string) { calls.push(sql); let result: unknown;
    if (sql.includes(".withdraw(")) result = event;
    else if (sql.includes("read_withdraw")) result = { event, plan, denied: true };
    else if (sql.includes("complete_event")) result = true;
    return { rows: [{ result }] as T[] }; } };
  const bad = async () => new Response(null, { status: 503 });
  await assert.rejects(executeWithdrawal(journal, config, "fixture", { db, save: async j => { phases.push(j.phase); }, fetch: bad }));
  assert.deepEqual(phases, ["DENY_OUTCOME_UNKNOWN", "DENIED_PURGE_PENDING"]);
  assert.ok(!calls.some(v => v.includes("complete_event")));
  calls.length = 0;
  const request: typeof fetch = async (url) => String(url).endsWith("/purge") ? Response.json({ version: 1, siteKey: config.siteKey, id: event.id, generation: "1", purged: true }) : new Response(null, { status: 404 });
  const resumed = await executeWithdrawal({ ...journal, phase: "DENY_OUTCOME_UNKNOWN" }, config, "fixture", { db, save: async () => {}, fetch: request });
  assert.equal(resumed.phase, "COMPLETE"); assert.equal(resumed.checkedPaths?.length, 5);
  assert.ok(!calls.some(v => v.includes(".withdraw(")));
  await assert.rejects(executeWithdrawal({ ...journal, phase: "PURGED_VERIFY_PENDING", plan: { ...plan, target: "forged" } }, config, "fixture", { db, save: async () => {}, fetch: request }));
  await assert.rejects(executeWithdrawal({ ...journal, phase: "COMPLETE", plan: { ...plan, revision: "2" } }, config, "fixture", { db, save: async () => {}, fetch: request }));
  assert.equal(withdrawalTarget("https://site.example/status#a", config.origin), "/status#a");
  assert.throws(() => withdrawalTarget("https://other.example/status#a", config.origin));
});

test("refresh requires a successful receipt; loss or a wrong acknowledgement remains pending", async () => {
  const calls: string[] = [];
  const db = { async query<T>(sql: string) { calls.push(sql); return { rows: [{ result: { ...event, status: "pending" } }] as T[] }; } };
  await assert.rejects(enqueuePublicationRefresh(db, config, { scope: "content", version: "a".repeat(64), committed: false as true }));
  assert.equal(calls.length, 0);
  await assert.rejects(flushCacheEvent(db, event, config, async () => Response.json({ purged: true, id: "wrong" })));
  assert.equal(calls.length, 0);
});
