import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ContentServiceError } from "../contracts/repository.ts";
import { config, hash, publicationKey } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { createSocialRepository, socialWorksSql } from "../src/server/social/repository.ts";
import { isVerifiedPlatformUrl } from "../src/server/social/links.ts";
import { socialReaderPoolConfig, verifySocialReader } from "../src/server/social/reader.ts";
import { socialWorksResponse } from "../src/lib/content/social-http.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createSocialTimelineRepository, socialTimelineSql } from "../src/server/social/timeline-repository.ts";

const at = new Date().toISOString();
const bili = config({ version: 1, publications: [{ platform: "bilibili", workId: "shared-work", accountId: "10001", url: "https://www.bilibili.com/video/BV0000000001/" }] })[0];
const xhs = config({ version: 1, publications: [{ platform: "xiaohongshu", workId: "shared-work", accountId: "000000000000000000000001", url: "https://www.xiaohongshu.com/explore/000000000000000000000002" }] })[0];
const other = { ...bili, workId: "other-work", publicationId: "BV0000000003", url: "https://www.bilibili.com/video/BV0000000003/" };
const share = `https://www.xiaohongshu.com/discovery/item/${xhs.publicationId}?source=webshare&xhsshare=pc_web&xsec_token=${"a".repeat(32)}&xsec_source=pc_share`;
function biliRow(target = bili, observedAt = at) {
  return observation(`<script>window.__INITIAL_STATE__={"videoData":{"bvid":"${target.publicationId}","owner":{"mid":10001},"title":"Example video","stat":{"like":0,"reply":3}}}</script>`, target, observedAt);
}
function xhsRow() {
  return snapshotObservation({ version: 1, source: "browser-note-state", observedAt: at, pageUrl: xhs.url, note: {
    noteId: xhs.publicationId, userId: xhs.accountId, type: "normal", title: "Example note", time: null, lastUpdateTime: null, coverUrl: null,
    interactInfo: { likedCount: "1.2万", commentCount: "0", shareCount: null, collectedCount: "4" },
  } }, xhs, at);
}
const error = (code: string) => (e: unknown) => e instanceof ContentServiceError && e.code === code;
test("checked outbound links reject identity substitutions, credentials, arbitrary hosts and unverified canonical XHS links", () => {
  assert.equal(isVerifiedPlatformUrl("bilibili", bili.publicationId, bili.url), true);
  assert.equal(isVerifiedPlatformUrl("xiaohongshu", xhs.publicationId, share), true);
  for (const value of [xhs.url, share + "&cookie=secret", share + "#comments", share.replace("www.xiaohongshu.com", "www.xiaohongshu.com.evil.example"),
    share.replace(xhs.publicationId, "000000000000000000000099"), share.replace("https://", "https://user:secret@"), share.replace("xsec_token=", "auth="), share.replace("a".repeat(32), "%61".repeat(32))]) {
    assert.equal(isVerifiedPlatformUrl("xiaohongshu", xhs.publicationId, value), false);
  }
});
test("reader requires independent login and verified TLS and does not expose handshake details", async () => {
  const env = { SOCIAL_READER_DATABASE_URL: "postgresql://nb_social_reader.example:example@remote.example/postgres" };
  assert.equal((socialReaderPoolConfig(env).ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
  assert.equal(socialReaderPoolConfig(env).max, 2);
  assert.equal(socialReaderPoolConfig(env).idleTimeoutMillis, 5000);
  for (const url of ["postgresql://postgres:example@remote.example/postgres", "postgresql://nb_social_worker:example@remote.example/postgres", env.SOCIAL_READER_DATABASE_URL + "?sslmode=no-verify"]) {
    assert.throws(() => socialReaderPoolConfig({ SOCIAL_READER_DATABASE_URL: url }), error("MISCONFIGURED"));
  }
  assert.throws(() => socialReaderPoolConfig({ ...env, SOCIAL_READER_DATABASE_TLS: "disable" }), error("MISCONFIGURED"));
  for (const row of [{ role: "nb_social_reader", login: "postgres", version: 1, elevated: false },
    { role: "nb_social_reader", login: "nb_social_reader", version: 2, elevated: false },
    { role: "nb_social_reader", login: "nb_social_reader", version: 1, elevated: true }]) {
    await assert.rejects(verifySocialReader({ query: async () => ({ rows: [row] }) } as unknown as SqlExecutor), error("CONTENT_UNAVAILABLE"));
  }
  await verifySocialReader({ query: async () => ({ rows: [{ role: "nb_social_reader", login: "nb_social_reader", version: 1, elevated: false }] }) } as unknown as SqlExecutor);
});
test("reader Postgres eligibility and HTTP projection preserve cross-platform grouping while revocation fails closed", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
    CREATE SCHEMA nb;REVOKE ALL ON SCHEMA nb FROM PUBLIC;CREATE TABLE nb.private_content(secret text);`);
  for (const path of ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql"]) await db.exec(await readFile(new URL(`../supabase/migrations/${path}`, import.meta.url), "utf8"));
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_social_reader"), worker = role("nb_social_worker"), repo = createSocialRepository(reader);
  for (const target of [bili, xhs, other]) await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [target.platform, target.accountId, target.publicationId, target.workId]);
  for (const row of [biliRow(), xhsRow(), biliRow(other)]) await worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
  const review = async (target = bili, url: string | null = null) => db.query(`INSERT INTO social_sync.website_visibility(publication_key,work_id,approved,checked_at,valid_until,outbound_url,link_checked_at)
    VALUES($1,$2,true,$3,$3::timestamptz+interval '1 hour',$4,CASE WHEN $4::text IS NULL THEN NULL ELSE $3::timestamptz END)`, [publicationKey(target), target.workId, at, url]);
  await t.test("uploaded records are unreadable until both editorial and per-publication approval", async () => {
    assert.equal((await reader.query("SELECT payload FROM social_sync.publications")).rows.length, 0);
    assert.equal((await repo.listWorks()).total, 0);
    await db.query("INSERT INTO social_sync.works(work_id,title,occurred_at) VALUES($1,'Example work',NULL)", [bili.workId]);
    await review(bili, bili.url); await review(xhs, share);
    assert.equal((await repo.listWorks()).total, 0);
    await db.exec("UPDATE social_sync.works SET approved=true");
  });
  await t.test("one work keeps platform counters separate, unknown and zero intact, with no source identities or bodies", async () => {
    const page = await repo.listWorks(); assert.equal(page.total, 1); assert.equal(page.items[0].publications.length, 2);
    assert.equal(page.items[0].occurredAt, null); assert.equal(page.items[0].cover, null);
    const [b, x] = page.items[0].publications;
    assert.equal(b.metrics.likes, 0); assert.equal(b.metrics.comments, 3); assert.equal(b.metricDisplay.likes, "0");
    assert.equal(x.metrics.likes, null); assert.equal(x.metricDisplay.likes, "1.2万"); assert.equal(x.metrics.comments, 0); assert.equal(x.metrics.shares, null);
    assert.equal(x.kind, "image-note"); assert.equal(x.originalUrl, share); assert.equal(x.linkVerifiedAt, at);
    const serialized = JSON.stringify(page);
    for (const key of ["accountId", "publicationId", "description", "responseSha256", "payload", "websitePublicationApproved"]) assert.equal(serialized.includes(`"${key}"`), false);
    assert.equal((await reader.query("SELECT payload FROM social_sync.publications")).rows.length, 2);
    const response = await socialWorksResponse(new Request("http://example.local/api/social/works"), repo, () => true);
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, page);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  });
  await t.test("publications bound to an approved work do not gain eligibility automatically", async () => {
    const extra = { ...bili, publicationId: "BV0000000004", url: "https://www.bilibili.com/video/BV0000000004/" };
    await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [extra.platform, extra.accountId, extra.publicationId, extra.workId]);
    const row = biliRow(extra); await worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
    assert.equal((await repo.listWorks()).items[0].publications.length, 2);
  });
  await t.test("cursor pages cover the eligible set and reset after observation or eligibility changes", async () => {
    await db.query("INSERT INTO social_sync.works VALUES($1,'Another example','2026-01-01T00:00:00.000Z',true)", [other.workId]); await review(other);
    const first = await repo.listWorks({ limit: 1 }); assert.equal(first.items[0].id, other.workId); assert.equal(first.total, 2); assert.equal(first.hasMore, true);
    const second = await repo.listWorks({ limit: 1, cursor: first.nextCursor! }); assert.equal(second.items[0].id, bili.workId); assert.equal(second.hasMore, false);
    for (const cursor of ["bad", first.nextCursor! + "=", Buffer.from(JSON.stringify({ v: 1, version: "0".repeat(64), offset: 1 })).toString("base64url")]) await assert.rejects(repo.listWorks({ cursor }), error("INVALID_QUERY"));
    const row = biliRow(other, new Date(Date.parse(at) + 1).toISOString()); row.metrics.likes = 1;
    await worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
    await assert.rejects(repo.listWorks({ cursor: first.nextCursor! }), error("INVALID_QUERY"));
    const updated = await repo.listWorks({ limit: 1 }); await db.query("UPDATE social_sync.website_visibility SET approved=false WHERE publication_key=$1", [publicationKey(other)]);
    await assert.rejects(repo.listWorks({ cursor: updated.nextCursor! }), error("INVALID_QUERY"));
  });
  await t.test("reader and uploader cannot approve, edit qualifications, change credentials, write/delete data or read old content", async () => {
    for (const executor of [reader, worker]) for (const sql of ["UPDATE social_sync.works SET approved=true", "DELETE FROM social_sync.website_visibility",
      "SELECT social_sync.configure_reader_password('" + "a".repeat(64) + "')", "SELECT * FROM nb.private_content"]) await assert.rejects(executor.query(sql), /permission denied/);
    for (const sql of ["SELECT account_id FROM social_sync.bindings", "DELETE FROM social_sync.publications", "SELECT * FROM social_sync.ingest('x','x','{}')"]) await assert.rejects(reader.query(sql), /permission denied/);
    for (const name of ["anon", "authenticated", "service_role", "nb_reader"]) await assert.rejects(role(name).query("SELECT * FROM social_sync.website_publications"), /permission denied/);
    const view = (await db.query<{ reloptions: string[] }>("SELECT reloptions FROM pg_class WHERE oid='social_sync.website_publications'::regclass")).rows[0];
    assert.equal(view.reloptions.includes("security_invoker=true"), true);
  });
  await t.test("invalid or stale link review is rejected; current null link remains honest", async () => {
    for (const outbound of [xhs.url, share + "&session=private", share.replace(xhs.publicationId, "000000000000000000000099")]) {
      await assert.rejects(db.query("UPDATE social_sync.website_visibility SET outbound_url=$1 WHERE publication_key=$2", [outbound, publicationKey(xhs)]), /NB_SOCIAL_LINK_INVALID/);
    }
    await assert.rejects(db.exec("UPDATE social_sync.website_visibility SET valid_until=checked_at+interval '25 hours'"), /check constraint/);
    await assert.rejects(db.exec("UPDATE social_sync.website_visibility SET checked_at=now()+interval '1 hour',valid_until=now()+interval '2 hours',outbound_url=NULL,link_checked_at=NULL"), /NB_SOCIAL_REVIEW_FUTURE/);
    await db.query("UPDATE social_sync.website_visibility SET outbound_url=NULL,link_checked_at=NULL WHERE publication_key=$1", [publicationKey(xhs)]);
    assert.equal((await repo.listWorks()).items[0].publications[1].originalUrl, null);
  });
  await t.test("binding revocation, expired qualifications and editorial revocation hide rows immediately", async () => {
    await db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1", [publicationKey(bili)]);
    assert.equal((await repo.listWorks()).items[0].publications.length, 1);
    await db.query("UPDATE social_sync.website_visibility SET checked_at=now()-interval '2 hours',valid_until=now()-interval '1 hour' WHERE publication_key=$1", [publicationKey(xhs)]);
    assert.equal((await repo.listWorks()).total, 0);
    await db.exec("UPDATE social_sync.works SET approved=false"); assert.equal((await repo.listWorks()).total, 0);
  });
  await t.test("stale observations cannot be revived by a new qualification", async () => {
    const old = { ...other, workId: "stale-work", publicationId: "BV0000000009", url: "https://www.bilibili.com/video/BV0000000009/" };
    await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [old.platform, old.accountId, old.publicationId, old.workId]);
    const row = biliRow(old, new Date(Date.now() - 25 * 3600_000).toISOString());
    await worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
    await db.query("INSERT INTO social_sync.works VALUES($1,'Stale example',NULL,true)", [old.workId]); await review(old);
    assert.equal((await repo.listWorks()).total, 0);
  });
});
test("HTTP source failure has no private details or mock fallback; disabled source never reads SQL", async () => {
  let reads = 0;
  const repo = createSocialRepository({ query: async () => { reads++; throw Error("private credentials/source ID"); } });
  const request = (q = "") => new Request("http://example.local/api/social/works" + q);
  assert.equal((await socialWorksResponse(request(), repo, () => false)).status, 404); assert.equal(reads, 0);
  for (const q of ["?limit=0", "?limit=21", "?limit=1&limit=2", "?cursor=", "?account=10001"]) {
    const response = await socialWorksResponse(request(q), repo, () => true); assert.equal(response.status, 400); assert.equal(reads, 0);
  }
  const response = await socialWorksResponse(request(), repo, () => true); assert.equal(response.status, 503); assert.equal(reads, 1);
  assert.equal((await response.text()).includes("private credentials"), false);
  const bounded = createSocialRepository({ query: async sql => { assert.equal(sql, socialWorksSql); return { rows: Array(501).fill({ work: {} }) }; } } as SqlExecutor);
  await assert.rejects(bounded.listWorks(), error("CONTENT_UNAVAILABLE"));
});
test("bounded SQL reads a full 243-work directory, supports 500 works and rejects overflow rather than truncating", async t => {
  const db=await PGlite.create(); t.after(()=>db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;");
  for (const path of ["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql"]) await db.exec(await readFile(new URL(`../supabase/migrations/${path}`,import.meta.url),"utf8"));
  const reader: SqlExecutor={query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{
    await tx.exec("SET LOCAL ROLE nb_social_reader");return tx.query<T>(sql,values);
  })};
  const repo=createSocialRepository(reader);
  const seed=async (start:number,n:number,sharedWork?:string)=>{
    const rows=Array.from({length:n},(_,offset)=>{
      const i=start+offset, publicationId="BV"+String(i).padStart(10,"0"), target={...bili,publicationId,url:`https://www.bilibili.com/video/${publicationId}/`,workId:sharedWork??`example-${String(i).padStart(4,"0")}`};
      const payload=biliRow(target);return {key:publicationKey(target),payload,sha:hash(JSON.stringify(payload))};
    });
    const raw=JSON.stringify(rows);
    await db.query(`INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled)
      SELECT payload->>'platform',payload->>'accountId',payload->>'publicationId',payload->>'workId',true
      FROM jsonb_to_recordset($1::jsonb) AS x(payload jsonb)`,[raw]);
    await db.query(`INSERT INTO social_sync.publications(publication_key,observed_at,payload_sha256,payload)
      SELECT key,payload->>'observedAt',sha,payload FROM jsonb_to_recordset($1::jsonb) AS x(key text,sha text,payload jsonb)`,[raw]);
    await db.query(`INSERT INTO social_sync.works(work_id,title,occurred_at,approved)
      SELECT DISTINCT payload->>'workId','Example work',NULL,true FROM jsonb_to_recordset($1::jsonb) AS x(payload jsonb) ON CONFLICT DO NOTHING`,[raw]);
    await db.query(`INSERT INTO social_sync.website_visibility(publication_key,work_id,approved,checked_at,valid_until)
      SELECT key,payload->>'workId',true,$2::timestamptz,$2::timestamptz+interval '1 hour' FROM jsonb_to_recordset($1::jsonb) AS x(key text,payload jsonb)`,[raw,at]);
  };
  await seed(1,243);
  const seen:string[]=[];let cursor:string|undefined;
  do {
    const page=await repo.listWorks({limit:20,...(cursor?{cursor}:{})});assert.equal(page.total,243);
    seen.push(...page.items.map(w=>w.id));cursor=page.nextCursor??undefined;
  } while(cursor);
  assert.equal(seen.length,243);assert.equal(new Set(seen).size,243);
  const v2=createSocialTimelineRepository(reader);assert.equal((await v2.listWorks()).total,243);
  await seed(244,257);assert.equal((await repo.listWorks()).total,500);
  assert.equal((await v2.listWorks()).total,500);
  await seed(501,10);
  assert.equal((await reader.query(socialWorksSql)).rows.length,501); // Sentinel bounds SQL before mapping.
  await assert.rejects(repo.listWorks(),error("CONTENT_UNAVAILABLE"));
  assert.equal((await reader.query(socialTimelineSql)).rows.length,501);
  await assert.rejects(v2.listWorks(),error("CONTENT_UNAVAILABLE"));
  await db.exec("UPDATE social_sync.works SET approved=false WHERE work_id>='example-0501'");
  assert.equal((await repo.listWorks()).total,500);
  await seed(600,30,"example-0001");
  const raw=(await reader.query<{work:{id:string;publications:unknown[]}}>(socialWorksSql)).rows;
  assert.equal(raw.find(r=>r.work.id==="example-0001")!.work.publications.length,21);
  await assert.rejects(repo.listWorks(),error("CONTENT_UNAVAILABLE"));
  await assert.rejects(v2.listWorks(),error("CONTENT_UNAVAILABLE"));
});
test("reader rejects an oversized SQL projection before trusting its shape", async () => {
  const repo=createSocialRepository({query:async()=>({rows:[{work:{private:"x".repeat(8*1024*1024)}}]})} as unknown as SqlExecutor);
  await assert.rejects(repo.listWorks(),error("CONTENT_UNAVAILABLE"));
});
