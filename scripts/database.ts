import { readFile,writeFile,mkdir } from "node:fs/promises";
import { resolve,sep } from "node:path";
import { createHash } from "node:crypto";
import protocol from "../database/protocol.json" with {type:"json"};
import readerProtocol from "../database/reader-protocol.json" with {type:"json"};
import mediaProtocol from "../database/media-protocol.json" with {type:"json"};
import { createDatabasePool } from "../src/server/database/connection.ts";
import type { PublicationPolicy } from "../contracts/sync.ts";
import { exportDatabaseArchive,restoreDatabaseArchive,archivedObjects,type DatabaseArchive } from "../src/server/database/archive.ts";
import { createSupabaseStorage } from "../src/server/database/storage.ts";
import { validateMedia } from "../src/server/database/validation.ts";

function privatePath(input:string|undefined):string {
  if(!input)throw new Error("A private path is required.");
  const base=resolve(".local"),path=resolve(input);
  if(!path.startsWith(base+sep))throw new Error("Input/output must be inside ignored .local/.");return path;
}
const storage=(role:"reader"|"writer")=>createSupabaseStorage({url:process.env.STORAGE_URL??"",bucket:process.env.STORAGE_BUCKET??"",
  apiKey:process.env.STORAGE_API_KEY??"",token:(role==="reader"?process.env.STORAGE_READ_TOKEN:process.env.STORAGE_WRITE_TOKEN)??"",role});

