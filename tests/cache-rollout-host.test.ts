import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, readFile, unlink, chmod, link, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { setupCacheRolloutFixture } from "./helpers/cache-rollout-fixture.ts";
import { commitSQL } from "./helpers/cache-commit-fixture.ts";
import { hostFixture } from "./helpers/cache-host-fixture.ts";
import { commitCatalogDigest as digest } from "../scripts/public-cache/commit-catalog.ts";
import { readCommitRolloutFacts, prepareCommitMigration } from "../scripts/public-cache/commit-rollout.ts";
import { runHostedCommitRollout } from "../scripts/public-cache/commit-rollout-host.ts";
import { createHostHold, hostRead, validateHostGraph } from "../scripts/public-cache/commit-host-files.ts";
import { commitHostTarget,createHostConnector } from "../scripts/public-cache/commit-host-pg.ts";
import { openSharedBudget } from "../scripts/website-sync/shared-budget.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";

test("host admission and real filesystem holds precede every credential read",async t=>{
  const temp=await realpath(await mkdtemp(join(tmpdir(),"nb-host-"))),root=join(temp,".local");
  const db=new PGlite();
  try{
    await setupCacheRolloutFixture(db,q=>db.exec(q));const before=await readCommitRolloutFacts(db),migration=await commitSQL();
    await db.exec("BEGIN");await db.exec(prepareCommitMigration(migration).body);const after=await readCommitRolloutFacts(db);await db.exec("ROLLBACK");
    let n=0,credentials=0;const make=(closed=true)=>hostFixture(join(root,String(++n)),before,after,"a".repeat(64),["install"],closed);
    const loader=async()=>{credentials++;throw Error("must never read a credential");};
    await t.test("unapproved or mutated parent manifest refuses before locks, credentials and SQL",async()=>{
      const f=await make();await assert.rejects(runHostedCommitRollout(f.manifest,{...f.approval,approved:false},f.manifest.slots[0].plan.operation,f.migration,loader),/CACHE_HOST_AUTHORITY/);
      f.manifest.maxConnections++;await assert.rejects(runHostedCommitRollout(f.manifest,f.approval,f.manifest.slots[0].plan.operation,f.migration,loader),/CACHE_HOST_AUTHORITY/);assert.equal(credentials,0);
    });
    await t.test("connection reservations cannot be diluted by a negative future slot",async()=>{
      const f=await make();f.manifest.slots.push(structuredClone(f.manifest.slots[0]));f.manifest.slots[1].plan.operation=crypto.randomUUID();f.manifest.slots[1].authority.nonce=crypto.randomUUID();f.manifest.slots[1].authority.maxConnections=-20;f.manifest.slots[1].authority.planSHA256=digest(f.manifest.slots[1].plan);
      f.approval.manifestSHA256=digest(f.manifest);await assert.rejects(runHostedCommitRollout(f.manifest,f.approval,f.manifest.slots[0].plan.operation,f.migration,loader));assert.equal(credentials,0);
    });
    await t.test("missing source lease evidence stops before an actual lock or connection",async()=>{
      const f=await make(false),r=await runHostedCommitRollout(f.manifest,f.approval,f.manifest.slots[0].plan.operation,f.migration,loader);
      assert.equal(r.report?.outcome,"not-started");assert.equal(r.transport.connections,0);for(const p of f.manifest.graph.lockOrder)await assert.rejects(access(p));assert.equal(credentials,0);
    });
    await t.test("each actor kind and every original lock must be covered",async()=>{
      const f=await make(),g=structuredClone(f.manifest.graph);g.actors=g.actors.filter(a=>a.kind!=="social");assert.throws(()=>validateHostGraph(g,f.manifest.packagePins));
      const h=structuredClone(f.manifest.graph);h.lockOrder.pop();assert.throws(()=>validateHostGraph(h,f.manifest.packagePins));
    });
    await t.test("a held original worker file blocks the actual existing acquireLock implementation",async()=>{
      const f=await make(),op=f.manifest.slots[0].plan.operation;
      const hold=await createHostHold(f.manifest.graph,f.manifest.packagePins,f.manifest.closure,f.manifest.budget.nonce,op,join(f.manifest.root,"hold.json"));
      await assert.rejects(acquireLock(join(f.manifest.root,"source"),crypto.randomUUID()));await hold.verify();await hold.release();
      const release=await acquireLock(join(f.manifest.root,"source"),crypto.randomUUID());await release();
    });
    await t.test("busy actors preserve a foreign lock and unwind only earlier owned files",async()=>{
      const f=await make();const foreign=f.manifest.graph.lockOrder[2];await writeFile(foreign,"foreign",{mode:0o600});
      await assert.rejects(createHostHold(f.manifest.graph,f.manifest.packagePins,f.manifest.closure,f.manifest.budget.nonce,f.manifest.slots[0].plan.operation,join(f.manifest.root,"hold.json")));
      assert.equal(await readFile(foreign,"utf8"),"foreign");await assert.rejects(access(f.manifest.graph.lockOrder[0]));
    });
    await t.test("pin drift and foreign lock replacement reject without deleting the replacement",async()=>{
      const f=await make(),hold=await createHostHold(f.manifest.graph,f.manifest.packagePins,f.manifest.closure,f.manifest.budget.nonce,f.manifest.slots[0].plan.operation,join(f.manifest.root,"hold.json"));
      await writeFile(f.state,"changed");await assert.rejects(hold.verify());
      const path=f.manifest.graph.lockOrder[0];await unlink(path);await writeFile(path,"replacement",{mode:0o600});await assert.rejects(hold.release());assert.equal(await readFile(path,"utf8"),"replacement");
    });
    await t.test("private file modes, hardlinks and symlinks are refused",async()=>{
      const f=await make();await chmod(f.state,0o644);await assert.rejects(hostRead(f.state));await chmod(f.state,0o600);
      const other=join(f.manifest.root,"other");await link(f.state,other);await assert.rejects(hostRead(f.state));await unlink(other);
      await symlink(f.state,other);await assert.rejects(hostRead(other));
    });
    await t.test("TLS URL overrides cannot bypass explicit target and certificate binding",async()=>{
      for(const url of ["postgresql://user:synthetic@127.0.0.1/db?sslmode=disable","https://example.invalid/","postgresql://127.0.0.1/db"])
        assert.throws(()=>commitHostTarget({url,ca:"BEGIN CERTIFICATE"}));
    });
    await t.test("a credential read crossing the child deadline cannot start a socket under a later parent deadline",async()=>{
      const f=await make(),realNow=Date.now,deadline=realNow()+1000;let clock=realNow(),reads=0;
      Date.now=()=>clock;
      try{const c=createHostConnector("a".repeat(64),async()=>{reads++;clock=deadline+1;return{url:"postgresql://user:synthetic@127.0.0.1/db",ca:"BEGIN CERTIFICATE"};},openSharedBudget(f.manifest.budget),2,{businessEnd:deadline,cleanupEnd:deadline+20000});
        await assert.rejects(c.connect(),/CACHE_HOST_DEADLINE/);assert.equal(reads,1);assert.equal(c.metrics.driverCalls,0);assert.equal(c.allClosed(),true);c.clearCredentials();
      }finally{Date.now=realNow;}
    });
  }finally{await db.close();await rm(temp,{recursive:true,force:true});}
});
