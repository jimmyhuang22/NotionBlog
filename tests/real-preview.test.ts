import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unusedLocalPort } from '../scripts/development/cloud-session.mjs';

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../scripts/dev-real.mjs", import.meta.url));
async function planFile(root: string) {
 const path=join(root,'plan.json');
 await writeFile(path,JSON.stringify({version:1,paths:['/'],destinations:[{host:'fixture.invalid',port:443}],maxRequests:1,maxConnections:2,maxReceivedBytes:4096}),{mode:0o600});
 return path;
}

test("real preview forwards media settings to its actual child while excluding writer credentials and indexing", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "real-preview-"));
  try {
    // Exercise the real launcher and environment parser; replace only the Next
    // binary with a local child that reports safe configuration facts.
    const bin = join(root, "node_modules/next/dist/bin"); await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "next"), `console.log(JSON.stringify({
      storageProvider:process.env.STORAGE_PROVIDER??null,
      thumbnailStorageProvider:process.env.THUMBNAIL_STORAGE_PROVIDER??null,
      cosReaderPresent:!!process.env.COS_SECRET_ID&&!!process.env.COS_SECRET_KEY,
      mediaProvider:process.env.MEDIA_PROVIDER??null,
      mediaThumbnails:process.env.MEDIA_THUMBNAILS??null,
      contentProvider:process.env.CONTENT_PROVIDER,
      readProjection:process.env.DATABASE_READ_PROJECTION??null,
      readerPresent:!!process.env.DATABASE_READER_URL,
      notionReaderPresent:!!process.env.NOTION_TOKEN,
      indexing:process.env.SITE_INDEXING_ENABLED,
      hostname:process.argv[process.argv.indexOf('--hostname')+1],
      writerKeys:['DATABASE_MIGRATION_URL','SYNC_DATABASE_URL','SYNC_MEDIA_PROVIDER','STORAGE_WRITE_TOKEN','COS_WRITER_SECRET_KEY'].filter(key=>Object.hasOwn(process.env,key))
    }));`);
    async function run(mediaProvider?: string, mediaThumbnails?: string, storage: Record<string, string> = {}) {
      const values = {
        CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_READER_URL: "postgresql://localhost/synthetic",
        NOTION_TOKEN: "synthetic-read-connection", SITE_INDEXING_ENABLED: "true",
        DATABASE_MIGRATION_URL: "synthetic-owner-credential", SYNC_DATABASE_URL: "synthetic-writer-credential",
        SYNC_MEDIA_PROVIDER: "notion", STORAGE_WRITE_TOKEN: "synthetic-storage-writer", COS_WRITER_SECRET_KEY: "synthetic-cos-writer",
        ...storage,
        ...(mediaProvider === undefined ? {} : { MEDIA_PROVIDER: mediaProvider }),
        ...(mediaThumbnails === undefined ? {} : { MEDIA_THUMBNAILS: mediaThumbnails }),
      };
      const envFile = join(root, "reader.env");
      await writeFile(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
      const result = await execute(process.execPath, [launcher, "--env", envFile, "--plan", await planFile(root), "--port", String(await unusedLocalPort()), "--allow-cloud", "yes", "--duration-seconds", "30"], { cwd: root });
      return JSON.parse(result.stdout.trim().split("\n").find(line=>line.startsWith('{'))!);
    }
    await t.test("hybrid media and enabled thumbnails reach the child with only reader inputs", async () => {
      assert.deepEqual(await run("notion", "enabled"), { storageProvider: null, thumbnailStorageProvider: null, cosReaderPresent: false, mediaProvider: "notion", mediaThumbnails: "enabled", contentProvider: "database", readProjection: null, readerPresent: true, notionReaderPresent: true, indexing: "false", hostname: "127.0.0.1", writerKeys: [] });
    });
    await t.test("Storage, disabled thumbnails and the unspecified defaults remain available", async () => {
      const storage = await run("storage", "disabled"), unspecified = await run();
      assert.equal(storage.mediaProvider, "storage");
      assert.equal(storage.mediaThumbnails, "disabled");
      assert.equal(unspecified.mediaProvider, null);
      assert.equal(unspecified.mediaThumbnails, null);
    });
    await t.test("separate COS reader settings reach the child without writer inputs", async () => {
      const result = await run("notion", "enabled", { STORAGE_PROVIDER: "supabase", THUMBNAIL_STORAGE_PROVIDER: "cos", COS_SECRET_ID: "synthetic-reader", COS_SECRET_KEY: "synthetic-read-key" });
      assert.equal(result.storageProvider, "supabase");
      assert.equal(result.thumbnailStorageProvider, "cos");
      assert.equal(result.cosReaderPresent, true);
      assert.deepEqual(result.writerKeys, []);
    });
    await t.test("unknown storage and COS with a local directory fail before spawning", async () => {
      const invalid: Record<string, string>[] = [{ THUMBNAIL_STORAGE_PROVIDER: "unsupported" }, { STORAGE_PROVIDER: "unsupported" }, { THUMBNAIL_STORAGE_PROVIDER: "cos", DATABASE_MEDIA_DIRECTORY: "/synthetic" }];
      for (const storage of invalid) {
        await assert.rejects(run("notion", "enabled", storage), error => error instanceof Error && "code" in error && error.code === 1);
      }
    });
    await t.test("an invalid media provider cannot launch a misleading preview", async () => {
      await assert.rejects(run("unsupported"), error => error instanceof Error && "code" in error && error.code === 1 && !error.message.includes("synthetic-owner-credential"));
    });
    await t.test("the scoped reader reaches the child and incompatible modes never spawn", async () => {
      assert.equal((await run("storage", "enabled", { DATABASE_READ_PROJECTION: "scoped" })).readProjection,"scoped");
      assert.equal((await run("storage", "enabled", { DATABASE_READ_PROJECTION: "legacy" })).readProjection,"legacy");
      const incompatible:Record<string,string>[]=[{ DATABASE_READ_PROJECTION:"unknown" },{ DATABASE_READ_PROJECTION:"scoped",DATABASE_CONTENT_VERSION:"1" },{ DATABASE_READ_PROJECTION:"scoped",CONTENT_PROVIDER:"notion" }];
      for(const config of incompatible)
        await assert.rejects(run("storage","enabled",config),error=>error instanceof Error && "code" in error && error.code===1);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real preview requires explicit cloud opt-in and a bounded duration before starting its child',async()=>{
 for(const args of [[],['--allow-cloud','yes'],['--allow-cloud','yes','--duration-seconds','901'],['--allow-cloud','no','--duration-seconds','60']])
  await assert.rejects(execute(process.execPath,[launcher,'--env','/nonexistent-private-file',...args]),e=>e instanceof Error&&'code'in e&&e.code===1&&!e.message.includes('password'));
});

test('real preview deadline actually stops the child and does not leave an unlimited development session',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'real-preview-deadline-'));
 try{
  const bin=join(root,'node_modules/next/dist/bin');await mkdir(bin,{recursive:true});
  await writeFile(join(bin,'next'),"console.log('started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
  const envFile=join(root,'reader.env');await writeFile(envFile,'CONTENT_PROVIDER=database\nDATABASE_READER_URL=postgresql://localhost/synthetic\n',{mode:0o600});
  const start=Date.now();await assert.rejects(execute(process.execPath,[launcher,'--env',envFile,'--plan',await planFile(root),'--port',String(await unusedLocalPort()),'--allow-cloud','yes','--duration-seconds','1'],{cwd:root,timeout:5000}),e=>e instanceof Error&&'stderr'in e&&String(e.stderr).includes('deadline reached'));
  assert.ok(Date.now()-start<5000);
 }finally{await rm(root,{recursive:true,force:true})}
});
