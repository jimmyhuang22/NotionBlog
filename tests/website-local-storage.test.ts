import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,symlink,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createLocalMediaStorage} from "../src/server/database/local-storage.ts";
import {mediaIdentity} from "../src/server/database/validation.ts";
import {renderEquation} from "../src/lib/render/equation.ts";
test("local preview media is immutable, owner-only and unavailable to a cloud or writer-less reader",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"notionblog-local-media-"));
 const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=","base64"),sha256=createHash("sha256").update(bytes).digest("hex"),media={assetId:mediaIdentity("owner","image",sha256),ownerPageId:"owner",sha256,objectKey:`sha256/${sha256}`,byteSize:bytes.length,mime:"image/png" as const,width:null,height:null};
 try {
  assert.throws(()=>createLocalMediaStorage(dir,"postgres://reader:pass@db.example.test/db","reader"));
  const reader=createLocalMediaStorage(dir,"postgres://reader:pass@127.0.0.1/db","reader"),writer=createLocalMediaStorage(dir,"postgres://writer:pass@127.0.0.1/db","writer");
  await assert.rejects(reader.put(media,bytes));await writer.put(media,bytes);await writer.put(media,bytes);assert.deepEqual(Buffer.from(await reader.read(media)),bytes);
  await chmod(join(dir,"sha256",sha256),0o644);await assert.rejects(reader.read(media));await rm(join(dir,"sha256",sha256));await symlink(join(dir,"missing"),join(dir,"sha256",sha256));await assert.rejects(reader.read(media));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("inline equations preserve inline layout and retain unsafe-input fallback",()=>{
 const inline=renderEquation("x^2",false);assert.ok(inline?.includes("katex"));assert.ok(!inline?.includes("katex-display"));assert.ok(renderEquation("x^2")?.includes("katex-display"));assert.equal(renderEquation("\\frac{",false),null);
});
