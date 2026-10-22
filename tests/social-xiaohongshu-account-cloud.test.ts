import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { hash,publicationKey } from "../scripts/social-sync/model.ts";
import { automaticNoteTarget } from "../scripts/social-sync/xiaohongshu-account.ts";
import { httpNoteObservation } from "../scripts/social-sync/xiaohongshu-http.ts";
import { httpHtml,httpTarget } from "./helpers/social-xiaohongshu-http-samples.ts";
import { createCloudTransport } from "../scripts/social-sync/cloud.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { XiaohongshuObservation } from "../scripts/social-sync/model.ts";
const files=["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql","20261012213401_social_retained_projections.sql","20261013214552_social_collection_follow_members.sql","20261013225210_social_bilibili_account_discovery.sql","20261014022855_social_xiaohongshu_http_source.sql"];
const migration="20261014040738_social_xiaohongshu_account_discovery.sql",now=()=>new Date().toISOString();
const row=(n=2)=>httpNoteObservation(httpHtml(n),automaticNoteTarget(httpTarget().accountId,httpTarget(n).publicationId),now());
const link=(n=2)=>`https://www.xiaohongshu.com/discovery/item/${httpTarget(n).publicationId}?source=webshare&xhsshare=pc_web&xsec_token=example_public_locator&xsec_source=pc_share`;
async function engine(t:{after:(f:()=>Promise<void>)=>void},install=true){
  const db=await PGlite.create();t.after(()=>db.close());await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
  for(const f of files)await db.exec(await readFile(new URL(`../supabase/migrations/${f}`,import.meta.url),"utf8"));
  const before=(await db.query("SELECT oid,proacl FROM pg_proc WHERE oid='social_sync.guard_retained_publication()'::regprocedure")).rows;
  if(install)await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),"utf8"));
  const role=(name:string):SqlExecutor=>({query:async<T>(sql:string,values?:unknown[])=>{await db.exec(`SET SESSION AUTHORIZATION ${name}`);try{return await db.query<T>(sql,values);}finally{await db.exec("SET SESSION AUTHORIZATION postgres");}}});
  const worker=role("nb_social_worker"),reader=role("nb_social_reader");
  const ingest=(p:XiaohongshuObservation,u:string|null=link(Number(p.publicationId)),checked:string|null=now())=>worker.query("SELECT key,sha256 FROM social_sync.ingest_xiaohongshu_account($1,$2,$3,$4,$5)",[publicationKey(p),hash(JSON.stringify(p)),JSON.stringify(p),u,checked]);
  const enable=()=>db.query("INSERT INTO social_sync.xiaohongshu_accounts(account_id,enabled) VALUES($1,true)",[httpTarget().accountId]);
  return {db,before,worker,reader,ingest,enable};
}
test("account preflight is default-off and grants no policy/table access to worker or reader",async t=>{
  const e=await engine(t),p=row();await assert.rejects(e.ingest(p),/UNAUTHORIZED/);
  await assert.rejects(createCloudTransport(e.worker,undefined,false,true,{accountId:p.accountId,link:()=>null}),{code:"XHS_ACCOUNT_PROTOCOL_REQUIRED"});
  await e.enable();await createCloudTransport(e.worker,undefined,false,true,{accountId:p.accountId,link:()=>null});
  await assert.rejects(e.worker.query("UPDATE social_sync.xiaohongshu_accounts SET enabled=true"),/permission denied/);
  await assert.rejects(e.worker.query("SELECT * FROM social_sync.xiaohongshu_auto_bindings"),/permission denied/);
  await assert.rejects(e.reader.query("SELECT social_sync.xiaohongshu_account_enabled($1)",[p.accountId]),/permission denied/);
  assert.deepEqual((await e.db.query("SELECT oid,proacl FROM pg_proc WHERE oid='social_sync.guard_retained_publication()'::regprocedure")).rows,e.before);
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,0);
});
test("new owned HTTP and browser observations enroll atomically, replay once, and preserve real times",async t=>{
  const e=await engine(t);await e.enable();const p=row(),key=publicationKey(p);await e.ingest(p);
  await e.ingest(p);let items=(await readRetainedSocialSnapshot(e.reader)).items;assert.equal(items.length,1);assert.equal(items[0]!.publications[0]!.originalUrl,link());assert.equal(items[0]!.publications[0]!.observedAt,p.observedAt);
  const browser={...row(3),source:"browser-note-state" as const};await e.ingest(browser);items=(await readRetainedSocialSnapshot(e.reader)).items;assert.equal(items.length,2);
  const first=(await e.db.query("SELECT reviewed_at,approved_source_sha256,link_checked_at,outbound_url FROM social_sync.retained_publications WHERE publication_key=$1",[key])).rows;
  const next={...p,observedAt:now(),metrics:{...p.metrics,comments:7},metricDisplay:{...p.metricDisplay,comments:"7"}};await e.ingest(next,null,null);
  assert.deepEqual((await e.db.query("SELECT reviewed_at,approved_source_sha256,link_checked_at,outbound_url FROM social_sync.retained_publications WHERE publication_key=$1",[key])).rows,first);
  assert.equal((await e.db.query<{n:number}>("SELECT count(*)::int n FROM social_sync.xiaohongshu_auto_bindings")).rows[0]!.n,2);
});
test("foreign accounts, wrong work/link, stale new evidence and withdrawn approvals cannot expand scope",async t=>{
  const e=await engine(t);await e.enable();const p=row();
  await assert.rejects(e.ingest({...p,accountId:"9".repeat(24)}),/UNAUTHORIZED/);
  await assert.rejects(e.ingest({...p,workId:"other-work"}),/WORK/);
  await assert.rejects(e.ingest(p,link(3)),/LINK/);
  await assert.rejects(e.ingest(p,link(),new Date(Date.now()-2*3600000).toISOString()),/STALE/);
  assert.equal((await e.db.query<{n:number}>("SELECT count(*)::int n FROM social_sync.bindings")).rows[0]!.n,0);
  await e.ingest(p);await e.db.query("UPDATE social_sync.retained_publications SET approved=false WHERE publication_key=$1",[publicationKey(p)]);await e.ingest({...p,observedAt:now()});assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,0);
  await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1",[publicationKey(p)]);await assert.rejects(e.ingest(p),/BINDING/);
});
test("independent guard edits reject migration and leave no capability/table behind",async t=>{
  const e=await engine(t,false);await e.db.exec("CREATE OR REPLACE FUNCTION social_sync.guard_retained_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW;END $$;");
  await assert.rejects(e.db.exec(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),"utf8")),/BASE_CHANGED/);await e.db.exec("ROLLBACK");
  assert.equal((await e.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='social_sync' AND table_name='xiaohongshu_accounts'")).rows.length,0);
});
