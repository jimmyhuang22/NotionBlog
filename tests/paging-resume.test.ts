import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "../contracts/content.ts";
import { resumeAfter, resumeBudget, type PageResult } from "../src/lib/paging-resume.ts";

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map(id => ({ id }));
/** A list endpoint over `all`, `size` a page; cursors are offsets. `refuse` makes chosen reads fail. */
function endpoint(all: Row[], size: number, refuse: (read: number) => string | null = () => null) {
  let reads = 0;
  const read = async (cursor: string | null): Promise<PageResult<Row>> => {
    const code = refuse(reads++);
    if (code) return { code };
    const from = cursor === null ? 0 : Number(cursor);
    const items = all.slice(from, from + size), next = from + size < all.length ? String(from + size) : null;
    const page: Page<Row> = { items, hasMore: next !== null, nextCursor: next, total: all.length };
    return { page };
  };
  return { read, reads: () => reads };
}

test("after new rows arrive above, the next rows follow the last one on screen and nothing shown moves", async () => {
  const shown = rows("a", "b", "c", "d");
  // Two new rows on top; the reader had four, the page size is two.
  const api = endpoint(rows("x", "y", "a", "b", "c", "d", "e", "f", "g"), 2);
  const result = await resumeAfter(shown, api.read, resumeBudget(shown.length, 2));
  assert.equal(result.kind, "resumed");
  if (result.kind !== "resumed") return;
  assert.deepEqual(result.added.map(row => row.id), ["e", "f"]);
  assert.equal(result.page.nextCursor, "8");
  assert.equal(api.reads(), 4);
});

test("a row that moved below the place is not shown twice, and the end of the list is reached cleanly", async () => {
  const shown = rows("a", "b", "c");
  const api = endpoint(rows("a", "c", "b", "d"), 2);
  const result = await resumeAfter(shown, api.read, 5);
  assert.equal(result.kind, "resumed");
  if (result.kind !== "resumed") return;
  assert.deepEqual(result.added.map(row => row.id), ["d"]);
  // Nothing after the place: an empty addition at the end, not a restart.
  const done = await resumeAfter(rows("a", "b"), endpoint(rows("a", "b"), 2).read, 3);
  assert.equal(done.kind, "resumed");
  if (done.kind === "resumed") { assert.deepEqual(done.added, []); assert.equal(done.page.hasMore, false); }
});

test("the place cannot be found: the last row was withdrawn, the list changed again, or the budget ran out", async () => {
  const shown = rows("a", "b", "c");
  assert.equal((await resumeAfter(shown, endpoint(rows("a", "b", "d", "e"), 2).read, 5)).kind, "lost");
  assert.equal((await resumeAfter(shown, endpoint(rows("a", "b", "c", "d"), 2, read => read === 1 ? "INVALID_QUERY" : null).read, 5)).kind, "lost");
  const far = endpoint(rows("n1", "n2", "n3", "n4", "n5", "n6", "a", "b", "c", "d"), 2);
  assert.equal((await resumeAfter(shown, far.read, 3)).kind, "lost");
  assert.equal(far.reads(), 3);
  assert.equal((await resumeAfter([], endpoint(rows("a"), 2).read, 3)).kind, "lost");
});

test("any other failure is reported as it is, and the budget stays small", async () => {
  const busy = await resumeAfter(rows("a"), endpoint(rows("a", "b"), 2, () => "RATE_LIMITED").read, 3);
  assert.deepEqual(busy, { kind: "error", code: "RATE_LIMITED" });
  assert.deepEqual([resumeBudget(16, 16), resumeBudget(48, 16), resumeBudget(500, 20), resumeBudget(5, 0)], [3, 5, 10, 7]);
});
