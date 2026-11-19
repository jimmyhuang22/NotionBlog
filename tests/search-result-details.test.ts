import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { Game } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { searchExcerpt, searchHitDetails, searchKey } from "../src/lib/content/search-result.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { body, setupSearchProjection, status } from "./helpers/search-precomputed.ts";

test("body excerpts retain the original Unicode match, up to 16 preceding characters, and both cut markers", () => {
  const source = "游玩内容目标： " + "ﬃ".repeat(32) + " 感受 " + "前".repeat(28) + " ＡＢＣ " + "🐈".repeat(190);
  const excerpt = searchExcerpt(source, searchKey("abc"), false);
  assert.ok(excerpt.startsWith("…" + "前".repeat(15) + " ＡＢＣ "));
  assert.ok(excerpt.endsWith("🐈…"));
  assert.equal([...excerpt].length, 182);
  assert.equal(searchExcerpt("多刷记录 感想：", searchKey("感想"), false), "");
  assert.equal(searchExcerpt("未截断的命中正文", searchKey("命中"), false), "未截断的命中正文");
  assert.equal(searchExcerpt(source, searchKey("abc"), true), "");
});

test("typed display facts preserve unknowns and omit external or unrelated cover images", () => {
  const album = { ...fixtureItems.album[0], date: null, photoCount: null, cover: null };
  assert.deepEqual(searchHitDetails(album), { cover: null, details: { kind: "album", date: null, photoCount: null } });
  const book = { ...fixtureItems.book[0], authors: ["Example Author"], status: "reading" as const, cover: null };
  assert.deepEqual(searchHitDetails(book), { cover: null, details: { kind: "book", authors: ["Example Author"], status: "reading" } });
  const movie = { ...fixtureItems.movie[0], mediaType: null, status: "unknown" as const,
    cover: { id: "a1." + "a".repeat(64), src: "https://example.test/cover", alt: "", width: null, height: null } };
  assert.deepEqual(searchHitDetails(movie), { cover: null, details: { kind: "movie", mediaType: null, status: "unknown" } });
  assert.deepEqual(searchHitDetails(fixtureItems["study-note"][0]), {});
});

test("scoped details use one pinned metadata batch for just the page, and counts use all currently eligible hits", async () => {
  const f = await setupSearchProjection(false);
  try {
    const id = "search-details-game";
    const sha = createHash("sha256").update("synthetic search cover").digest("hex"), asset = mediaIdentity(id, "cover", sha);
    const cover = { id: asset, src: `/media/v2/${asset}`, alt: "Fixture cover", width: 400, height: 225 };
    const game: Game = { ...structuredClone(fixtureItems.game[0]), id, slug: id, href: `/library/games/${id}`, title: "Needle Game", cover,
      status: "playing", platforms: ["Example Platform"], playedTime: { value: 0, unit: "hour" }, rating: null };
    const records: WebsiteRecord[] = [status(1, body("body needle")), status(2, body("another needle")), {
      detail: { item: game, document: body("before needle after") },
      evidence: { sourceKey: "games", dataSourceId: "source-games", databaseParentId: null, courseId: null, parentId: null, ordinal: 3 },
    }];
    const sources = [
      { key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null },
      { key: "games", kind: "game", mode: "allowlist", dataSourceId: "source-games", databaseParentId: null, pageId: null },
    ];
    const permits = [{ id, kind: "game", sourceKey: "games", courseId: null, parentId: null }];
    const digest = configDigest([sources, permits]);
    await f.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    const lease = await f.writer.begin(randomUUID(), digest);
    await f.writer.stage(lease, records);
    await f.writer.stage(lease, [], [{ assetId: asset, ownerPageId: id, objectKey: `sha256/${sha}`, sha256: sha,
      byteSize: 1, mime: "image/png", width: 400, height: 225 }]);
    await f.writer.promote(lease, { records: records.length, media: 1, complete: true });
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);

    const batches: unknown[][] = [];
    let calls = 0;
    const observed: SqlExecutor = { query<T>(sql: string, values?: unknown[]) {
      calls++;
      if (sql.includes("WITH ORDINALITY AS hit")) batches.push(values ?? []);
      return f.reader.query<T>(sql, values);
    } };
    const repo = f.repo("published", false, observed);
    const first = await repo.search!({ q: "needle", limit: 1 });
    assert.equal(calls, 3, "cold search keeps capability, matching and one final qualified batch");
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].slice(0, 2), [["game"], [id]]);
    assert.equal(first.total, 3);
    assert.deepEqual(first.kindCounts, { game: 1, status: 2 });
    assert.equal(first.items[0].excerpt, "");
    assert.deepEqual(first.items[0].cover, cover);
    assert.deepEqual(first.items[0].details, { kind: "game", status: "playing", platforms: ["Example Platform"],
      playedTime: { value: 0, unit: "hour" }, rating: null });
    assert.ok(first.nextCursor);
    const second = await repo.search!({ q: "needle", limit: 1, cursor: first.nextCursor });
    assert.deepEqual(batches[1].slice(0, 2), [["status"], ["projection-status-0001"]]);
    assert.equal(second.kindCounts, undefined);
    const filtered = await repo.search!({ q: "needle", kinds: ["status"] });
    assert.deepEqual(filtered.kindCounts, { status: 2 });
    assert.equal(filtered.total, 2);
    assert.deepEqual((await repo.search!({ q: "unmatched" })).kindCounts, {});

    await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [asset]);
    assert.equal((await repo.search!({ q: "needle", limit: 1 })).items[0].cover, null);
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [id]);
    assert.deepEqual((await repo.search!({ q: "needle", limit: 1 })).kindCounts, { status: 2 });
  } finally { await f.db.close(); }
});
