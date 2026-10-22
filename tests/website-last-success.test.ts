import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {PGlite} from "@electric-sql/pglite";
import {SYNC_SCHEMA_DIGEST, type StoredMedia, type SyncRecord} from "../contracts/sync.ts";
import {WEBSITE_SCHEMA_DIGEST} from "../contracts/website-sync.ts";
import {createWebsiteWriter} from "../src/server/database/website-writer.ts";
import {createWebsiteMediaSourceWriter} from "../src/server/database/website-media-sources.ts";
import {configDigest, mediaIdentity} from "../src/server/database/validation.ts";
import {readThumbnail, createThumbnailRegistrar, type ThumbnailWidth} from "../src/server/database/thumbnail-index.ts";
import type {SqlExecutor} from "../src/server/database/sql.ts";
import {locatorIdentity, type MediaSourceBinding, type MediaSourceVersion} from "../src/server/media/notion-source.ts";
const id = (n: number) => n.toString(16).padStart(32, "0");
const owners = [id(1), id(2), id(3)];
const body = { blocks: [], toc: [], completeness: "complete" as const };
const originalBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
const originalSha = createHash("sha256").update(originalBytes).digest("hex");
const fingerprint = "a".repeat(64);
const sources = [
  { key: "statuses", kind: "status" as const, mode: "all" as const, dataSourceId: id(10), databaseParentId: null },
  { key: "courses", kind: "course" as const, mode: "allowlist" as const, dataSourceId: id(11), databaseParentId: null },
  { key: "notes", kind: "study-note" as const, mode: "allowlist" as const, dataSourceId: id(12), databaseParentId: owners[1] },
];
const permits = [
  { id: owners[1], kind: "course" as const, sourceKey: "courses", courseId: null, parentId: null },
  { id: owners[2], kind: "study-note" as const, sourceKey: "notes", courseId: owners[1], parentId: owners[1] },
];
const digest = configDigest({ sources, permits });
function media(version: MediaSourceVersion): StoredMedia[] {
  return owners.map((ownerPageId, index) => ({
    assetId: mediaIdentity(ownerPageId, locatorIdentity(index === 2 ? { kind: "block", id: id(20) } : { kind: "cover" }, version), originalSha),
    ownerPageId, objectKey: `sha256/${originalSha}`, sha256: originalSha, byteSize: originalBytes.length,
    mime: "image/png", width: 1, height: 1,
  }));
}
function bindings(version: MediaSourceVersion): MediaSourceBinding[] {
  return media(version).map((m, index) => ({ assetId: m.assetId, ownerPageId: m.ownerPageId, sha256: m.sha256,
    locator: index === 2 ? { kind: "block", id: id(20) } : { kind: "cover" }, delivery: "notion", sourceFingerprint: fingerprint }));
}
function records(version: MediaSourceVersion): SyncRecord[] {
  const images = media(version);
  const base = (index: number, kind: "status" | "course" | "study-note") => ({
    id: owners[index], kind, slug: owners[index], title: "Fictional content", summary: null, tags: [], updatedAt: null,
    href: kind === "status" ? `/status#${owners[index]}` : kind === "course" ? `/study/${owners[index]}` : `/study/${owners[1]}/notes/${owners[index]}`,
    cover: { id: images[index].assetId, src: `/media/${version === "v2" ? "v2/" : ""}${images[index].assetId}`, alt: "Fictional image", width: 1, height: 1 },
  });
  const evidence = (index: number) => ({ sourceKey: sources[index].key, dataSourceId: sources[index].dataSourceId,
    databaseParentId: sources[index].databaseParentId, courseId: index === 2 ? owners[1] : null, parentId: index === 2 ? owners[1] : null, ordinal: index });
  return [
    { detail: { item: { ...base(0, "status"), kind: "status", recordedAt: null, text: [] }, document: body }, evidence: evidence(0) },
    { detail: { item: { ...base(1, "course"), kind: "course", code: "FICTION", semester: null, ratings: { experience: null, usefulness: null, recommendation: null, difficulty: null } }, document: body }, evidence: evidence(1) },
    { detail: { item: { ...base(2, "study-note"), kind: "study-note", courseId: owners[1], parentId: null, noteType: "note", date: null, breadcrumbs: [] }, document: body }, evidence: evidence(2) },
  ];
}
// Index tests use fictional output metadata; encoder tests separately verify actual pixels/bytes.
function thumbnail(parent: StoredMedia, widthCap: ThumbnailWidth = 400, outputSha = "b".repeat(64)): StoredMedia {
  return { assetId: mediaIdentity(parent.ownerPageId, `thumbnail:${widthCap}:${parent.assetId}`, outputSha),
    ownerPageId: parent.ownerPageId, objectKey: `sha256/${outputSha}`, sha256: outputSha, byteSize: 100,
    mime: "image/webp", width: 1, height: 1 };
}

