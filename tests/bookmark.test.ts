import test from "node:test";
import assert from "node:assert/strict";
import { bookmarkLabel } from "../src/lib/bookmark.ts";

test("a bookmark without a caption is named after its host, a video host in words", () => {
  assert.deepEqual(bookmarkLabel("https://youtu.be/xceR7mrrXsA", "youtu.be"), { kind: "video", title: "YouTube 视频", address: "youtu.be/xceR7mrrXsA" });
  assert.deepEqual(bookmarkLabel("https://www.youtube.com/watch?v=OjJfqo5_148", "www.youtube.com"), { kind: "video", title: "YouTube 视频", address: "youtube.com/watch?v=OjJfqo5_148" });
  assert.deepEqual(bookmarkLabel("https://www.bezkoder.com/vue-firebase-realtime-database/", "www.bezkoder.com"), { kind: "link", title: "bezkoder.com", address: "bezkoder.com/vue-firebase-realtime-database" });
  assert.deepEqual(bookmarkLabel("https://example.com/", ""), { kind: "link", title: "example.com", address: "example.com" });
});

test("a caption the author wrote is kept, even on a video", () => {
  assert.deepEqual(bookmarkLabel("https://youtu.be/abc", "Firebase 入门"), { kind: "video", title: "Firebase 入门", address: "youtu.be/abc" });
});

test("an address that does not parse is shown as written", () => {
  assert.deepEqual(bookmarkLabel("not a url", ""), { kind: "link", title: "not a url", address: "not a url" });
});

test("a video embed the source titled after its host reads as an unnamed video (review 2026-10-29)", () => {
  assert.deepEqual(bookmarkLabel("https://www.youtube.com/watch?v=OjJfqo5_148", "视频 · youtube.com"), { kind: "video", title: "YouTube 视频", address: "youtube.com/watch?v=OjJfqo5_148" });
  assert.deepEqual(bookmarkLabel("https://example.com/clip", "视频 · example.com"), { kind: "link", title: "example.com", address: "example.com/clip" });
  assert.equal(bookmarkLabel("https://youtu.be/xceR7mrrXsA", "视频 · 我的讲解").title, "视频 · 我的讲解");
});
