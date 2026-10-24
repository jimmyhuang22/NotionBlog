import test from "node:test";
import assert from "node:assert/strict";
import { captureXhsDirectory } from "../scripts/social-sync/browser/xiaohongshu-directory.js";

const accountId = "1".repeat(24), id = (n: number) => n.toString(16).padStart(24, "0");
const cards = (ids: string[]) => ids.map(publicationId => ({ publicationId, url: `https://www.xiaohongshu.com/user/profile/${accountId}/${publicationId}?xsec_token=example_locator` }));
const known = Array.from({ length: 30 }, (_, n) => id(n + 1));
function fixture(read: (poll: number) => { cards: ReturnType<typeof cards>; observedAt: string } | { error: string }, ready = true, expiresMs = 120000) {
  let time = 0, polls = 0, scrolls = 0, closed = 0;
  const owned: (string | null)[] = [];
  const api = {
    tabs: { create: async () => ({ id: 7 }), get: async () => ({ status: ready ? "complete" : "loading", url: `https://www.xiaohongshu.com/user/profile/${accountId}` }), remove: async () => { closed++; } },
    scripting: { executeScript: async ({ func }: { func: { name: string } }) => {
      if (func.name === "scrollXhsDirectory") { scrolls++; return [{ frameId: 0, result: { scrolled: true } }]; }
      return [{ frameId: 0, result: read(++polls) }];
    } },
  };
  const job = { id: "00000000-0000-0000-0000-000000000001", accountId, knownIds: known, expiresAt: new Date(expiresMs).toISOString() };
  return {
    job, api, run: () => captureXhsDirectory(api, job, { now: () => time, sleep: async ms => { time += ms; }, owned: async (_tab, account) => { owned.push(account); } }),
    observed: () => ({ time, polls, scrolls, closed, owned }),
  };
}
const page = (ids: string[]) => ({ cards: cards(ids), observedAt: new Date(0).toISOString() });

test("fewer than thirty stable cards produce a directory-stalled reason and bounded owned scrolling", async () => {
  const f = fixture(() => page(known.slice(0, 12)));
  await assert.rejects(f.run(), /XHS_DIRECTORY_STALLED/);
  const result = f.observed();
  assert.equal(result.time, 10000); assert.equal(result.scrolls, 4); assert.equal(result.closed, 1); assert.deepEqual(result.owned, [accountId, null]);
});
test("a fully rendered tail containing a new card never becomes a false successful boundary", async () => {
  const f = fixture(() => page([...known.slice(0, 29), id(99)]));
  await assert.rejects(f.run(), /XHS_DIRECTORY_STALLED/);
  assert.equal(f.observed().time, 10000); assert.equal(f.observed().closed, 1);
});
test("delayed lazy loading can progress after a repeated scroll and use the existing known-tail success rule", async () => {
  const f = fixture(poll => poll < 6 ? page([...known.slice(0, 20), id(99)]) : page([id(99), ...known]));
  const result = await f.run();
  assert.equal(result.version, 1); assert.equal(result.boundaryFound, true); assert.equal(result.cards.length, 31);
  assert.equal(f.observed().scrolls, 2); assert.equal(f.observed().closed, 1);
});
test("same-length rendered lists with different identities count as progress instead of a stalled count", async () => {
  const f = fixture(poll => page(poll < 17 ? [...known.slice(0, 29), id(100 + Math.floor(poll / 6))] : [id(99), ...known.slice(0, 29)]));
  const result = await f.run();
  assert.equal(result.boundaryFound, true); assert.ok(result.cards.some(c => c.publicationId === id(99)));
  assert.ok(f.observed().time > 10000); assert.ok(f.observed().scrolls <= 10);
});
test("continuous changes cannot exceed the original scroll-attempt or unique-card capacity", async () => {
  const f = fixture(poll => page([id(100 + poll)]));
  await assert.rejects(f.run(), /XHS_DIRECTORY_GAP/); assert.equal(f.observed().scrolls, 10); assert.equal(f.observed().closed, 1);
  const overflow = fixture(() => page(Array.from({ length: 301 }, (_, n) => id(500 + n))));
  await assert.rejects(overflow.run(), /XHS_DIRECTORY_GAP/); assert.equal(overflow.observed().scrolls, 0); assert.equal(overflow.observed().closed, 1);
});
test("unready browser/page and shorter existing lease retain timeout semantics without artificial directory success", async () => {
  const loading = fixture(() => page(known), false);
  await assert.rejects(loading.run(), /BROWSER_TIMEOUT/); assert.equal(loading.observed().time, 90000); assert.equal(loading.observed().polls, 0);
  const unready = fixture(() => ({ error: "DIRECTORY_NOT_READY" }));
  await assert.rejects(unready.run(), /BROWSER_TIMEOUT/); assert.equal(unready.observed().time, 90000);
  const expiring = fixture(() => page(known.slice(0, 4)), true, 5000);
  await assert.rejects(expiring.run(), /BROWSER_TIMEOUT/); assert.equal(expiring.observed().time, 5000); assert.ok(expiring.observed().scrolls <= 2);
});
test("invalid lease timestamps reject before opening any tab", async () => {
  const f = fixture(() => page(known)); f.job.expiresAt = "invalid";
  await assert.rejects(f.run(), /XHS_DIRECTORY_INVALID/); assert.deepEqual(f.observed().owned, []);
});
test("missing observations do not count toward a continuous stalled rendered list", async () => {
  const f = fixture(poll => poll >= 2 && poll <= 13 ? { error: "DIRECTORY_NOT_READY" } : page(known.slice(0, 12)));
  await assert.rejects(f.run(), /XHS_DIRECTORY_STALLED/);
  assert.equal(f.observed().time, 23000); assert.equal(f.observed().closed, 1);
});