import protocol from "../database/website-availability-protocol.json" with {type:"json"};
const migration = new URL("../supabase/migrations/20261016121202_website_last_success.sql",import.meta.url);
test("last-success reader policy retains only current published content and preserves write deadlines",async t=>{
 const db=await PGlite.create();
 try {
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
  for(const path of ["database/migrations/001_content.sql","database/website-migrations/001_website.sql","database/website-media-migrations/001_website_media_sources.sql","supabase/migrations/20261011123536_media_thumbnails.sql"])
   await db.exec(await readFile(new URL("../"+path,import.meta.url),"utf8"));
  await db.query("UPDATE nb.state SET schema_digest=$1",[SYNC_SCHEMA_DIGEST]);
  await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
  const beforeV1=(await db.query("SELECT pg_get_functiondef('nb.current_snapshot()'::regprocedure) AS definition")).rows;
  const leaseBefore=(await db.query("SELECT pg_get_functiondef('nb_v2.assert_lease(uuid,bigint)'::regprocedure) AS definition")).rows;
  const availabilitySQL=await readFile(migration,"utf8");assert.equal(createHash("sha256").update(availabilitySQL).digest("hex"),protocol.migrations[0].sha256);await db.exec(availabilitySQL);
  assert.deepEqual((await db.query("SELECT pg_get_functiondef('nb.current_snapshot()'::regprocedure) AS definition")).rows,beforeV1);
  assert.deepEqual((await db.query("SELECT pg_get_functiondef('nb_v2.assert_lease(uuid,bigint)'::regprocedure) AS definition")).rows,leaseBefore);
  const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
  const reader=role("nb_reader"),worker=role("nb_writer"),writer=createWebsiteWriter(worker),index=createWebsiteMediaSourceWriter(worker);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",[digest,JSON.stringify(sources.map(s=>({...s,pageId:null}))),JSON.stringify(permits)]);
  async function publish(includeStatus=true){const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,records("v2").slice(includeStatus?0:1),media("v2").slice(includeStatus?0:1));await index.stage(lease,bindings("v2").slice(includeStatus?0:1));await writer.promote(lease,{records:includeStatus?3:2,media:includeStatus?3:2,complete:true});return lease;}
  const first=await publish();const parent=media("v2")[0];
  const registration={version:"v2" as const,runId:first.runId,assetId:parent.assetId,sourceSha256:parent.sha256,sourceFingerprint:fingerprint,widthCap:400 as const,thumbnail:thumbnail(parent)};
  const registrar=createThumbnailRegistrar(worker);await registrar.register(registration);
  const snapshot=async()=>((await reader.query<{result:{records:unknown[]}}>("SELECT nb_v2_api.read_snapshot(ARRAY['status','course','study-note'],false) AS result")).rows[0].result);
  await t.test("opt-in retains expired content and thumbnails without rewriting expiry or current state",async()=>{
   await db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second' WHERE id=$1",[first.runId]);
   await assert.rejects(snapshot(),/NB_UNAVAILABLE/);
   const prior=(await db.query("SELECT row_to_json(r) AS r FROM nb_v2.runs r WHERE id=$1",[first.runId])).rows;
   await db.exec("UPDATE nb_availability.policy SET retain_last_success=true");
   assert.equal((await snapshot()).records.length,3);
   assert.deepEqual((await readThumbnail(reader,"v2",parent.assetId,400))?.thumbnail,registration.thumbnail);
   assert.deepEqual((await db.query("SELECT row_to_json(r) AS r FROM nb_v2.runs r WHERE id=$1",[first.runId])).rows,prior);
   await assert.rejects(registrar.register(registration));
   await assert.rejects(worker.query("SELECT nb_thumbnail_api.register_media($1,$2,$3,$4,$5,$6,$7::jsonb)",["v2",first.runId,parent.assetId,parent.sha256,fingerprint,400,JSON.stringify(registration.thumbnail)]),/NB_UNAVAILABLE/);
  });
  await t.test("staging and failed updates preserve current; expired staging still cannot write or publish",async()=>{
   const stage=await writer.begin(randomUUID(),digest);await writer.stage(stage,records("v2").slice(0,1));
   assert.equal((await snapshot()).records.length,3);
   await db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second' WHERE id=$1",[stage.runId]);
   await assert.rejects(writer.stage(stage,[]));await assert.rejects(writer.promote(stage,{records:1,media:0,complete:true}));
   await writer.fail(stage);assert.equal((await snapshot()).records.length,3);
  });
  await t.test("owner and ancestor denial still remove retained content and media",async()=>{
   await db.query("SELECT nb_v2_api.set_denied($1,true)",[owners[0]]);assert.equal(await readThumbnail(reader,"v2",parent.assetId,400),null);assert.equal((await snapshot()).records.length,2);
   await db.query("SELECT nb_v2_api.set_denied($1,true)",[owners[1]]);assert.equal((await snapshot()).records.length,0);
   await db.query("SELECT nb_v2_api.set_denied($1,false)",[owners[0]]);await db.query("SELECT nb_v2_api.set_denied($1,false)",[owners[1]]);
  });
  await t.test("reader, writer and API roles cannot change mode or bypass the registration wrapper",async()=>{
   for(const name of ["nb_reader","nb_writer","anon","authenticated","service_role"]){
    await assert.rejects(role(name).query("UPDATE nb_availability.policy SET retain_last_success=false"),/permission denied/);
    await assert.rejects(role(name).query("SELECT nb_availability.register_qualified_legacy(NULL,NULL,NULL,NULL,NULL,NULL,NULL)"),/permission denied/);
   }
  });
  await t.test("successful replacement switches atomically and deletion is not resurrected",async()=>{
   const next=await publish(false);assert.notEqual(next.runId,first.runId);assert.equal((await snapshot()).records.length,2);assert.equal(await readThumbnail(reader,"v2",parent.assetId,400),null);
   await db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second' WHERE id=$1",[next.runId]);assert.equal((await snapshot()).records.length,2);
   for(const status of ["staging","failed"]){await db.query("UPDATE nb_v2.runs SET status=$1 WHERE id=$2",[status,next.runId]);await assert.rejects(snapshot(),/NB_UNAVAILABLE/);}
   await db.query("UPDATE nb_v2.runs SET status='published' WHERE id=$1",[next.runId]);
   await db.exec("UPDATE nb_v2.state SET epoch=epoch+1");await assert.rejects(snapshot(),/NB_UNAVAILABLE/);await db.exec("UPDATE nb_v2.state SET epoch=epoch-1");
   await db.exec("UPDATE nb_availability.policy SET retain_last_success=false");await assert.rejects(snapshot(),/NB_UNAVAILABLE/);
  });
 }finally{await db.close();}
});
