import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { StoredMedia } from "../contracts/sync.ts";
import { createThumbnailOriginalMirror } from "../scripts/media-thumbnails/original-mirror.ts";

const controlled = (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE" &&
  !error.message.includes("nb-original-mirror-");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-original-mirror-")));
  await chmod(root, 0o700);
  const bytes = await sharp({create:{width:12,height:8,channels:3,background:"#123456"}}).png().toBuffer();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media: StoredMedia = {assetId:`a1.${"a".repeat(64)}`,ownerPageId:"00000000000000000000000000000010",
    objectKey:`sha256/${sha256}`,sha256,byteSize:bytes.length,mime:"image/png",width:12,height:8};
  const path = join(root, sha256);
  await writeFile(path, bytes, {mode:0o600});
  return {root,path,bytes,media,clean:()=>rm(root,{recursive:true,force:true})};
}

test("original mirror verifies pinned SHA, MIME and length and accepts cooperative cancellation", async () => {
  const f = await fixture();
  try {
    const read = await createThumbnailOriginalMirror(f.root);
    assert.deepEqual(await read(f.media), f.bytes);
    await assert.rejects(read({...f.media,mime:"image/jpeg"}), controlled);
    await assert.rejects(read({...f.media,byteSize:f.bytes.length+1}), controlled);
    await assert.rejects(read(f.media,AbortSignal.abort()), controlled);
  } finally {await f.clean();}
});

test("original mirror fails closed on missing, changed, linked or exposed files", async t => {
  for (const mode of ["missing","bytes","symlink","hardlink","permissions","directory-permissions","directory-replaced"] as const) {
    await t.test(mode,async()=>{
      const f=await fixture();
      const moved=f.root+"-moved";
      try {
        const read=await createThumbnailOriginalMirror(f.root);
        if(mode==="missing")await rm(f.path);
        if(mode==="bytes"){const bytes=Buffer.from(f.bytes);bytes[bytes.length-1]^=1;await writeFile(f.path,bytes);}
        if(mode==="symlink"){const other=join(f.root,"other");await rename(f.path,other);await symlink(other,f.path);}
        if(mode==="hardlink")await link(f.path,join(f.root,"other"));
        if(mode==="permissions")await chmod(f.path,0o644);
        if(mode==="directory-permissions")await chmod(f.root,0o755);
        if(mode==="directory-replaced"){await rename(f.root,moved);await symlink(moved,f.root,"dir");}
        await assert.rejects(read(f.media),controlled);
      } finally {await f.clean();await rm(moved,{recursive:true,force:true});}
    });
  }
});

test("original mirror rejects relative and symlink directory inputs without creating anything", async()=>{
  const f=await fixture();
  const alias=f.root+"-alias";
  try {
    await symlink(f.root,alias,"dir");
    for(const path of ["relative",alias,f.root+"/.",f.root+"-missing"]) {
      await assert.rejects(createThumbnailOriginalMirror(path),controlled);
    }
  } finally {await rm(alias,{force:true});await f.clean();}
});
