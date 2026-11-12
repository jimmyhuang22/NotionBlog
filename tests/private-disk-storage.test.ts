import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, readFile, rm, symlink, link, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPrivateDiskStorage, privateDiskEnabled } from "../src/server/database/private-disk-storage.ts";
import { createSocialStorage } from "../src/server/social/media-storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
const bytes = Buffer.from("89504e470d0a1a0a", "hex"), sha256 = createHash("sha256").update(bytes).digest("hex");
const media = {assetId:mediaIdentity("owner", "test", sha256),ownerPageId:"owner",objectKey:"sha256/"+sha256,sha256,byteSize:bytes.length,mime:"image/png" as const,width:1,height:1};
test("private disk immutable writes, validated reads, reader isolation and cancellation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "disk-test-")));
  try {
    const writer = createPrivateDiskStorage(root,"writer"), reader = createPrivateDiskStorage(root,"reader");
    await writer.put(media,bytes); await writer.put(media,bytes);
    assert.deepEqual(await reader.read(media),bytes);
    await assert.rejects(reader.put(media,bytes));
    await assert.rejects(reader.read(media,AbortSignal.abort()));
    await assert.rejects(writer.put({...media,sha256:"0".repeat(64)},bytes));
    await writeFile(join(root,sha256),Buffer.alloc(bytes.length));
    await assert.rejects(reader.read(media)); await assert.rejects(writer.put(media,bytes));
    assert.deepEqual(await readFile(join(root,sha256)),Buffer.alloc(bytes.length));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test("private disk refuses symlinks, hardlinks, exposed permissions and missing objects", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "disk-test-")));
  try {
    const reader = createPrivateDiskStorage(root,"reader");
    await assert.rejects(reader.read(media));
    const source = join(root,"source"); await writeFile(source,bytes,{mode:0o600});
    await symlink(source,join(root,sha256)); await assert.rejects(reader.read(media));
    await rm(join(root,sha256)); await link(source,join(root,sha256)); await assert.rejects(reader.read(media));
    await rm(source); await chmod(join(root,sha256),0o644); await assert.rejects(reader.read(media));
    await chmod(join(root,sha256),0o600); await chmod(root,0o755); await assert.rejects(reader.read(media));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test("private disk is opt in and social has a separate private root", async () => {
  assert.equal(privateDiskEnabled({}),false);
  assert.throws(()=>privateDiskEnabled({STORAGE_PROVIDER:"private-disk"}));
  const root = await realpath(await mkdtemp(join(tmpdir(),"social-disk-")));
  const env = {STORAGE_PROVIDER:"private-disk",MEDIA_DELIVERY_MODE:"display-only",DATABASE_CONTENT_VERSION:"2",MEDIA_PROVIDER:"storage",PRIVATE_MEDIA_ROOT:root,
    SOCIAL_MEDIA_STORAGE_PROVIDER:"private-disk",SOCIAL_MEDIA_PRIVATE_MEDIA_ROOT:root};
  try {
    await createSocialStorage(env,"writer",()=>{throw Error("NETWORK_FORBIDDEN");}).put(media,bytes);
    assert.deepEqual(await createSocialStorage(env,"reader",()=>{throw Error("NETWORK_FORBIDDEN");}).read(media),bytes);
    assert.throws(()=>createSocialStorage({...env,MEDIA_DELIVERY_MODE:"legacy"},"reader"));
  } finally { await rm(root,{recursive:true,force:true}); }
});
