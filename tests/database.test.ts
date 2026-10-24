import { rollbackFault } from "./helpers/rollback-fault.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PublicationPolicy, SyncRecord, StoredMedia, RunLease } from "../contracts/sync.ts";
import { SYNC_SCHEMA_DIGEST } from "../contracts/sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createDatabaseWriter } from "../src/server/database/writer.ts";
import { createDatabaseRepository } from "../src/server/database/repository.ts";
import { databaseMediaResponse } from "../src/server/database/media.ts";
import { configDigest, mediaIdentity, validateSyncRecord } from "../src/server/database/validation.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { contentListResponse } from "../src/lib/content/http.ts";
import { archivedObjects,exportDatabaseArchive,restoreDatabaseArchive } from "../src/server/database/archive.ts";

const body={blocks:[],toc:[],completeness:"complete" as const};
const sources: PublicationPolicy["sources"]=[
  {key:"statuses",kind:"status",mode:"all",dataSourceId:"fiction-status-source",databaseParentId:null},
  {key:"courses",kind:"course",mode:"allowlist",dataSourceId:"fiction-course-source",databaseParentId:null},
  {key:"notes",kind:"study-note",mode:"allowlist",dataSourceId:"fiction-note-source",databaseParentId:"course-a"},
];
const permits: PublicationPolicy["permits"]=[
  {id:"course-a",kind:"course",sourceKey:"courses",courseId:null,parentId:null},
  {id:"note-a",kind:"study-note",sourceKey:"notes",courseId:"course-a",parentId:"course-a"},
  {id:"note-b",kind:"study-note",sourceKey:"notes",courseId:"course-a",parentId:"note-a"},
];
const digest=configDigest({sources,permits});
const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=","base64");
const sha=createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia={assetId:mediaIdentity("status-a","cover",sha),ownerPageId:"status-a",objectKey:`sha256/${sha}`,sha256:sha,byteSize:bytes.length,mime:"image/png",width:1,height:1};
function records(): SyncRecord[] {
  const base=(id:string,kind:"status"|"course"|"study-note")=>({id,kind,slug:id,href:kind==="status"?`/status#${id}`:kind==="course"?`/study/${id}`:`/study/course-a/notes/${id}`,title:id,summary:null,tags:["sample"],cover:null,updatedAt:null});
  const evidence=(key:string,courseId:string|null=null,parentId:string|null=null,ordinal=0)=>({sourceKey:key,dataSourceId:sources.find(s=>s.key===key)!.dataSourceId,databaseParentId:sources.find(s=>s.key===key)!.databaseParentId,courseId,parentId,ordinal});
  return [
    {detail:{item:{...base("status-a","status"),kind:"status",recordedAt:{start:"2026-01-01T23:00:00Z",end:null,precision:"datetime"},text:[{text:"Selected note",link:{kind:"internal",href:"/study/course-a/notes/note-b"}}],cover:{id:media.assetId,src:`/media/${media.assetId}`,alt:"Sample",width:1,height:1}},document:body},evidence:evidence("statuses")},
    {detail:{item:{...base("status-b","status"),kind:"status",recordedAt:null,text:[]},document:body},evidence:evidence("statuses")},
    {detail:{item:{...base("course-a","course"),kind:"course",code:"COURSE",semester:null,ratings:{experience:null,usefulness:null,recommendation:null,difficulty:null}},document:body},evidence:evidence("courses")},
    {detail:{item:{...base("note-a","study-note"),kind:"study-note",courseId:"course-a",parentId:null,noteType:"note",date:null,breadcrumbs:[]},document:body},evidence:evidence("notes","course-a","course-a")},
    {detail:{item:{...base("note-b","study-note"),kind:"study-note",courseId:"course-a",parentId:"note-a",noteType:"summary",date:null,breadcrumbs:[{title:"Parent",href:"/study/course-a/notes/note-a"}]},document:body},evidence:evidence("notes","course-a","note-a")},
  ];
}
const controlled=(code: string)=>(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code;

test("PostgreSQL migration, roles and publication lifecycle",async t=>{
  const db=await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO authenticated; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO authenticated;");
    await db.exec("CREATE ROLE nb_reader NOLOGIN BYPASSRLS");
    await assert.rejects(db.exec(await readFile(new URL("../database/migrations/001_content.sql",import.meta.url),"utf8")),/NB_ROLE_CONFIGURATION_INVALID/);
    await db.exec("ROLLBACK; ALTER ROLE nb_reader NOBYPASSRLS");
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql",import.meta.url),"utf8"));
    await db.query("UPDATE nb.state SET schema_digest=$1",[SYNC_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/reader-migrations/001_status.sql",import.meta.url),"utf8"));
    const role=(name:string): SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{
      await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);
    })});
    const reader=role("nb_reader"), writer=createDatabaseWriter(role("nb_writer")),repo=createDatabaseRepository(reader);
    async function reset(freshness=600) {
      await db.exec("TRUNCATE nb.media,nb.records,nb.runs,nb.permits,nb.sources,nb.denied,nb.tombstones; UPDATE nb.state SET current_run=NULL,lease_run=NULL,lease_until=NULL,revision=0,epoch=0,fence=0;");
      await db.query("SELECT nb_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[digest,freshness,JSON.stringify(sources),JSON.stringify(permits)]);
    }
    async function publish(): Promise<RunLease> {
      const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,records(),[media]);await writer.promote(lease,{records:5,media:1,complete:true});return lease;
    }
    const deny=(id:string)=>db.query("SELECT nb_api.set_denied($1,true)",[id]);

    await t.test("additive Status reader preserves worker handshake and confines SQL privileges",async()=>{
      await reset();await publish();
      for(const name of ["nb_writer","anon","authenticated","service_role"]) {
        await assert.rejects(role(name).query("SELECT nb_api.status_years('UTC')"),/permission denied/);
        await assert.rejects(role(name).query("SELECT nb_api.read_status('UTC','{}',0,1,NULL,NULL)"),/permission denied/);
      }
      await assert.rejects(reader.query("SELECT * FROM nb.reader_migrations"),/permission denied/);
      await assert.rejects(reader.query("SELECT nb.status_year('{}','UTC')"),/permission denied/);
      assert.equal((await db.query<{schema_digest:string}>("SELECT schema_digest FROM nb.state")).rows[0].schema_digest,SYNC_SCHEMA_DIGEST);
      assert.deepEqual(await repo.getStatusYears!(),{years:[{year:2026,count:1}],undatedCount:1,timeZone:"UTC"});
    });
    await t.test("Status years filter before pagination, agree at timezone boundaries and count only current eligibility",async()=>{
      await reset();
      const batch=records();
      const first=batch[0].detail.item;
      assert.equal(first.kind,"status");
      if(first.kind==="status") first.recordedAt={start:"2025-12-31T14:30:00Z",end:null,precision:"datetime"};
      const extra=structuredClone(batch[1]);
      extra.detail.item={...extra.detail.item,id:"status-c",slug:"status-c",href:"/status#status-c",title:"Date only",kind:"status",recordedAt:{start:"2025-12-31",end:null,precision:"date"},text:[]};
      batch.push(extra);
      const lease=await writer.begin(randomUUID(),digest);
      await writer.stage(lease,batch,[media]);await writer.promote(lease,{records:6,media:1,complete:true});
      let zone="Australia/Melbourne";
      const local=createDatabaseRepository(reader,{timeZone:()=>zone});
      assert.deepEqual(await local.getStatusYears!(),{years:[{year:2026,count:1},{year:2025,count:1}],undatedCount:1,timeZone:zone});
      assert.deepEqual((await local.list("status",{year:2026,limit:1})).items.map(i=>i.id),["status-a"]);
      assert.equal((await local.list("status",{year:2025})).items[0].id,"status-c");
      assert.equal((await local.list("status",{year:"undated"})).items[0].id,"status-b");
      assert.deepEqual((await local.list("status",{year:2024})).items,[]);
      const page=await local.list("status",{limit:1});
      await assert.rejects(local.list("status",{limit:1,year:2025,cursor:page.nextCursor!}),controlled("INVALID_QUERY"));
      zone="UTC";
      await assert.rejects(local.list("status",{limit:1,cursor:page.nextCursor!}),controlled("INVALID_QUERY"));
      assert.deepEqual((await local.getStatusYears!()).years,[{year:2025,count:2}]);
      await deny("status-a");
      assert.deepEqual((await local.getStatusYears!()).years,[{year:2025,count:1}]);
      await db.exec("UPDATE nb.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE status='published'");
      await assert.rejects(local.getStatusYears!(),controlled("CONTENT_UNAVAILABLE"));
    });
    await t.test("Status previews derive from legacy documents after current link/media redaction",async()=>{
      await reset();const batch=records();
      batch[0].detail.document={...body,blocks:[
        {id:"paragraph",type:"paragraph",text:[{text:"Selected note",link:{kind:"internal",href:"/study/course-a/notes/note-b"}}]},
        {id:"image",type:"image",image:{id:media.assetId,src:`/media/${media.assetId}`,alt:"Example",width:1,height:1},caption:[]},
      ]};
      const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,batch,[media]);await writer.promote(lease,{records:5,media:1,complete:true});
      const first=(await repo.list("status")).items[0];
      assert.equal(first.hasMoreBody,false);assert.deepEqual(first.images!.map(i=>i.id),[media.assetId]);
      assert.ok(!Object.hasOwn((await repo.get("status","status-a"))!.item,"images"));
      await deny("note-b");
      const current=(await repo.list("status")).items[0];
      assert.deepEqual(current.text,[{text:"Unavailable page",link:{kind:"unavailable"}}]);
      assert.equal(current.hasMoreBody,false);
      await deny("status-a");assert.deepEqual((await repo.list("status")).items.map(i=>i.id),["status-b"]);
    });

    await t.test("reader, writer and anonymous roles cannot access private tables or policy administration",async()=>{
      for(const name of ["nb_reader","nb_writer","anon","authenticated","service_role"]){
        await assert.rejects(role(name).query("SELECT * FROM nb.records"),/permission denied/);
        await assert.rejects(role(name).query("SELECT nb_api.set_denied('course-a',false)"),/permission denied/);
      }
      await assert.rejects(reader.query("SELECT nb_api.begin_run($1,$2,$3,$4,300)",[randomUUID(),"notionblog-sync-v1",SYNC_SCHEMA_DIGEST,digest]),/permission denied/);
      await assert.rejects(role("nb_writer").query("SELECT nb_api.read_media('anything')"),/permission denied/);
      await assert.rejects(role("anon").query("SELECT nb_api.read_media('anything')"),/permission denied/);
    });
    await t.test("unpublished database fails explicitly; provider does not return mocks",async()=>{
      await reset();await assert.rejects(repo.list("status"),controlled("CONTENT_UNAVAILABLE"));
      assert.throws(()=>createContentService({provider:"database"}),controlled("MISCONFIGURED"));
      const response=await contentListResponse(new Request("https://example.test/api/content/status"),"status",repo);
      assert.equal(response.status,503);assert.equal(response.headers.get("Cache-Control"),"no-store");
    });
    await t.test("stage is invisible, complete promotion supplies lists, detail and nested tree",async()=>{
      await reset();const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,records(),[media]);
      await assert.rejects(repo.get("course","course-a"),controlled("CONTENT_UNAVAILABLE"));
      await writer.promote(lease,{records:5,media:1,complete:true});
      assert.deepEqual((await repo.list("status")).items.map(i=>i.id),["status-a","status-b"]);
      assert.equal((await repo.get("study-note","note-b"))!.document!.completeness,"complete");
      assert.equal((await repo.getCourseMetadata!("course-a"))!.semester,null);
      assert.deepEqual((await repo.getCourseTree("course-a"))!.nodes.map(n=>[n.id,n.children!.map(c=>c.id)]),[["note-a",["note-b"]]]);
      assert.equal((await repo.getCourseTree("course-a","note-a"))!.nodes[0].id,"note-b");
      assert.equal(await repo.getCourseTree("course-a","foreign-note"),null);
      assert.equal(await repo.get("study-note","unknown"),null);
      const gated=createContentService({provider:"database",databaseRepository:repo}).repository;
      assert.deepEqual((await gated.list("game")).items,[]);
    });
    await t.test("handshake, mutex, same-run idempotence and fenced lease takeover",async()=>{
      await reset();await assert.rejects(writer.begin(randomUUID(),"0".repeat(64)),controlled("CONTENT_UNAVAILABLE"));
      await assert.rejects(role("nb_writer").query("SELECT nb_api.begin_run($1,$2,$3,$4,300)",[randomUUID(),"notionblog-sync-v1","0".repeat(64),digest]),/NB_HANDSHAKE_INVALID/);
      const id=randomUUID(),a=await writer.begin(id,digest);
      assert.deepEqual(await writer.begin(id,digest),a);
      await assert.rejects(writer.begin(randomUUID(),digest),controlled("RATE_LIMITED"));
      await db.exec("UPDATE nb.state SET lease_until=clock_timestamp()-interval '1 second'");
      const b=await writer.begin(randomUUID(),digest);assert.notEqual(b.fence,a.fence);
      await assert.rejects(writer.stage(a,records()),controlled("CONTENT_UNAVAILABLE"));
      await assert.rejects(writer.renew(a),controlled("CONTENT_UNAVAILABLE"));
      await writer.fail(a);await writer.renew(b);await writer.fail(b);
    });
    await t.test("failed, count-mismatched and missing-body runs preserve previous published data",async()=>{
      await reset();await publish();const lease=await writer.begin(randomUUID(),digest);
      const batch=records();batch[0].detail.item.title="Staged replacement";await writer.stage(lease,batch,[media]);
      for(const receipt of [{records:5,media:1,complete:false},{records:6,media:1,complete:true}])await assert.rejects(writer.promote(lease,receipt),controlled("CONTENT_UNAVAILABLE"));
      batch[0].detail.document=null;await writer.stage(lease,[batch[0]]);
      await assert.rejects(writer.promote(lease,{records:5,media:1,complete:true}),controlled("CONTENT_UNAVAILABLE"));
      await writer.fail(lease);assert.equal((await repo.get("status","status-a"))!.item.title,"status-a");
    });
    await t.test("source, course, parent and allowlist evidence are enforced inside SQL",async()=>{
      await reset();const lease=await writer.begin(randomUUID(),digest);
      for(const change of [(r:SyncRecord[])=>r[0].evidence.dataSourceId="wrong-source",(r:SyncRecord[])=>r[4].evidence.courseId="wrong-course",(r:SyncRecord[])=>r[4].evidence.parentId="course-a",(r:SyncRecord[])=>r[4].detail.item.id="unapproved-note"]){
        const batch=records();change(batch);await assert.rejects(writer.stage(lease,batch),controlled("CONTENT_UNAVAILABLE"));
        assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM nb.records")).rows[0].count,0);
      }
      await writer.stage(lease,records().filter(r=>r.detail.item.id!=="note-a"),[media]);
      await assert.rejects(writer.promote(lease,{records:4,media:1,complete:true}),controlled("CONTENT_UNAVAILABLE"));
    });
    await t.test("media references require stored descriptors owned by their public page",async()=>{
      await reset();const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,records());
      await assert.rejects(writer.promote(lease,{records:5,media:0,complete:true}),controlled("CONTENT_UNAVAILABLE"));
      await writer.stage(lease,[],[{...media,ownerPageId:"status-b"}]);
      await assert.rejects(writer.promote(lease,{records:5,media:1,complete:true}),controlled("CONTENT_UNAVAILABLE"));
      await writer.stage(lease,[],[media]);await writer.promote(lease,{records:5,media:1,complete:true});
      await writer.promote(lease,{records:5,media:1,complete:true});
    });
    await t.test("cursor binds filters, limit, generation and current policy revision",async()=>{
      await reset();await publish();const first=await repo.list("status",{limit:1});
      assert.equal((await repo.list("status",{limit:1,cursor:first.nextCursor!})).items[0].id,"status-b");
      await assert.rejects(repo.list("status",{limit:2,cursor:first.nextCursor!}),controlled("INVALID_QUERY"));
      await assert.rejects(repo.list("status",{limit:1,tag:"other",cursor:first.nextCursor!}),controlled("INVALID_QUERY"));
      await publish();await assert.rejects(repo.list("status",{limit:1,cursor:first.nextCursor!}),controlled("INVALID_QUERY"));
      const second=await repo.list("status",{limit:1});await deny("note-b");
      await assert.rejects(repo.list("status",{limit:1,cursor:second.nextCursor!}),controlled("INVALID_QUERY"));
    });
    await t.test("central denial hides descendants, incoming links, course tree and owned media",async()=>{
      await reset();await publish();await deny("note-a");
      assert.equal(await repo.get("study-note","note-b"),null);
      assert.deepEqual((await repo.getCourseTree("course-a"))!.nodes,[]);
      const status=(await repo.get("status","status-a"))!.item;
      assert.equal(status.kind,"status");if(status.kind==="status")assert.deepEqual(status.text,[{text:"Unavailable page",link:{kind:"unavailable"}}]);
      await deny("status-a");assert.equal((await databaseMediaResponse(media.assetId,reader,()=>({read:async()=>bytes,put:async()=>{}}))).status,404);
    });
    await t.test("revocation fences old tasks, while a fresh run can exclude denied subtrees",async()=>{
      await reset();await publish();const old=await writer.begin(randomUUID(),digest);await writer.stage(old,records(),[media]);await deny("note-a");
      await assert.rejects(writer.promote(old,{records:5,media:1,complete:true}),controlled("CONTENT_UNAVAILABLE"));await writer.fail(old);
      const current=await writer.begin(randomUUID(),digest);assert.deepEqual(current.deniedPageIds,["note-a"]);
      await writer.stage(current,records().filter(r=>r.detail.item.kind!=="study-note"),[media]);await writer.promote(current,{records:3,media:1,complete:true});
      assert.equal(await repo.get("study-note","note-b"),null);assert.equal((await repo.list("status")).items.length,2);
    });
    await t.test("policy edits and expired qualification fail closed instead of becoming empty content",async()=>{
      await reset();await publish();await db.query("SELECT nb_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",[digest,JSON.stringify(sources),JSON.stringify(permits)]);
      await assert.rejects(repo.list("status"),controlled("CONTENT_UNAVAILABLE"));await publish();
      await db.exec("UPDATE nb.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE status='published'");
      await assert.rejects(repo.get("status","status-a"),controlled("CONTENT_UNAVAILABLE"));
      await assert.rejects(databaseMediaResponse(media.assetId,reader,()=>({read:async()=>bytes,put:async()=>{}})),controlled("CONTENT_UNAVAILABLE"));
    });
    await t.test("confirmed archival removes an approved subtree; an unexplained missing page cannot publish",async()=>{
      await reset();await publish();const lease=await writer.begin(randomUUID(),digest);
      await writer.stage(lease,records().filter(r=>r.detail.item.kind!=="study-note"),[media]);
      await assert.rejects(writer.promote(lease,{records:3,media:1,complete:true}),controlled("CONTENT_UNAVAILABLE"));
      await assert.rejects(writer.stage(lease,[],[],[{id:"unknown",reason:"archived"}]),controlled("CONTENT_UNAVAILABLE"));
      await writer.stage(lease,[],[],[{id:"note-a",reason:"archived"}]);
      await writer.promote(lease,{records:3,media:1,confirmedAbsent:1,complete:true});
      assert.deepEqual((await repo.getCourseTree("course-a"))!.nodes,[]);assert.equal(await repo.get("study-note","note-b"),null);
    });
    await t.test("a schema digest mismatch rejects content and media without fallback",async()=>{
      await reset();await publish();await db.query("UPDATE nb.state SET schema_digest=$1",["0".repeat(64)]);
      await assert.rejects(repo.list("status"),controlled("CONTENT_UNAVAILABLE"));
      await assert.rejects(databaseMediaResponse(media.assetId,reader,()=>({read:async()=>bytes,put:async()=>{}})),controlled("CONTENT_UNAVAILABLE"));
      await db.query("UPDATE nb.state SET schema_digest=$1",[SYNC_SCHEMA_DIGEST]);
    });
    await t.test("media stays same-origin, checks digest, and rechecks denial after download",async()=>{
      await reset();await publish();let calls=0;
      const response=await databaseMediaResponse(media.assetId,reader,()=>({read:async()=>{calls++;return bytes;},put:async()=>{}}));
      assert.equal(response.status,200);assert.equal(response.headers.get("Location"),null);assert.equal(response.headers.get("Cache-Control"),"private, no-store");assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
      assert.equal((await databaseMediaResponse("m1.legacy",reader,()=>{throw Error();})).status,404);
      assert.equal((await databaseMediaResponse(media.assetId,reader,()=>({read:async()=>{await deny("status-a");return bytes;},put:async()=>{}}))).status,404);
      assert.equal(calls,1);
    });
    await t.test("policy rejects cycles, non-status all mode and cross-course parents",async()=>{
      await reset();for(const ps of [[{...permits[0]}, {...permits[1],parentId:"note-b"},permits[2]],[permits[0],{...permits[1],parentId:"foreign"},permits[2]]]){
        await assert.rejects(db.query("SELECT nb_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",[digest,JSON.stringify(sources),JSON.stringify(ps)]));
      }
      await assert.rejects(db.query("SELECT nb_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",[digest,JSON.stringify(sources.map(s=>s.kind==="course"?{...s,mode:"all"}:s)),JSON.stringify(permits)]));
    });
    await t.test("portable export restores data and object manifest without reactivating stale qualification",async()=>{
      await reset();await publish();const archive=await exportDatabaseArchive(db);
      assert.equal(archivedObjects(archive).length,1);assert.equal(archivedObjects(archive)[0].sha256,sha);
      await assert.rejects(restoreDatabaseArchive(db,archive),controlled("CONTENT_UNAVAILABLE"));
      await db.exec("TRUNCATE nb.media,nb.records,nb.runs,nb.permits,nb.sources,nb.denied,nb.tombstones;");
      await restoreDatabaseArchive(db,archive);
      assert.equal((await exportDatabaseArchive(db)).tables.records.length,5);
      await assert.rejects(repo.list("status"),controlled("CONTENT_UNAVAILABLE"));
      await publish();assert.equal((await repo.list("status")).items.length,2);
    });
    await t.test("restore rejects malformed archive state before changing the target",async()=>{
      await reset();await publish();const archive=await exportDatabaseArchive(db);
      await db.exec("TRUNCATE nb.media,nb.records,nb.runs,nb.permits,nb.sources,nb.denied,nb.tombstones;");
      const before=await exportDatabaseArchive(db);
      const variants=[
        {...archive,tables:{...archive.tables,state:[]}},
        {...archive,tables:{...archive.tables,state:[archive.tables.state[0],archive.tables.state[0]]}},
        {...archive,tables:{...archive.tables,state:[{...archive.tables.state[0],schema_digest:"incorrect"}]}},
        {...archive,tables:{...archive.tables,state:[{...archive.tables.state[0],protocol:"incorrect"}]}},
        {...archive,tables:{...archive.tables,records:[null]}},
        {...archive,tables:{...archive.tables,extra:[]}},
      ];
      for(const invalid of variants){
        await assert.rejects(restoreDatabaseArchive(db,invalid as unknown as typeof archive),controlled("CONTENT_UNAVAILABLE"));
        assert.deepEqual(await exportDatabaseArchive(db),before);
      }
    });
    await t.test("restore protects a deny-only target and rejects incompatible target versions",async()=>{
      await reset();await publish();const archive=await exportDatabaseArchive(db);
      await db.exec("TRUNCATE nb.media,nb.records,nb.runs,nb.permits,nb.sources,nb.denied,nb.tombstones; INSERT INTO nb.denied VALUES('protected-page');");
      const before=await exportDatabaseArchive(db);
      await assert.rejects(restoreDatabaseArchive(db,archive),controlled("CONTENT_UNAVAILABLE"));
      assert.deepEqual(await exportDatabaseArchive(db),before);
      await db.exec("DELETE FROM nb.denied; UPDATE nb.state SET schema_digest='incorrect';");
      await assert.rejects(restoreDatabaseArchive(db,archive),controlled("CONTENT_UNAVAILABLE"));
      assert.equal((await db.query<{schema_digest:string}>("SELECT schema_digest FROM nb.state")).rows[0].schema_digest,"incorrect");
      assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM nb.sources")).rows[0].count,0);
      await db.query("UPDATE nb.state SET schema_digest=$1",[SYNC_SCHEMA_DIGEST]);
    });
    await t.test("a late restore constraint failure rolls back state and prior table inserts",async()=>{
      await reset();await publish();const archive=await exportDatabaseArchive(db);
      await db.exec("TRUNCATE nb.media,nb.records,nb.runs,nb.permits,nb.sources,nb.denied,nb.tombstones;");
      const before=await exportDatabaseArchive(db);
      const corrupt={...archive,tables:{...archive.tables,runs:[...archive.tables.runs,archive.tables.runs[0]]}};
      await assert.rejects(restoreDatabaseArchive(db,corrupt));
      await assert.rejects(restoreDatabaseArchive(rollbackFault(db),corrupt), /duplicate key/);
      assert.deepEqual(await exportDatabaseArchive(db),before);
    });
  } finally {await db.close();}
});

test("sync records reject SDK properties, temporary media, injected paths and private references",()=>{
  const a=records()[0];validateSyncRecord(a);
  const bad=structuredClone(a);(bad.detail.item as unknown as {raw:object}).raw={token:"fictional"};assert.throws(()=>validateSyncRecord(bad));
  const temp=structuredClone(a),signed=new URL("https://example.test");signed.searchParams.set("X-Amz-Signature","fictional");temp.detail.item.cover!.src=signed.href;assert.throws(()=>validateSyncRecord(temp));
  const bodyInjection=structuredClone(a);bodyInjection.detail.document={...body,blocks:[{id:"block",type:"bookmark",title:"Private reference",url:new URL("/fiction",["https://www.","notion.so"].join("")).href,description:null}]};assert.throws(()=>validateSyncRecord(bodyInjection));
  const wrong=structuredClone(a);wrong.detail.item.href="//example.test";assert.throws(()=>validateSyncRecord(wrong));
});
