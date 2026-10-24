import test from "node:test";
import assert from "node:assert/strict";
import {readFile}from"node:fs/promises";
import{PGlite}from"@electric-sql/pglite";
import type{SqlExecutor}from"../src/server/database/sql.ts";
import{createCloudTransport}from"../scripts/social-sync/cloud.ts";
import{createCollectionTransport}from"../scripts/social-sync/collection-cloud.ts";
import{observation,observationFromVideoData}from"../scripts/social-sync/bilibili.ts";
import{collectionFromVideoData,collectionKey}from"../scripts/social-sync/collection.ts";
import{hash,publicationKey}from"../scripts/social-sync/model.ts";
import{readRetainedSocialSnapshot}from"../src/server/social/retained-repository.ts";
import{apiTarget,apiVideoSample,apiBody,apiHtml,apiSeasonTarget}from"./helpers/social-bilibili-api-samples.ts";
const base=["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql","20261012213401_social_retained_projections.sql","20261013214552_social_collection_follow_members.sql","20261013225210_social_bilibili_account_discovery.sql","20261014014825_social_work_covers.sql","20261014022855_social_xiaohongshu_http_source.sql"];
const file="20261024070000_social_bilibili_api_source.sql",sqlFile=(name:string)=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),"utf8");
async function database(t:{after:(f:()=>Promise<void>)=>void}){const db=await PGlite.create();t.after(()=>db.close());await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");for(const f of base)await db.exec(await sqlFile(f));return db;}
function asRole(db:PGlite,name:string):SqlExecutor{return{query:async<T>(text:string,values?:unknown[])=>{await db.exec(`SET SESSION AUTHORIZATION ${name}`);try{return await db.query<T>(text,values);}finally{await db.exec("SET SESSION AUTHORIZATION postgres");}}};}

test("additive JSON migration preserves function identity, role ACLs and retained-reader behavior",async t=>{
  const db=await database(t),worker=asRole(db,"nb_social_worker"),reader=asRole(db,"nb_social_reader"),at=new Date().toISOString(),oldAt=new Date(Date.now()-72*3600000).toISOString();
  const old=observation(apiHtml(),apiTarget,oldAt),raw=apiBody(),next=observationFromVideoData(apiVideoSample(),apiTarget,at,"public-video-api-json",hash(raw)),key=publicationKey(old);
  await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)",[old.platform,old.accountId,old.publicationId,old.workId]);
  const legacy=await createCloudTransport(worker);await legacy({key,sha256:hash(JSON.stringify(old)),observation:old});
  await db.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES($1,'Example',true)",[old.workId]);
  await db.query("INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256,outbound_url,link_checked_at) VALUES($1,$2,true,now(),'video',$3,$3,$4,$5)",[key,old.workId,hash(JSON.stringify(old)),apiTarget.url,oldAt]);
  const permissions=()=>db.query("SELECT oid,proacl,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid IN ('social_sync.valid_observation(jsonb)'::regprocedure,'social_sync.valid_collection(jsonb)'::regprocedure) ORDER BY oid");
  const before=(await permissions()).rows,roleBefore=(await db.query("SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolbypassrls FROM pg_roles WHERE rolname LIKE 'nb_social_%' ORDER BY rolname")).rows;
  assert.equal((await db.query<{valid:boolean}>("SELECT social_sync.valid_observation($1::jsonb) valid",[JSON.stringify(next)])).rows[0].valid,false);
  await assert.rejects(createCloudTransport(worker,undefined,false,false,undefined,true),{code:"BILIBILI_API_PROTOCOL_REQUIRED"});
  await db.exec(await sqlFile(file));assert.deepEqual((await permissions()).rows,before);assert.deepEqual((await db.query("SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolbypassrls FROM pg_roles WHERE rolname LIKE 'nb_social_%' ORDER BY rolname")).rows,roleBefore);
  assert.deepEqual((await db.query("SELECT version,http_note_version,bilibili_api_version FROM social_sync.meta")).rows,[{version:1,http_note_version:1,bilibili_api_version:1}]);
  const api=await createCloudTransport(worker,undefined,false,false,undefined,true);await api({key,sha256:hash(JSON.stringify(next)),observation:next});
  await assert.rejects(legacy({key,sha256:hash(JSON.stringify(next)),observation:next}),{code:"BILIBILI_API_PROTOCOL_REQUIRED"});
  const items=(await readRetainedSocialSnapshot(reader)).items;assert.equal(items.length,1);assert.equal(items[0].publications[0].observedAt,at);assert.equal(items[0].publications[0].linkVerifiedAt,oldAt);
  assert.equal((await reader.query("SELECT publication_key,payload FROM social_sync.publications")).rows.length,0);
  await assert.rejects(worker.query("UPDATE social_sync.meta SET bilibili_api_version=0"),/permission denied/);
  await assert.rejects(reader.query("SELECT social_sync.ingest($1,$2,$3)",[key,hash(JSON.stringify(next)),JSON.stringify(next)]),/permission denied/);
  const data=apiVideoSample(true),snapshot=collectionFromVideoData(data,apiSeasonTarget,at,"bilibili-collection-api-json",hash(apiBody(data))),collectionId=collectionKey(snapshot.target);
  await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES('10001','season','200',true)");
  const collection=await createCollectionTransport(worker,undefined,false,true);await collection({key:collectionId,sha256:hash(JSON.stringify(snapshot)),snapshot});
  const oldCollection=await createCollectionTransport(worker);await assert.rejects(oldCollection({key:collectionId,sha256:hash(JSON.stringify(snapshot)),snapshot}),{code:"BILIBILI_API_PROTOCOL_REQUIRED"});
  assert.equal((await db.query<{source:string}>("SELECT payload->>'source' source FROM social_sync.collection_states")).rows[0].source,"bilibili-collection-api-json");
  await db.exec("UPDATE social_sync.meta SET bilibili_api_version=0;UPDATE social_sync.collection_meta SET bilibili_api_version=0");
  await assert.rejects(createCloudTransport(worker,undefined,false,false,undefined,true),{code:"BILIBILI_API_PROTOCOL_REQUIRED"});await assert.rejects(createCollectionTransport(worker,undefined,false,true),{code:"BILIBILI_API_PROTOCOL_REQUIRED"});await createCloudTransport(worker);await createCollectionTransport(worker);
});
test("JSON migration rejects a changed validation body before adding either capability",async t=>{
  const db=await database(t);await db.exec("CREATE OR REPLACE FUNCTION social_sync.valid_collection(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN RETURN false; END $$;");
  await assert.rejects(db.exec(await sqlFile(file)),/NB_BILIBILI_API_BASE_CHANGED/);await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='social_sync' AND column_name='bilibili_api_version'")).rows.length,0);
});
test("JSON migration rejects changed validator search_path and missing protocol rows",async t=>{
 const db=await database(t);await db.exec("ALTER FUNCTION social_sync.valid_observation(jsonb) SET search_path=public");await assert.rejects(db.exec(await sqlFile(file)),/NB_BILIBILI_API_BASE_CHANGED/);await db.exec("ROLLBACK;ALTER FUNCTION social_sync.valid_observation(jsonb) SET search_path=pg_catalog;DELETE FROM social_sync.collection_meta");
 await assert.rejects(db.exec(await sqlFile(file)),/NB_BILIBILI_API_PROTOCOL_INVALID/);await db.exec("ROLLBACK");assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='social_sync' AND column_name='bilibili_api_version'")).rows.length,0);
});
