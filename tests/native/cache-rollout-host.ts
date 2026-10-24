/** Real pg + real filesystem + existing shared ledger over loopback TLS to a
 * temporary Unix-only PostgreSQL. No URL/env file or real project is accepted. */
import assert from "node:assert/strict";
import { spawn,execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer,createConnection,type Socket } from "node:net";
import { createSecureContext,TLSSocket } from "node:tls";
import { mkdtemp,mkdir,open,rm,stat,realpath,readFile,writeFile,chmod,unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { setupCacheRolloutFixture } from "../helpers/cache-rollout-fixture.ts";
import { commitSQL } from "../helpers/cache-commit-fixture.ts";
import { prepareCommitMigration,readCommitRolloutFacts,type CommitRolloutPlan } from "../../scripts/public-cache/commit-rollout.ts";
import { hostFixture } from "../helpers/cache-host-fixture.ts";
import { runHostedCommitRollout } from "../../scripts/public-cache/commit-rollout-host.ts";
import { commitHostTarget,type HostCredentials } from "../../scripts/public-cache/commit-host-pg.ts";
import { hostRead,releaseHeld,type HeldFile } from "../../scripts/public-cache/commit-host-files.ts";

const [flag,bin,...extra]=process.argv.slice(2);
if(flag!=="--bin"||!bin?.startsWith("/")||extra.length)throw Error("LOCAL_POSTGRES_BIN_REQUIRED");
const binaries=await realpath(bin);
for(const name of ["postgres","initdb"]){const s=await stat(join(binaries,name));assert.ok(s.isFile()&&!(s.mode&0o022)&&(s.mode&0o111));}
const root=await realpath(await mkdtemp(join(tmpdir(),"nb-host-tls-"))),data=join(root,"data"),socket=join(root,"socket");await mkdir(socket,{mode:0o700});
const log=await open(join(root,"postgres.log"),"wx",0o600),clients:Client[]=[],sockets=new Set<Socket>(),checks:string[]=[];
let server:ReturnType<typeof spawn>|undefined,proxy:ReturnType<typeof createServer>|undefined;
const execute=promisify(execFile);
async function certificate(name:string,san:string){
 const key=join(root,name+".key"),cert=join(root,name+".crt");
 await execute("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost","-addext",`subjectAltName=${san}`],{maxBuffer:65536});await chmod(key,0o600);
 return {key:await readFile(key),cert:await readFile(cert)};
}
async function connect(){const c=new Client({host:socket,port:55432,user:"fixture_owner",database:"postgres",ssl:false,connectionTimeoutMillis:1000,statement_timeout:3000,query_timeout:4000});clients.push(c);await c.connect();return c;}
const sqlPort=(c:Client):SqlExecutor=>({query:async<T>(q:string,v?:unknown[])=>({rows:(await c.query(q,v)).rows as T[]})});
try{
 const engine=(await execute(join(binaries,"postgres"),["--version"])).stdout.trim();
 await execute(join(binaries,"initdb"),["-D",data,"--no-locale","--encoding=UTF8","--auth=trust","--username=fixture_owner"],{env:{PATH:"/usr/bin:/bin",LANG:"C",NODE_ENV:"test"}});
 server=spawn(join(binaries,"postgres"),["-D",data,"-k",socket,"-p","55432","-c","listen_addresses=","-c","unix_socket_permissions=0700","-c","fsync=off"],{stdio:["ignore",log.fd,log.fd],env:{PATH:"/usr/bin:/bin",LANG:"C",NODE_ENV:"test"}});
 let owner:Client|undefined;
 for(let n=0;n<60&&!owner;n++){try{owner=await connect();}catch{if(server.exitCode!==null)throw Error("LOCAL_POSTGRES_START_FAILED");await new Promise(ok=>setTimeout(ok,100));}}
 assert.ok(owner);assert.equal((await owner.query("SHOW listen_addresses")).rows[0].listen_addresses,"");
 await setupCacheRolloutFixture(sqlPort(owner),q=>owner!.query(q));
 await owner.query("ALTER ROLE fixture_owner PASSWORD 'fixture-password'");
 await writeFile(join(data,"pg_hba.conf"),"local all all scram-sha-256\n",{mode:0o600});await owner.query("SELECT pg_reload_conf()");
 const migration=await commitSQL(),before=await readCommitRolloutFacts(sqlPort(owner));
 await owner.query("BEGIN");await owner.query(prepareCommitMigration(migration).body);const after=await readCommitRolloutFacts(sqlPort(owner));await owner.query("ROLLBACK");
 const valid=await certificate("valid","IP:127.0.0.1,DNS:localhost"),wrong=await certificate("wrong","DNS:wrong.invalid");let context=createSecureContext(valid);
 let fault:"before"|"after"|null=null,droppedPid:number|undefined,onCommit:(()=>Promise<void>)|undefined;
 proxy=createServer(raw=>{
  sockets.add(raw);raw.on("error",()=>{});raw.once("close",()=>sockets.delete(raw));
  raw.once("data",chunk=>{
   const packet=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
   if(packet.length!==8||packet.readInt32BE(0)!==8||packet.readInt32BE(4)!==80877103){raw.destroy();return;}
   raw.write("S");const secure=new TLSSocket(raw,{isServer:true,secureContext:context}),backend=createConnection(join(socket,".s.PGSQL.55432"));
   sockets.add(secure);sockets.add(backend);secure.on("error",()=>backend.destroy());backend.on("error",()=>secure.destroy());
   secure.once("close",()=>{sockets.delete(secure);backend.destroy();});backend.once("close",()=>{sockets.delete(backend);secure.destroy();});
   let incoming=Buffer.alloc(0),outgoing=Buffer.alloc(0),startup=true,pendingDrop=false,pid:number|undefined;
   secure.on("data",chunk=>{
    incoming=Buffer.concat([incoming,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
    while(incoming.length>=(startup?4:5)){
     const size=incoming.readInt32BE(startup?0:1)+(startup?0:1);if(size<4||size>1024*1024){secure.destroy();break;}if(incoming.length<size)break;
     const frame=incoming.subarray(0,size);incoming=incoming.subarray(size);
     const commit=!startup&&frame[0]===81&&frame.subarray(5,-1).toString().trim()==="COMMIT";startup=false;
     if(commit&&fault==="before"){fault=null;droppedPid=pid;secure.destroy();backend.destroy();return;}
     if(commit&&fault==="after")pendingDrop=true;
     backend.write(frame);
    }
   });
   backend.on("data",async chunk=>{
    outgoing=Buffer.concat([outgoing,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);while(outgoing.length>=5){const size=outgoing.readInt32BE(1)+1;if(size<5||size>1024*1024){backend.destroy();break;}if(outgoing.length<size)break;
     const frame=outgoing.subarray(0,size);outgoing=outgoing.subarray(size);if(frame[0]===75)pid=frame.readInt32BE(5);
     if(pendingDrop&&frame[0]===67&&frame.subarray(5,-1).toString()==="COMMIT"){fault=null;droppedPid=pid;secure.destroy();backend.end();return;}
     if(onCommit&&frame[0]===67&&frame.subarray(5,-1).toString()==="COMMIT"){backend.pause();const hook=onCommit;onCommit=undefined;await hook();secure.write(frame);backend.resume();continue;}secure.write(frame);
    }
   });
  });
 });
 await new Promise<void>(ok=>proxy!.listen(0,"127.0.0.1",ok));const address=proxy.address();assert.ok(address&&typeof address!=="string");
 const url=new URL(`postgresql://127.0.0.1:${address.port}/postgres`);url.username="fixture_owner";url.password="fixture-password";
 const credentials:HostCredentials={url:url.href,ca:valid.cert.toString()},target=commitHostTarget(credentials).digest;let index=0;
 const make=(actions:(CommitRolloutPlan["action"]|"inspect")[],c=credentials)=>hostFixture(join(root,".local",String(++index)),before,after,commitHostTarget(c).digest,actions);
 const run=async(f:Awaited<ReturnType<typeof make>>,slot:number,c=credentials)=>{let reads=0;const result=await runHostedCommitRollout(f.manifest,f.approval,f.manifest.slots[slot].plan.operation,f.migration,async()=>{reads++;return c;});assert.equal(reads,1);return result;};
 const f=await make(["install","enable","disable"]);let cumulative=0;
 for(let i=0;i<3;i++){const r=await run(f,i);assert.equal(r.report?.verified,true);assert.equal(r.report.error,null);assert.equal(r.transport.tlsVerified,2);assert.equal(r.transport.closed,2);assert.equal(r.allClosed,true);cumulative+=r.transport.driverCalls;assert.equal(r.budget!.counters.sqlRequests+r.budget!.counters.cleanupSqlRequests,cumulative);}
 assert.equal((await owner.query("SELECT enabled FROM nb_cache.commit_config")).rows[0].enabled,false);checks.push("real TLS/SCRAM install, activation and rollback use original file locks and one cumulative shared SQL ledger");
 let reads=0;await assert.rejects(runHostedCommitRollout(f.manifest,f.approval,f.manifest.slots[0].plan.operation,f.migration,async()=>{reads++;return credentials;}));assert.equal(reads,0);checks.push("replaying an already claimed action never reads the credential again");
 for(const mode of ["before","after"] as const){
  const g=await make(["enable","inspect"]);fault=mode;const first=await run(g,0);assert.equal(first.report?.outcome,"unknown");assert.equal(first.report.holdReleased,false);assert.equal(first.allClosed,true);
  // Fixture synchronization with the known temporary backend only; production
  // inspection never polls/retries when its NOWAIT fence is busy.
  for(let n=0;n<50;n++){const busy=(await owner.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pid=$1) AS busy",[droppedPid])).rows[0].busy;if(!busy)break;await new Promise(ok=>setTimeout(ok,10));}
  const second=await run(g,1);assert.equal(second.inspection,mode==="after"?"matches-after":"matches-before");assert.equal(second.actorLocksReleased,true);
  const original=JSON.parse((await hostRead(join(g.manifest.root,`operation-${g.manifest.slots[0].plan.operation}`,"host-final.json"))).bytes.toString());assert.equal(original.report.outcome,"unknown");
  await assert.rejects(runHostedCommitRollout(g.manifest,g.approval,g.manifest.slots[0].plan.operation,g.migration,async()=>{throw Error("must not read");}));
  if(mode==="after")await owner.query("UPDATE nb_cache.commit_config SET enabled=false");
  checks.push(`lost COMMIT ${mode} forwarding preserves unknown; one fenced inspection classifies present state without rewriting the old receipt or resuming writes`);
 }
 for(const mode of ["ca","hostname"] as const){
  if(mode==="hostname")context=createSecureContext(wrong);
  const c={...credentials,ca:wrong.cert.toString()},g=await make(["enable"],c),r=await run(g,0,c);assert.equal(r.report?.outcome,"not-started");assert.equal(r.transport.driverCalls,0);assert.equal(r.transport.tlsVerified,0);assert.equal(r.transport.closed,1);assert.equal(r.allClosed,true);
  const hold=JSON.parse((await hostRead(join(g.manifest.root,`operation-${g.manifest.slots[0].plan.operation}`,"host-hold.json"))).bytes.toString()) as {files:HeldFile[]};await releaseHeld(hold.files);context=createSecureContext(valid);
  checks.push(`untrusted ${mode} is rejected before SQL and its socket is observed closed`);
 }
 const g=await make(["enable","disable"]),statePath=join(g.manifest.budget.directory,"state.json"),oldState=await readFile(statePath);
 await run(g,0);await writeFile(statePath,oldState);let credentialReads=0;
 await assert.rejects(runHostedCommitRollout(g.manifest,g.approval,g.manifest.slots[1].plan.operation,g.migration,async()=>{credentialReads++;return credentials;}));assert.equal(credentialReads,0);await owner.query("UPDATE nb_cache.commit_config SET enabled=false");checks.push("rewinding shared state between actions is refused against immutable prior receipts before any credential read");
 const isolated=await make(["enable"]),bad={...credentials,url:credentials.url.replace("fixture-password","wrong-password")};const rejected=await run(isolated,0,bad);assert.equal(rejected.transport.driverCalls,0);assert.equal(rejected.transport.closed,1);checks.push("actual PostgreSQL SCRAM authentication rejects the wrong fictional password without a SQL call");
 const journalFailure=await make(["enable"]);onCommit=()=>writeFile(join(journalFailure.manifest.root,`operation-${journalFailure.manifest.slots[0].plan.operation}`,"host-final.json"),"{}",{mode:0o600,flag:"wx"});
 const recorded=await run(journalFailure,0);assert.equal(recorded.report?.outcome,"committed");assert.equal(recorded.report.verified,true);assert.equal(recorded.error,"CACHE_HOST_STOPPED");await owner.query("UPDATE nb_cache.commit_config SET enabled=false");checks.push("a final host receipt collision returns the observed committed result and an error without rewriting the foreign file");
 const sessionFailure=await make(["enable"]),session=join(sessionFailure.manifest.root,"host-session.lock");onCommit=async()=>{await unlink(session);await writeFile(session,"foreign",{mode:0o600});};
 const preserved=await run(sessionFailure,0);assert.equal(preserved.report?.outcome,"committed");assert.equal(preserved.report.verified,true);assert.equal(preserved.error,"CACHE_HOST_SESSION");assert.equal(await readFile(session,"utf8"),"foreign");await owner.query("UPDATE nb_cache.commit_config SET enabled=false");checks.push("a foreign parent-session lock survives cleanup and cannot hide an acknowledged commit");
 console.log(JSON.stringify({passed:checks.length,checks,engine,clientTransport:"loopback verified TLS",backendTransport:"private Unix socket",authentication:"real PostgreSQL SCRAM",projectRequests:0,actualActorPrograms:false,normalEntrypointWrites:0}));
}finally{
 for(const s of sockets)s.destroy();if(proxy)await new Promise<void>(ok=>proxy!.close(()=>ok()));
 for(const c of clients.reverse()){try{await c.end();}catch{}}
 if(server&&server.exitCode===null&&server.signalCode===null){const exited=once(server,"exit"),child=server;child.kill("SIGTERM");const hard=setTimeout(()=>child.kill("SIGKILL"),5000);try{await exited;}finally{clearTimeout(hard);}}
 await log.close();await rm(root,{recursive:true,force:true});
}
