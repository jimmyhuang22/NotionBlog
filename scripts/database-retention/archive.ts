import {constants} from "node:fs";
import {lstat, mkdir, open} from "node:fs/promises";
import {resolve, dirname} from "node:path";
import {PGlite} from "@electric-sql/pglite";
import type {ArchiveStore, RunArchive, SchemaArchive} from "./daily.ts";
import {hashesDigest, sha256} from "./daily.ts";
import {PAYLOAD_TABLES, type PayloadTable} from "./plan.ts";

/** Exact JSONB text is durable before any delete intent. Never round-trip row data through JS numbers. */
export async function createArchiveStore(root: string): Promise<ArchiveStore> {
  if(!root.startsWith("/"))throw Error("RETENTION_ARCHIVE_PATH_INVALID");
  const base=resolve(root);
  async function directory(path: string) {
    await mkdir(path,{recursive:true,mode:0o700});
    // Reject symlinks and writable-by-other-user directories down to the archive root.
    for(let p=path;;p=dirname(p)){
      const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error("RETENTION_ARCHIVE_PERMISSIONS");
      if(p===base)break;
    }
  }
  await directory(base);
  const pathFor=(name:string)=>{
    if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.split("/").some(x=>!x||x===".."||x==="."))throw Error("RETENTION_ARCHIVE_PATH_INVALID");
    const path=resolve(base,name);if(!path.startsWith(base+"/"))throw Error("RETENTION_ARCHIVE_PATH_INVALID");return path;
  };
  async function read(path: string):Promise<string|null> {
    let file;
    try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await file.stat();
      if(!s.isFile()||(s.mode&0o077))throw Error("RETENTION_ARCHIVE_PERMISSIONS");return await file.readFile("utf8");
    }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}finally{await file?.close();}
  }
  async function write(path:string,data:string){
    await directory(dirname(path));
    let file;
    try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await file.writeFile(data,"utf8");await file.sync();
    }catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST"||await read(path)!==data)throw e;}finally{await file?.close();}
    const folder=await open(dirname(path),constants.O_RDONLY);try{await folder.sync();}finally{await folder.close();}
    if(await read(path)!==data)throw Error("RETENTION_ARCHIVE_READBACK");
  }
  function blob(table:PayloadTable,sha:string){
    if(!PAYLOAD_TABLES.includes(table)||!/^[a-f0-9]{64}$/.test(sha))throw Error("RETENTION_ARCHIVE_KEY_INVALID");
    return pathFor(`blobs/${table}/${sha}.jsonb`);
  }
  return {getBlob:(table,sha)=>read(blob(table,sha)),putBlob:async(table,sha,data)=>{
    if(sha256(data)!==sha)throw Error("RETENTION_ARCHIVE_HASH_MISMATCH");await write(blob(table,sha),data);
  },save:async(name,value)=>{const text=JSON.stringify(value,null,2)+"\n";await write(pathFor(name+".json"),text);return sha256(text);}};
}

function tableName(value:string){if(![...PAYLOAD_TABLES,"nb_v2.runs"].includes(value as PayloadTable))throw Error("RETENTION_RESTORE_TABLE_INVALID");return value;}
/** Original column types, CHECK/PK/FK constraints and indexes in a disposable database only.
 * Never activates a batch or connects to a live database. Schema is installed from the narrow
 * metadata RPC, not from content strings. Each candidate is verified independently before deletes.
 */
export async function verifyOfflineRestore(schema:SchemaArchive,archive:RunArchive,store:ArchiveStore){
  if(schema.tables.length!==6||new Set(schema.tables.map(t=>tableName(t.name))).size!==6)throw Error("RETENTION_RESTORE_SCHEMA_INVALID");
  const db=new PGlite();
  try{
    await db.exec("CREATE SCHEMA nb_v2; CREATE SCHEMA nb_v2_media; CREATE SCHEMA nb_thumbnails;");
    for(const table of schema.tables)await db.exec(table.createSQL);
    if(sha256(archive.run.summary_json)!==archive.run.summary_sha256)throw Error("RETENTION_RESTORE_SUMMARY_INVALID");
    await db.query("INSERT INTO nb_v2.runs SELECT * FROM jsonb_populate_record(NULL::nb_v2.runs,$1::jsonb)",[archive.run.summary_json]);
    for(const table of PAYLOAD_TABLES){
      const refs=archive.tables[table];
      for(let offset=0;offset<refs.length;offset+=50){
        const data=await Promise.all(refs.slice(offset,offset+50).map(async ref=>{
          const raw=await store.getBlob(table,ref.sha);if(raw===null||sha256(raw)!==ref.sha)throw Error("RETENTION_RESTORE_BLOB_INVALID");return raw;
        }));
        // Each item stays a text parameter; jsonb concatenation happens inside PostgreSQL.
        await db.query(`INSERT INTO ${table} SELECT r.* FROM unnest($1::text[]) data,
          LATERAL jsonb_populate_record(NULL::${table},jsonb_build_object('run_id',$2::uuid)||data::jsonb) r`,[data,archive.run.id]);
      }
    }
    const constraints=schema.tables.flatMap(table=>table.constraints);
    for(const constraint of constraints.filter(sql=>!sql.includes("FOREIGN KEY")))await db.exec(constraint);
    for(const table of schema.tables)for(const index of table.indexes)await db.exec(index);
    for(const constraint of constraints.filter(sql=>sql.includes("FOREIGN KEY")))await db.exec(constraint);
    for(const table of PAYLOAD_TABLES){
      const rows=(await db.query<{sha:string}>(`SELECT encode(sha256(convert_to((to_jsonb(x)-'run_id')::text,'UTF8')),'hex') sha FROM ${table} x`)).rows;
      if(rows.length!==archive.tables[table].length||hashesDigest(rows.map(r=>r.sha))!==hashesDigest(archive.tables[table].map(r=>r.sha)))throw Error("RETENTION_RESTORE_MISMATCH");
    }
  }finally{await db.close();}
}
