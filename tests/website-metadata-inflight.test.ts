import assert from "node:assert/strict";
import test from "node:test";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { budgetedContentSql, withContentReadBudget } from "../src/server/content-read-budget.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function projection(index: number, kind: "movie" | "book" = "movie") {
  const date = { start: `${2020 + index}-01-02`, end: null, precision: "date" as const };
  const item = kind === "movie"
    ? { ...structuredClone(fixtureItems.movie[0]), title: `Snapshot ${index}`, watchedDate: date }
    : { ...structuredClone(fixtureItems.book[0]), title: `Snapshot ${index}`, readingDate: date };
  return { runId: "00000000-0000-4000-8000-000000000001", revision: String(index),
    schemaDigest: WEBSITE_SCHEMA_DIGEST, records: [{ item, document: null }], links: [item.href], mediaIds: [], hasMore: false };
}
function executor(read: (values: unknown[]) => Promise<unknown>): SqlExecutor {
  return { async query<T>(_sql: string, values: unknown[] = []) {
    return { rows: [{ result: await read(values) }] as unknown as T[] };
  } };
}
const unavailable = (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE";
const scoped = <T>(work: () => Promise<T>) => withContentReadBudget(new AbortController().signal, work);

test("interleaved request scopes retain their own overlapping list and year read", async () => {
  const finish = gate(), bStarted = gate(); let calls = 0;
  const repo = createWebsiteDatabaseRepository(executor(async () => {
    const result = projection(++calls); await finish.promise; return result;
  }));
  const a = scoped(async () => {
    const list = repo.list("movie", { limit: 1 });
    await bStarted.promise;
    const years = repo.getLibraryYears!("movie");
    finish.release();
    return Promise.all([list, years]);
  });
  const b = scoped(async () => {
    const list = repo.list("movie", { limit: 1 }); bStarted.release(); return list;
  });
  const [[listA, yearsA], listB] = await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.equal(listA.items[0].title, "Snapshot 1");
  assert.deepEqual(yearsA.years, [{ year: 2021, count: 1 }]);
  assert.equal(listB.items[0].title, "Snapshot 2");
});

test("overlapping kinds remain separate and shared metadata produces independent DTOs", async () => {
  const finish = gate(); let calls = 0;
  const repo = createWebsiteDatabaseRepository(executor(async values => {
    const result = projection(++calls, values[0] === "book" ? "book" : "movie"); await finish.promise; return result;
  }));
  await scoped(async () => {
    const a = repo.list("movie"), b = repo.list("book"), c = repo.list("movie");
    finish.release();
    const [first, book, second] = await Promise.all([a, b, c]);
    assert.equal(calls, 2);
    assert.equal(book.items[0].kind, "book");
    assert.deepEqual(first, second);
    first.items[0].title = "Caller change";
    first.items[0].tags.push("caller-only");
    assert.equal(second.items[0].title, "Snapshot 1");
    assert.ok(!second.items[0].tags.includes("caller-only"));
  });
});

test("settled metadata is read fresh even within the same request scope", async () => {
  let calls = 0;
  const repo = createWebsiteDatabaseRepository(executor(async () => projection(++calls)));
  await scoped(async () => {
    const first = await repo.list("movie");
    const years = await repo.getLibraryYears!("movie");
    assert.equal(first.items[0].title, "Snapshot 1");
    assert.deepEqual(years.years, [{ year: 2022, count: 1 }]);
    assert.equal(calls, 2);
  });
});

test("a rejected shared read clears before a fresh retry", async () => {
  const finish = gate(); let calls = 0;
  const repo = createWebsiteDatabaseRepository(executor(async () => {
    const index = ++calls;
    if (index === 1) { await finish.promise; throw new Error("Synthetic reader failure"); }
    return projection(index);
  }));
  await scoped(async () => {
    const a = repo.list("movie"), b = repo.getLibraryYears!("movie");
    finish.release();
    const results = await Promise.allSettled([a, b]);
    assert.ok(results.every(result => result.status === "rejected" && unavailable(result.reason)));
    assert.equal(calls, 1);
    assert.equal((await repo.list("movie")).items[0].title, "Snapshot 2");
    assert.equal(calls, 2);
  });
});

test("cancelling one request cannot cancel or supply another scope's metadata", async () => {
  const finish = gate(), cancelled = new AbortController(); let calls = 0;
  const repo = createWebsiteDatabaseRepository(budgetedContentSql(executor(async () => {
    const result = projection(++calls); await finish.promise; return result;
  })));
  const a = withContentReadBudget(cancelled.signal, () => repo.list("movie"));
  const b = scoped(() => repo.list("movie"));
  cancelled.abort(); finish.release();
  const [first, second] = await Promise.allSettled([a, b]);
  assert.ok(first.status === "rejected" && unavailable(first.reason));
  assert.equal(second.status, "fulfilled");
  if (second.status === "fulfilled") assert.equal(second.value.items[0].title, "Snapshot 2");
  assert.equal(calls, 2);
  assert.equal((await scoped(() => repo.list("movie"))).items[0].title, "Snapshot 3");
});

test("callers without a request budget never share an in-flight read", async () => {
  const finish = gate(); let calls = 0;
  const repo = createWebsiteDatabaseRepository(executor(async () => {
    const result = projection(++calls); await finish.promise; return result;
  }));
  const a = repo.list("movie"), b = repo.getLibraryYears!("movie");
  finish.release(); await Promise.all([a, b]);
  assert.equal(calls, 2);
});
