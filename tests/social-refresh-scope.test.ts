import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { hash, SocialSyncError } from "../scripts/social-sync/model.ts";
import { collectionMemberShas, refreshConfig } from "../scripts/social-sync/refresh.ts";
import { readRefreshScope } from "../scripts/social-sync/refresh-scope.ts";
import { inspectRefresh } from "../scripts/social-sync/refresh-state.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-follow-scope-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = exampleCollectionSnapshot("2026-01-02T00:00:00.000Z"), target = snapshot.target;
  const raw = { version: 1, reviewedAt: snapshot.observedAt, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 }, stateDirectories: { publications: root, collections: root },
    publications: [], collections: [{ target, memberShas: collectionMemberShas(snapshot) }, { target: { ...target, collectionId: "201" }, memberShas: collectionMemberShas(snapshot) }] };
  await writeFile(join(root, "refresh-config.json"), JSON.stringify(raw), { mode: 0o600 });
  const scope = refreshConfig(raw), policy = { version: 1, baseScopeDigest: hash(JSON.stringify(scope)), collectionKeys: [collectionKey(target)] };
  const save = (value: unknown) => writeFile(join(root, "bilibili-follow.json"), JSON.stringify(value), { mode: 0o600 });
  return { root, raw, scope, policy, save, snapshot };
}

test("Bilibili follow overlay changes only selected collections and leaves the shared file and Xiaohongshu scope unchanged", async t => {
  const f = await fixture(t), before = await readFile(join(f.root, "refresh-config.json"));
  assert.deepEqual(await readRefreshScope(f.root, "bilibili"), f.scope);
  await f.save(f.policy);
  const b = await readRefreshScope(f.root, "bilibili");
  assert.equal(b.collections[0]!.membershipMode, "follow-public"); assert(!Object.hasOwn(b.collections[1]!, "membershipMode"));
  assert.deepEqual(await readRefreshScope(f.root, "xiaohongshu"), f.scope);
  assert.deepEqual(await readFile(join(f.root, "refresh-config.json")), before);
  assert.notEqual(hash(JSON.stringify(b)), f.policy.baseScopeDigest);
});

test("unknown/duplicate follows, invalid policy fields and changes to the base scope fail closed only for Bilibili", async t => {
  const f = await fixture(t);
  for (const value of [{ ...f.policy, collectionKeys: ["0".repeat(64)] }, { ...f.policy, collectionKeys: [...f.policy.collectionKeys, ...f.policy.collectionKeys] },
    { ...f.policy, collectionKeys: [] }, { ...f.policy, directory: "/private/example" }, { ...f.policy, baseScopeDigest: "0".repeat(64) }]) {
    await f.save(value); await assert.rejects(readRefreshScope(f.root, "bilibili"), SocialSyncError);
    assert.deepEqual(await readRefreshScope(f.root, "xiaohongshu"), f.scope);
  }
  await f.save(f.policy); f.raw.collections[0]!.memberShas = ["1".repeat(64)];
  await writeFile(join(f.root, "refresh-config.json"), JSON.stringify(f.raw), { mode: 0o600 });
  await assert.rejects(readRefreshScope(f.root, "bilibili"), (e: unknown) => e instanceof SocialSyncError && e.code === "REFRESH_SCOPE_CHANGED");
});

test("actual read-only cycle inspection releases an old membership hold under the Bilibili-only overlay", async t => {
  const f = await fixture(t); f.raw.collections.pop(); await writeFile(join(f.root, "refresh-config.json"), JSON.stringify(f.raw), { mode: 0o600 });
  f.policy.baseScopeDigest = hash(JSON.stringify(refreshConfig(f.raw)));
  const store = await openCollectionStore(f.root); assert(store); store.ingest(f.snapshot); store.acknowledge(store.pendingFor(f.snapshot.target)!); store.close();
  const changed = structuredClone(f.snapshot); changed.observedAt = "2026-01-03T00:00:00.000Z";
  changed.members.push({ id: "BV0000000003", publishedAt: null, parts: ["1003"], partsComplete: true });
  const key = collectionKey(changed.target);
  await writeFile(join(f.root, `review-collection-${key}.json`), JSON.stringify({ version: 1, candidate: { type: "collection", key, value: changed } }), { mode: 0o600 });
  assert.equal((await inspectRefresh(f.root, "bilibili")).reviewRequired, 1);
  await f.save(f.policy);
  const inspect = await inspectRefresh(f.root, "bilibili"); assert.equal(inspect.reviewRequired, 0); assert.deepEqual(inspect.keys, [key]);
});
