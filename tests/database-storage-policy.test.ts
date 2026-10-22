import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/** Executes the real policy SQL against a minimal Supabase auth/storage schema model. */
test("private bucket RLS grants scoped reads/inserts but no anonymous access or overwrites",async()=>{
  const db=await PGlite.create();
  try {
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA storage; CREATE SCHEMA auth;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id serial PRIMARY KEY,bucket_id text,name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      GRANT USAGE ON SCHEMA storage,auth TO anon,authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;
      GRANT USAGE ON SEQUENCE storage.objects_id_seq TO anon,authenticated;`);
    // Existing correctly configured private buckets are reused without overwriting settings.
    await db.exec("INSERT INTO storage.buckets VALUES('notionblog-media','notionblog-media',false,20971520,ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'])");
    await db.exec(await readFile(new URL("../database/storage-policies.sql",import.meta.url),"utf8"));
    const name=`sha256/${"1".repeat(64)}`;
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('notionblog-media',$1),('other-bucket',$1)",[name]);
    const asRole=<T>(role:string,claim:string|null,query:string,params:unknown[]=[])=>db.transaction(async tx=>{
      await tx.exec(`SET LOCAL ROLE ${role}`);
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claim?{app_metadata:{notionblog_storage_role:claim}}:{})]);
      return tx.query<T>(query,params);
    });
    for(const [role,claim] of [["anon","reader"],["authenticated",null],["authenticated","unknown"]]){
      assert.equal((await asRole(role!,claim,"SELECT * FROM storage.objects")).rows.length,0);
      await assert.rejects(asRole(role!,claim,"INSERT INTO storage.objects(bucket_id,name) VALUES('notionblog-media',$1)",[name]),/row-level security/);
    }
    assert.equal((await asRole("authenticated","reader","SELECT * FROM storage.objects")).rows.length,1);
    await assert.rejects(asRole("authenticated","reader","INSERT INTO storage.objects(bucket_id,name) VALUES('notionblog-media',$1)",[name]),/row-level security/);
    await asRole("authenticated","writer","INSERT INTO storage.objects(bucket_id,name) VALUES('notionblog-media',$1)",[`sha256/${"2".repeat(64)}`]);
    await assert.rejects(asRole("authenticated","writer","INSERT INTO storage.objects(bucket_id,name) VALUES('other-bucket',$1)",[name]),/row-level security/);
    await assert.rejects(asRole("authenticated","writer","INSERT INTO storage.objects(bucket_id,name) VALUES('notionblog-media','../private')"),/row-level security/);
    assert.equal((await asRole("authenticated","writer","UPDATE storage.objects SET name='overwritten' RETURNING id")).rows.length,0);
    assert.equal((await asRole("authenticated","writer","DELETE FROM storage.objects RETURNING id")).rows.length,0);
    assert.equal((await db.query<{public:boolean}>("SELECT public FROM storage.buckets")).rows[0].public,false);
  } finally {await db.close();}
});
