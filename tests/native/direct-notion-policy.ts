/** Temporary Unix-only PostgreSQL, fictional LOGINs, no env credentials or remote target. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, realpath, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { createDirectDenyReader } from "../../src/server/database/direct-notion-policy.ts";
import { directPageDenied, withDirectPolicy } from "../../src/server/notion/direct-policy.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import protocol from "../../database/notion-direct-deny-protocol.json" with {type:"json"};
const [flag, input, ...extra] = process.argv.slice(2);
if (flag !== "--bin" || !input?.startsWith("/") || extra.length) throw Error("LOCAL_POSTGRES_BIN_REQUIRED");
const bin = await realpath(input);
for (const name of ["initdb", "postgres"]) { const s = await stat(join(bin, name)); assert.ok(s.isFile() && !(s.mode & 0o022) && (s.mode & 0o111)); }
const root = await mkdtemp(join(tmpdir(), "nb-direct-pg-")), socket = join(root, "socket"), data = join(root, "data");
await mkdir(socket, {mode:0o700}); const log = await open(join(root,"postgres.log"),"wx",0o600);
let server:ReturnType<typeof spawn>|undefined; const clients:Client[]=[];
const execute=promisify(execFile),id="0".repeat(31)+"1";
const sql=(client:Client):SqlExecutor=>({query:async<T>(s:string,p?:unknown[])=>({rows:(await client.query(s,p)).rows as T[]})});
const rejected=(e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&["MISCONFIGURED","CONTENT_UNAVAILABLE"].includes(String(e.code));
async function connect(user:string){const c=new Client({host:socket,port:55432,user,database:"postgres",connectionTimeoutMillis:2000});await c.connect();clients.push(c);return c;}
try {
  await execute(join(bin,"initdb"),["-D",data,"-A","trust","-U","postgres","--no-locale","--encoding=UTF8"]);
  server=spawn(join(bin,"postgres"),["-D",data,"-k",socket,"-p","55432","-c","listen_addresses=","-c","max_connections=12"],{stdio:["ignore",log.fd,log.fd]});
  let ready=false;
  for(let i=0;i<100;i++){if((await readFile(join(root,"postgres.log"),"utf8")).includes("ready to accept connections")){ready=true;break;}await new Promise(ok=>setTimeout(ok,25));}
  assert.equal(ready,true);const owner=await connect("postgres");
  for(const file of ["database/migrations/001_content.sql","database/website-migrations/001_website.sql",`supabase/migrations/${protocol.migration.file}`])await owner.query(await readFile(file,"utf8"));
  await owner.query("CREATE ROLE fictional_reader LOGIN;GRANT nb_reader TO fictional_reader;CREATE ROLE fictional_writer LOGIN;GRANT nb_writer TO fictional_writer;CREATE ROLE fictional_stranger LOGIN;");
  const reader=await connect("fictional_reader"),writer=await connect("fictional_writer"),stranger=await connect("fictional_stranger");
  const me=(await reader.query("SELECT current_user,session_user")).rows[0];assert.equal(me.current_user,"fictional_reader");assert.equal(me.session_user,me.current_user);
  const factory=()=>createDirectDenyReader(sql(reader),2);
  assert.equal(await withDirectPolicy(factory,()=>directPageDenied(id)),false);
  await owner.query("SELECT nb_v2_api.set_denied($1,true)",[id]);assert.equal(await withDirectPolicy(factory,()=>directPageDenied(id)),true);
  await owner.query("SELECT nb_v2_api.set_denied($1,false)",[id]);
  await assert.rejects(withDirectPolicy(factory,async()=>{assert.equal(await directPageDenied(id),false);await owner.query("SELECT nb_v2_api.set_denied($1,true)",[id]);return "partial";}),rejected);
  for(const client of [owner,writer,stranger])await assert.rejects(createDirectDenyReader(sql(client),2)([]),rejected);
  await assert.rejects(reader.query("SELECT * FROM nb_v2.denied"),/permission denied/);
  await assert.rejects(writer.query("SELECT nb_policy_api.check_denied(2,ARRAY[]::text[])"),/permission denied/);
  await owner.query("GRANT EXECUTE ON FUNCTION nb_v2_api.fail_run(uuid,bigint) TO nb_reader");await assert.rejects(factory()([]),rejected);
  await owner.query("REVOKE EXECUTE ON FUNCTION nb_v2_api.fail_run(uuid,bigint) FROM nb_reader");assert.equal((await factory()([id])).denied[0],true);
  await owner.query("GRANT SELECT(id) ON nb_v2.denied TO fictional_reader");await assert.rejects(factory()([]),rejected);
  await owner.query("REVOKE SELECT(id) ON nb_v2.denied FROM fictional_reader");assert.equal((await factory()([])).denied.length,0);
  console.log(JSON.stringify({nativeLogin:true,denied:true,policyRace:true,writerAndOwnerRejected:true,directColumnRejected:true,writerGrantRejected:true,unixOnly:true}));
} finally {
  for(const c of clients)await c.end().catch(()=>{});
  if(server&&server.exitCode===null){const ended=once(server,"exit");server.kill("SIGTERM");await ended;}
  await log.close();await rm(root,{recursive:true,force:true});
}
