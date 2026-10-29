import assert from "node:assert/strict";
import test from "node:test";
import type { Post } from "../contracts/content.ts";
import { postGroups } from "../src/lib/post-groups.ts";

const post = (id: string, start: string | null): Post => ({
  id, slug: id, href: `/blog/${id}`, title: id, summary: null, tags: [], cover: null, updatedAt: null, kind: "post",
  publishedAt: start ? { start, end: null, precision: "date" } : null,
});

test("blog posts group by year, with undated ones last under their own heading", () => {
  const groups = postGroups([post("a", "2026-03-01"), post("b", "2025-12-30"), post("c", null)], "UTC");
  assert.deepEqual(groups.map(group => [group.label, group.items.map(item => item.post.id)]), [["2026", ["a"]], ["2025", ["b"]], ["日期未记录", ["c"]]]);
  assert.equal(groups[0]!.items[0]!.day, "3 月 1 日");
});

test("a blog list with no dates at all has no heading", () => {
  const groups = postGroups([post("a", null), post("b", null)], "UTC");
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, null);
  assert.deepEqual(groups[0]!.items.map(item => item.day), [null, null]);
});
