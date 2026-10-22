import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import protocol from "../../database/website-protocol.json" with {type:"json"};
import mediaProtocol from "../../database/website-media-protocol.json" with {type:"json"};
import { createNotionClient } from "../../src/server/notion/client.ts";
import { createDatabasePool,sqlExecutor } from "../../src/server/database/connection.ts";
import { createWebsiteMediaSourceWriter } from "../../src/server/database/website-media-sources.ts";
import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";
import { createWebsiteImageDownloader } from "./download.ts";
import { createWebsiteImageCache } from "./image-cache.ts";
import { createHeicConverter } from "../notion-sync/heic.ts";
import { createSupabaseStorage } from "../../src/server/database/storage.ts";
import { websitePolicy,runWebsiteSync } from "./worker.ts";
import { publicationMode, publicationWriter } from "../../src/server/database/publication.ts";
import { installPublication } from "./publication-migration.ts";
import { installIncrementalPublication } from "./incremental-migration.ts";
import { installIncrementalReader } from "./incremental-reader-migration.ts";
async function main() {
  const [command,input]=process.argv.slice(2);
  if(!["migrate","migrate-media","migrate-publication","migrate-incremental","migrate-incremental-reader","policy","dry-run","stage","publish","deny","allow"].includes(command??""))throw new Error("Invalid command.");
  if(command==="migrate-publication"||command==="migrate-incremental"||command==="migrate-incremental-reader") {
    if(input!==undefined||process.argv.length!==3)throw new Error("Invalid publication migration command.");
    const pool=createDatabasePool(process.env.DATABASE_MIGRATION_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT),client=await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(172904,2)");
      if(command==="migrate-publication")await installPublication(client);
      else if(command==="migrate-incremental")await installIncrementalPublication(client);
      else await installIncrementalReader(client);
      console.log(JSON.stringify({publicationMigrationVerified:true,incrementalMigrationVerified:command==="migrate-incremental",incrementalReaderVerified:command==="migrate-incremental-reader",publicationActivated:false}));
    } finally {await client.query("SELECT pg_advisory_unlock(172904,2)").catch(()=>{});client.release();await pool.end();}
    return;
  }
  if(command==="migrate-media") {
    const pool=createDatabasePool(process.env.DATABASE_MIGRATION_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT),client=await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(172904,2)");
      const state=(await client.query("SELECT schema_digest FROM nb_v2.state")).rows[0];
      if(state?.schema_digest!==protocol.schemaDigest)throw new Error("Install the matching website migration first.");
      for(const migration of mediaProtocol.migrations){
        const sql=await readFile(new URL(`../../database/website-media-migrations/${migration.file}`,import.meta.url),"utf8");
        if(createHash("sha256").update(sql).digest("hex")!==migration.sha256)throw new Error("Website media migration differs.");
        const exists=(await client.query("SELECT to_regclass('nb_v2_media.migrations') AS registry")).rows[0].registry;
        const prior=exists?(await client.query("SELECT digest FROM nb_v2_media.migrations WHERE version=$1",[migration.version])).rows[0]:null;
        if(prior?.digest&&prior.digest!==migration.sha256)throw new Error("Installed website media migration differs.");
        if(!prior)await client.query(sql);
        await client.query("UPDATE nb_v2_media.migrations SET digest=$1 WHERE version=$2",[migration.sha256,migration.version]);
      }
      console.log(JSON.stringify({websiteMediaMigrationVerified:true,requiresFreshIndexedSync:true}));
    }finally{await client.query("SELECT pg_advisory_unlock(172904,2)").catch(()=>{});client.release();await pool.end();}return;
  }
  if(command==="migrate") {
    const sql=await readFile(new URL(`../../database/website-migrations/${protocol.migration.file}`,import.meta.url),"utf8");
    if(createHash("sha256").update(sql).digest("hex")!==protocol.migration.sha256)throw new Error("Migration differs.");
    const pool=createDatabasePool(process.env.DATABASE_MIGRATION_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT),client=await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(172904,2)");
      const exists=(await client.query("SELECT to_regclass('nb_v2.state') AS installed")).rows[0].installed;
      if(!exists){await client.query(sql);await client.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version='001'",[protocol.migration.sha256]);await client.query("UPDATE nb_v2.state SET schema_digest=$1",[protocol.schemaDigest]);}
      else {const p=(await client.query("SELECT schema_digest,(SELECT digest FROM nb_v2.migrations WHERE version='001') AS migration FROM nb_v2.state")).rows[0];if(p.schema_digest!==protocol.schemaDigest||p.migration!==protocol.migration.sha256)throw new Error("Installed version differs.");}
      console.log(JSON.stringify({websiteMigrationVerified:true,legacyWorkerUnchanged:true}));
    }finally{await client.query("SELECT pg_advisory_unlock(172904,2)").catch(()=>{});client.release();await pool.end();}return;
  }
  if(command==="deny"||command==="allow") {
    if(!input||!/^[a-zA-Z0-9_-]{1,128}$/.test(input))throw new Error("Invalid page identity.");
    const pool=createDatabasePool(process.env.DATABASE_MIGRATION_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT);
    try{await pool.query("SELECT nb_v2_api.set_denied($1,$2)",[input,command==="deny"]);console.log(JSON.stringify({websiteEligibilityUpdated:true}));}finally{await pool.end();}return;
  }
  const config=JSON.parse(process.env.NOTION_SOURCES_JSON||await readFile(process.env.NOTION_SOURCES_CONFIG||".local/notion-website.json","utf8"));
  const client=createNotionClient({token:process.env.NOTION_TOKEN??"",notionVersion:process.env.NOTION_API_VERSION});
  if(command==="policy") {
    const policy=await websitePolicy(client,config,Number(process.env.SYNC_FRESHNESS_SECONDS));
    const pool=createDatabasePool(process.env.DATABASE_MIGRATION_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT);
    try {await pool.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[policy.configDigest,policy.freshnessSeconds,JSON.stringify(policy.sources),JSON.stringify(policy.permits)]);console.log(JSON.stringify({websitePolicyInstalled:true,requiresFullPublish:true}));}finally{await pool.end();}return;
  }
  const pool=command==="dry-run"?undefined:createDatabasePool(process.env.SYNC_DATABASE_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT);
  let closeImageTransport:(()=>void)|undefined;
  try {
    const mediaProvider=process.env.SYNC_MEDIA_PROVIDER??"storage";
    if(!["storage","notion"].includes(mediaProvider))throw new Error("Invalid media source provider.");
    const storage=pool?(process.env.DATABASE_MEDIA_DIRECTORY?createLocalMediaStorage(process.env.DATABASE_MEDIA_DIRECTORY,process.env.SYNC_DATABASE_URL??"","writer"):createSupabaseStorage({url:process.env.STORAGE_URL??"",bucket:process.env.STORAGE_BUCKET??"",apiKey:process.env.STORAGE_API_KEY??"",token:process.env.STORAGE_WRITE_TOKEN??"",role:"writer"})):undefined;
    if(process.env.SYNC_IMAGE_ORIGINALS_DIRECTORY&&!process.env.SYNC_IMAGE_CACHE_DIRECTORY)throw new Error("An image cache directory is required.");
    const cache=process.env.SYNC_IMAGE_CACHE_DIRECTORY?await createWebsiteImageCache({directory:process.env.SYNC_IMAGE_CACHE_DIRECTORY,originalsDirectory:process.env.SYNC_IMAGE_ORIGINALS_DIRECTORY}):undefined;
    const download=createWebsiteImageDownloader({userAgent:process.env.SYNC_IMAGE_USER_AGENT,convertHeic:process.env.SYNC_HEIC_CONVERTER_PATH?createHeicConverter({executable:process.env.SYNC_HEIC_CONVERTER_PATH,temporaryRoot:process.env.SYNC_STATE_DIR??".local/website-sync"}):undefined},{cache});
    closeImageTransport=download.close;
    const mode=publicationMode(process.env.SYNC_PUBLICATION_MODE);
    if(mode==="published"&&mediaProvider!=="storage")throw new Error("Published content requires independent stored media.");
    const result=await runWebsiteSync({client,config,mode:command as "dry-run"|"stage"|"publish",maxMediaBytes:process.env.WEBSITE_MEDIA_MAX_BYTES===undefined?undefined:Number(process.env.WEBSITE_MEDIA_MAX_BYTES),writer:pool?publicationWriter(sqlExecutor(pool),mode):undefined,mediaSources:pool&&mediaProvider==="notion"?createWebsiteMediaSourceWriter(sqlExecutor(pool)):undefined,storage,download});
    console.log(JSON.stringify({...result,imageTransfer:download.statistics()}));
  }finally{try{closeImageTransport?.();}finally{await pool?.end();}}
}
main().catch(()=>{console.error("Website sync failed. Check the private source mappings, integration access, migration and writer permissions. Upstream details are withheld.");process.exitCode=1;});
