import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ContentRepository } from "../contracts/repository.ts";
import type { Page } from "../contracts/content.ts";
import type { SearchHit } from "../contracts/website.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { scopedReader } from "../src/server/database/scoped-reads.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { setupSearchProjection, status, body } from "./helpers/search-precomputed.ts";
import protocol from "../database/search-filtered-protocol.json" with { type: "json" };
import scopeProtocol from "../database/search-filtered-scope-protocol.json" with { type: "json" };

async function setup() {
  const f = await setupSearchProjection();
  for (const [version, extension] of [[4, protocol], [5, scopeProtocol]] as const) {
    const bytes = await readFile(new URL("../supabase/migrations/" + extension.migration.file, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), extension.migration.sha256);
    await f.db.exec(bytes.toString());
    await f.db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=$2", [extension.migration.sha256, version]);
  }
  await f.register();
  const readers = () => (["qualified", "published"] as const).flatMap(mode =>
    (["on-demand", "filtered", "precomputed", "filtered-scope"] as const).map(projection => ({
      label: `${mode}/${projection}`,
      repo: projection === "filtered" || projection === "filtered-scope"
        ? createWebsiteDatabaseRepository(scopedReader(f.reader, mode, projection), { scoped: true, filteredSearch: projection === "filtered", filteredScopeSearch: projection === "filtered-scope" })
        : f.repo(mode, projection === "precomputed"),
    })));
  return { ...f, readers };
}

async function walk(repo: ContentRepository, limit: number): Promise<SearchHit[]> {
  const items: SearchHit[] = [];
  let cursor: string | undefined;
  do {
    assert(items.length <= 50, "Pagination must terminate within the fixture");
    const page = await repo.search!({ q: "Java", limit, ...(cursor ? { cursor } : {}) });
    items.push(...page.items); cursor = page.nextCursor ?? undefined;
    if (!cursor) assert.equal(items.length, page.total);
  } while (cursor);
  assert.equal(new Set(items.map(item => item.id)).size, items.length, "No duplicate hits across pages");
  return items;
}

for (const retainsBodyMatch of [false, true]) {
  test(`media withdrawal invalidates old search cursors when ${retainsBodyMatch ? "only excerpts change" : "a preceding hit disappears"}`, async t => {
    const f = await setup();
    try {
      const first = status(0), sha = createHash("sha256").update("fictional-caption").digest("hex");
      const assetId = mediaIdentity(first.detail.item.id, "image", sha);
      first.detail.document = { toc: [], completeness: "complete", blocks: [
        ...(retainsBodyMatch ? body("Java persistent").blocks : []),
        { id: "image", type: "image", image: { id: assetId, src: `/media/v2/${assetId}`, alt: "", width: 1, height: 1 }, caption: [{ text: "JavaWithdrawnCaption" }] },
      ] };
      const records = [first, status(1, body("Java")), status(2, body("Java"))];
      const lease = await f.publish(records, [{ assetId, ownerPageId: first.detail.item.id, objectKey: `sha256/${sha}`,
        sha256: sha, byteSize: 1, mime: "image/png", width: 1, height: 1 }]);
      await f.fill(lease.runId);
      const readers = f.readers(), initial: Page<SearchHit>[] = [];
      for (const { repo } of readers) {
        const page = await repo.search!({ q: "Java", limit: 1 });
        assert.equal(page.total, 3); assert.equal(page.items[0].id, first.detail.item.id); assert.ok(page.nextCursor);
        initial.push(page);
      }
      const revision = (await f.pin(lease.runId)).revision;
      await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [assetId]);
      assert.equal((await f.pin(lease.runId)).revision, revision, "The live projection changes without a content revision");
      let expected: SearchHit[] | undefined;
      for (const [index, { label, repo }] of readers.entries()) await t.test(label, async () => {
        await assert.rejects(repo.search!({ q: "Java", limit: 1, cursor: initial[index].nextCursor! }), { code: "INVALID_QUERY" });
        const fresh = await walk(repo, 1);
        assert.equal(fresh.length, retainsBodyMatch ? 3 : 2);
        assert(fresh.every(hit => !hit.excerpt?.includes("JavaWithdrawnCaption")));
        if (!retainsBodyMatch) assert(fresh.every(hit => hit.id !== first.detail.item.id));
        expected ??= fresh; assert.deepEqual(fresh, expected, "All search projections must restart at the same visible results");
      });
    } finally { await f.db.close(); }
  });
}

test("unchanged searches keep identical, complete pagination across every projection and page size", async () => {
  const f = await setup();
  try {
    const records = Array.from({ length: 37 }, (_, index) => {
      const record = status(index, body(`Java fictional ${index}`));
      record.detail.item.title = "Java tie"; return record;
    });
    const lease = await f.publish(records); await f.fill(lease.runId);
    let expected: SearchHit[] | undefined;
    for (const limit of [1, 12, 50]) for (const { repo } of f.readers()) {
      const actual = await walk(repo, limit); assert.equal(actual.length, 37);
      expected ??= actual; assert.deepEqual(actual, expected);
    }
    const [old, filtered, precomputed, scope] = f.readers();
    const first = await old.repo.search!({ q: "Java", limit: 12 }); assert.ok(first.nextCursor);
    const query = { q: "Java", limit: 12, cursor: first.nextCursor! };
    assert.deepEqual(await filtered.repo.search!(query), await old.repo.search!(query));
    assert.deepEqual(await precomputed.repo.search!(query), await old.repo.search!(query));
    assert.deepEqual(await scope.repo.search!(query), await old.repo.search!(query));
  } finally { await f.db.close(); }
});