/** Operator CLI. Invoke with a private --env-file; never deployed or called by the website. */
async function main() {
  const [command,input]=process.argv.slice(2);
  if(!["migrate","migrate-reader","migrate-media","policy","deny","allow","verify","export","restore"].includes(command??""))throw new Error("Unsupported database command.");
  const pool=createDatabasePool(process.env.DATABASE_MIGRATION_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT);
  const client=await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(172904,1)");
    if(command==="migrate") {
      for(const migration of protocol.migrations) {
        const sql=await readFile(new URL(`../database/migrations/${migration.file}`,import.meta.url),"utf8");
        if(createHash("sha256").update(sql).digest("hex")!==migration.sha256)throw new Error("Migration digest mismatch.");
        const exists=(await client.query("SELECT to_regclass('nb.migrations') AS registry")).rows[0].registry;
        const prior=exists?(await client.query("SELECT digest FROM nb.migrations WHERE version=$1",[migration.version])).rows[0]:null;
        if(prior?.digest&&prior.digest!==migration.sha256)throw new Error("Applied migration differs from this repository.");
        if(!prior)await client.query(sql);
        await client.query("UPDATE nb.migrations SET digest=$1 WHERE version=$2",[migration.sha256,migration.version]);
      }
      await client.query("UPDATE nb.state SET schema_digest=$1",[protocol.schemaDigest]);
      console.log("Database migrations verified.");
    }
    if(command==="migrate" || command==="migrate-reader") {
      const state=(await client.query("SELECT schema_digest FROM nb.state")).rows[0];
      if(state?.schema_digest!==protocol.schemaDigest)throw new Error("Install the matching core migration first.");
      for(const migration of readerProtocol.migrations) {
        const sql=await readFile(new URL(`../database/reader-migrations/${migration.file}`,import.meta.url),"utf8");
        if(createHash("sha256").update(sql).digest("hex")!==migration.sha256)throw new Error("Reader migration digest mismatch.");
        const exists=(await client.query("SELECT to_regclass('nb.reader_migrations') AS registry")).rows[0].registry;
        const prior=exists?(await client.query("SELECT digest FROM nb.reader_migrations WHERE version=$1",[migration.version])).rows[0]:null;
        if(prior?.digest && prior.digest!==migration.sha256)throw new Error("Applied reader migration differs from this repository.");
        if(!prior)await client.query(sql);
        await client.query("UPDATE nb.reader_migrations SET digest=$1 WHERE version=$2",[migration.sha256,migration.version]);
      }
      console.log("Website reader migrations verified; worker handshake unchanged.");
    } else if(command==="migrate-media") {
      const state=(await client.query("SELECT schema_digest FROM nb.state")).rows[0];
      if(state?.schema_digest!==protocol.schemaDigest)throw new Error("Install the matching core migration first.");
      for(const migration of mediaProtocol.migrations) {
        const sql=await readFile(new URL(`../database/media-migrations/${migration.file}`,import.meta.url),"utf8");
        if(createHash("sha256").update(sql).digest("hex")!==migration.sha256)throw new Error("Media migration digest mismatch.");
        const exists=(await client.query("SELECT to_regclass('nb_media.migrations') AS registry")).rows[0].registry;
        const prior=exists?(await client.query("SELECT digest FROM nb_media.migrations WHERE version=$1",[migration.version])).rows[0]:null;
        if(prior?.digest && prior.digest!==migration.sha256)throw new Error("Applied media migration differs from this repository.");
        if(!prior)await client.query(sql);
        await client.query("UPDATE nb_media.migrations SET digest=$1 WHERE version=$2",[migration.sha256,migration.version]);
      }
      console.log("Media source migrations verified; a fresh indexed sync is required.");
    } else if(command==="policy") {
      const policy=JSON.parse(await readFile(privatePath(input),"utf8")) as PublicationPolicy;
      await client.query("SELECT nb_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[policy.configDigest,policy.freshnessSeconds,JSON.stringify(policy.sources),JSON.stringify(policy.permits)]);
      console.log("Policy installed; a full snapshot is required before database reads.");
    } else if(command==="deny"||command==="allow") {
      if(!input||!/^[a-zA-Z0-9_-]{1,128}$/.test(input))throw new Error("A canonical page ID is required.");
      await client.query("SELECT nb_api.set_denied($1,$2)",[input,command==="deny"]);
      console.log("Publication eligibility updated.");
    } else if(command==="export") {
      const dir=privatePath(input),archive=await exportDatabaseArchive(client);
      await mkdir(dir,{recursive:true,mode:0o700});await writeFile(resolve(dir,"content.json"),JSON.stringify(archive),{mode:0o600,flag:"wx"});
      let objects=0;
      if(process.argv.includes("--media")) {
        const adapter=storage("reader");await mkdir(resolve(dir,"sha256"),{mode:0o700});
        for(const media of archivedObjects(archive)){validateMedia(media);await writeFile(resolve(dir,media.objectKey),await adapter.read(media),{mode:0o600,flag:"wx"});objects++;}
      }
      console.log(JSON.stringify({exported:true,mediaFiles:objects}));
    } else if(command==="restore") {
      const dir=privatePath(input),archive=JSON.parse(await readFile(resolve(dir,"content.json"),"utf8")) as DatabaseArchive;
      await restoreDatabaseArchive(client,archive);let objects=0;
      if(process.argv.includes("--media")) {
        const adapter=storage("writer");for(const media of archivedObjects(archive)){validateMedia(media);await adapter.put(media,await readFile(resolve(dir,media.objectKey)));objects++;}
      }
      console.log(JSON.stringify({restored:true,mediaFiles:objects,publicationEnabled:false}));
    } else {
      const result=await client.query("SELECT protocol,schema_digest,current_run IS NOT NULL AS has_snapshot FROM nb.state");
      if(result.rows[0]?.schema_digest!==protocol.schemaDigest)throw new Error("Database schema is incompatible.");
      const reader=(await client.query("SELECT to_regprocedure('nb_api.read_status(text,jsonb,integer,integer,uuid,bigint)') IS NOT NULL AND to_regprocedure('nb_api.status_years(text)') IS NOT NULL AS available")).rows[0].available;
      console.log(JSON.stringify({protocol:protocol.protocol,schemaMatches:true,hasSnapshot:result.rows[0].has_snapshot,statusReaderAvailable:reader}));
    }
  } finally {await client.query("SELECT pg_advisory_unlock(172904,1)").catch(()=>{});client.release();await pool.end();}
}
main().catch(()=>{console.error("Database operation failed. Check private configuration, migration version and operator permissions; provider exceptions are withheld.");process.exitCode=1;});
