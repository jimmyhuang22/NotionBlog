import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollectionCapture,inspectCollectionCapture} from '../scripts/website-sync/collection-capture.ts';
import {PGlite} from '@electric-sql/pglite';
import {createDemo,demoId,demoParagraph} from '../scripts/notion-sync/demo.ts';
import {runWebsiteSync,websitePolicy} from '../scripts/website-sync/worker.ts';
import {createWebsiteWriter} from '../src/server/database/website-writer.ts';
import {createWebsiteDatabaseRepository} from '../src/server/database/website-repository.ts';
import {WEBSITE_SCHEMA_DIGEST} from '../contracts/website-sync.ts';
import type {SqlExecutor} from '../src/server/database/sql.ts';

const MiB=1024*1024;
test('a real above-16MiB collection publishes through bounded SQL batches and exports through pinned reader pages',async()=>{
 const demo=createDemo(50),config={schemaVersion:2,sources:[{...demo.config.sources[0],kind:'game'}]};
 const bodies=new Map(Array.from({length:50},(_,i)=>{const id=demoId(1000+i);return [id,Array.from({length:350},(_,j)=>demoParagraph(demoId(100000+i*1000+j),id,'x'.repeat(1000)))] as const;}));
 const client={...demo.client,listBlocks:async(id:string)=>bodies.get(id)??[]};
 await assert.rejects(runWebsiteSync({client,config,mode:'dry-run'}),/snapshot exceeds supported size/);
 const db=await PGlite.create(),root=await realpath(await mkdtemp(join(tmpdir(),'large-capture-')));try{
  await db.exec(await readFile(new URL('../database/website-migrations/001_website.sql',import.meta.url),'utf8'));
  await db.query('UPDATE nb_v2.state SET schema_digest=$1',[WEBSITE_SCHEMA_DIGEST]);
  const policy=await websitePolicy(client,config,3600);
  await db.query('SELECT nb_v2_api.configure_policy($1,3600,$2::jsonb,$3::jsonb)',[policy.configDigest,JSON.stringify(policy.sources),JSON.stringify(policy.permits)]);
  const writer=createWebsiteWriter(db),runId=randomUUID(),identity={runId,configDigest:policy.configDigest,sourceSha256:'b'.repeat(64),releaseCommit:'a'.repeat(40)};
  const directory=join(root,'capture'),capture=await createCollectionCapture(directory,identity);
  const result=await runWebsiteSync({client,config,mode:'publish',maxCollectionBytes:32*MiB,writer:{...writer,begin:(_id,digest)=>writer.begin(runId,digest)},captureCollection:capture,storage:{put:async()=>assert.fail('No media'),read:async()=>assert.fail('No media')}});
  const inspected=await inspectCollectionCapture(directory,identity);assert.equal(inspected.pages,50);assert.equal(inspected.collectionComplete,true);assert.ok(inspected.bytes>16*MiB);
  assert.equal(result.records,50);assert.equal(result.outcome,'publish');
  const restricted:SqlExecutor={query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE nb_reader');return tx.query<T>(sql,values);})};
  // The frozen aggregate function continues to enforce its original cap.
  await assert.rejects(createWebsiteDatabaseRepository(restricted).readSnapshot!(['game'],true),{code:'CONTENT_UNAVAILABLE'});
  let calls=0;
  const paged={query:<T>(sql:string,values?:unknown[])=>{calls++;return restricted.query<T>(sql,values);}};
  const snapshot=await createWebsiteDatabaseRepository(paged,{snapshotPageSize:10,maxSnapshotBytes:32*MiB}).readSnapshot!(['game'],true);
  assert.equal(snapshot.records.length,50);assert.ok(Buffer.byteLength(JSON.stringify(snapshot))>16*MiB);assert.equal(calls,7);
  assert.equal(snapshot.records[0].document!.blocks.length,350);
  await assert.rejects(createWebsiteDatabaseRepository(restricted,{snapshotPageSize:10,maxSnapshotBytes:MiB}).readSnapshot!(['game'],true),/byte budget/);
  let changed=false;
  const revoked:SqlExecutor={query:async<T>(sql:string,values?:unknown[])=>{
   const result=await restricted.query<T>(sql,values);
   if(!changed&&sql.includes('nb_v2_api.read_content')){changed=true;await db.query('UPDATE nb_v2.state SET revision=revision+1');}
   return result;
  }};
  await assert.rejects(createWebsiteDatabaseRepository(revoked,{snapshotPageSize:10,maxSnapshotBytes:32*MiB}).readSnapshot!(['game'],true),{code:'INVALID_QUERY'});
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});

test('capacity options reject unsafe values before collection or reader transport',async()=>{
 const demo=createDemo(1),config={schemaVersion:2,sources:[{...demo.config.sources[0],kind:'game'}]};
 for(const value of [0,-1,64*MiB+1,NaN,1.5]){
  await assert.rejects(runWebsiteSync({client:demo.client,config,mode:'dry-run',maxCollectionBytes:value}),{code:'MISCONFIGURED'});
  assert.throws(()=>createWebsiteDatabaseRepository({query:async()=>assert.fail('No SQL')},{snapshotPageSize:10,maxSnapshotBytes:value}),{code:'MISCONFIGURED'});
 }
 for(const pageSize of [0,101,1.5])assert.throws(()=>createWebsiteDatabaseRepository({query:async()=>assert.fail('No SQL')},{snapshotPageSize:pageSize}),{code:'MISCONFIGURED'});
});
