import test from "node:test";
import assert from "node:assert/strict";
import type { ContentRepository } from "../contracts/repository.ts";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import { pageOf, searchRepository, validateSearchQuery } from "../src/lib/content/website.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { scopedReader } from "../src/server/database/scoped-reads.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const fingerprint = "A".repeat(43);
const malformed = [
  "malformed", `w0.${fingerprint}.1`, `w1.${"A".repeat(42)}.1`, `w1.${"+".repeat(43)}.1`,
  `w1.${fingerprint}.-1`, `w1.${fingerprint}.01`, `w1.${fingerprint}.1.5`, `w1.${fingerprint}.1e3`,
  `w1.${fingerprint}.9007199254740992`, `w1.${fingerprint}.${"9".repeat(400)}`, `w1.${fingerprint}.1.extra`,
];

test("malformed search cursors are rejected before legacy and scoped SQL or capability reads", async () => {
  let calls = 0;
  const never: SqlExecutor = { async query() { calls++; throw Error("Unexpected SQL read"); } };
  const readers = [createWebsiteDatabaseRepository(never),
    ...(["qualified", "published"] as const).flatMap(mode =>
      (["on-demand", "filtered", "precomputed", "filtered-scope"] as const).map(projection =>
        createWebsiteDatabaseRepository(scopedReader(never, mode, projection), { scoped: true, filteredSearch: projection === "filtered", filteredScopeSearch: projection === "filtered-scope" }))),
  ];
  for (const reader of readers) for (const cursor of malformed)
    await assert.rejects(reader.search!({ q: "Java", cursor }), { code: "INVALID_QUERY" });
  assert.equal(calls, 0);
});

test("fallback search rejects malformed cursors before asking an adapter for a snapshot", async () => {
  let reads = 0;
  const repository = { async readSnapshot() { reads++; throw Error("Unexpected snapshot read"); } } as unknown as ContentRepository;
  const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, kind === "status"])) as ContentFeatures;
  for (const cursor of malformed)
    await assert.rejects(searchRepository(repository, features, { q: "Java", cursor }), { code: "INVALID_QUERY" });
  assert.equal(reads, 0);
  await assert.rejects(searchRepository(repository, features, { q: "Java" }), /Unexpected snapshot read/);
  assert.equal(reads, 1, "A valid first page still reaches its provider");
});

test("early cursor validation retains generated cursors and leaves data-dependent checks in pagination", () => {
  const first = pageOf(["first", "second"], { limit: 1 }, ["fictional"]);
  assert.ok(first.nextCursor);
  validateSearchQuery({ q: "Java", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(pageOf(["first", "second"], { limit: 1, cursor: first.nextCursor }, ["fictional"]).items, ["second"]);
  for (const offset of [0, 1, Number.MAX_SAFE_INTEGER]) validateSearchQuery({ q: "Java", cursor: `w1.${fingerprint}.${offset}` });
  assert.throws(() => pageOf(["first", "second"], { limit: 1, cursor: first.nextCursor! }, ["changed"]), { code: "INVALID_QUERY" });
  const oversized = first.nextCursor.replace(/\.1$/, ".3");
  assert.throws(() => pageOf(["first", "second"], { limit: 1, cursor: oversized }, ["fictional"]), { code: "INVALID_QUERY" });
});

test("a well-formed cursor still requires the current database projection and preserves provider failures", async () => {
  let calls = 0;
  const unavailable: SqlExecutor = { async query() { calls++; throw Error("Database fixture unavailable"); } };
  const reader = createWebsiteDatabaseRepository(unavailable, { scoped: true, filteredSearch: false });
  await assert.rejects(reader.search!({ q: "Java", cursor: `w1.${fingerprint}.0` }), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(calls, 1);
});
