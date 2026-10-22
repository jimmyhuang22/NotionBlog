import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHeicConverter } from "../scripts/notion-sync/heic.ts";
const code = (expected: string) => (e: unknown) => e instanceof Error && "code" in e && e.code === expected;
async function fixture(script: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-heic-test-")));
  const state = join(root, "state"), executable = join(root, "decoder");
  await mkdir(state, { mode: 0o700 });
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, state, executable, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("local image converter returns bounded bytes and removes all private working files", async () => {
  const f = await fixture('#!/bin/sh\numask 077\nprintf "\\377\\330\\377\\000" > "$2"\n');
  try {
    const convert = createHeicConverter({ executable: f.executable, temporaryRoot: f.state });
    const result = await convert(new Uint8Array([1,2,3]), new AbortController().signal);
    assert.deepEqual(Buffer.from(result), Buffer.from([255,216,255,0]));
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});
test("untrusted writable or symlink converter executables cannot run", async () => {
  const f = await fixture('#!/bin/sh\nexit 0\n');
  try {
    await chmod(f.executable, 0o722);
    await assert.rejects(createHeicConverter({ executable: f.executable, temporaryRoot: f.state })(new Uint8Array([1]),new AbortController().signal),code("IMAGE_REJECTED"));
    await chmod(f.executable, 0o700);
    const link=join(f.root,"decoder-link");await symlink(f.executable,link);
    await assert.rejects(createHeicConverter({ executable: link, temporaryRoot: f.state })(new Uint8Array([1]),new AbortController().signal),code("IMAGE_REJECTED"));
    assert.deepEqual(await readdir(f.state), []);
  } finally { await f.cleanup(); }
});
test("cancellation kills the decoder and removes temporary source images", async () => {
  const f=await fixture('#!/bin/sh\nexec /bin/sleep 5\n');
  try {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100);
    try { await assert.rejects(createHeicConverter({executable:f.executable,temporaryRoot:f.state})(new Uint8Array([1]),controller.signal),code("CANCELLED")); }
    finally {clearTimeout(timer);}
    assert.deepEqual(await readdir(f.state),[]);
  } finally {await f.cleanup();}
});
