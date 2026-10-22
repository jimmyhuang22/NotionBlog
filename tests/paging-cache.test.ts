import test from "node:test";
import assert from "node:assert/strict";
import { canRestoreList, initialPageIdentity } from "../src/lib/paging-cache.ts";

test("platform navigation restores only a fresh identical first page and keeps cursor, totals and images in the identity", () => {
  const page = { items: [{ id: "one", cover: { src: "/media/fixture" } }], nextCursor: "context-one", hasMore: true, total: 25 };
  const address = "/works?platform=xiaohongshu", initialPage = initialPageIdentity(page), snapshot = { address, initialPage };
  assert.equal(canRestoreList(snapshot, address, null, initialPage, true), true);
  for (const changed of [ { ...page, total: 26 }, { ...page, nextCursor: "context-two" }, { ...page, hasMore: false },
    { ...page, items: [] }, { ...page, items: [{ id: "one", cover: { src: "/media/replacement" } }] } ])
    assert.equal(canRestoreList(snapshot, address, null, initialPageIdentity(changed), true), false);
  assert.equal(canRestoreList(snapshot, "/works", null, initialPage, true), false);
  assert.equal(canRestoreList(undefined, address, null, initialPage, true), false);
});

test("other lists preserve history-only restoration without enabling ordinary-link reuse", () => {
  const snapshot = { address: "/status", initialPage: "first" };
  assert.equal(canRestoreList(snapshot, "/status", null, "first", false), false);
  assert.equal(canRestoreList(snapshot, "/status", "/status", "new", false), true);
  assert.equal(canRestoreList(snapshot, "/status?year=2023", "/status", "first", false), false);
});
