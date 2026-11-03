import test from "node:test";
import assert from "node:assert/strict";
import { sectionLoadingTitle } from "../src/lib/section-loading.ts";

test("known section roots can show their public heading before content is read", () => {
  for (const [path, title] of [["/status", "动态"], ["/study", "学习"], ["/works", "作品"],
    ["/library/games", "游戏"], ["/library/books", "书籍"], ["/library/movies", "影视"], ["/photos", "相册"]])
    assert.equal(sectionLoadingTitle(path!), title);
});

test("a detail, nested note, home hero or unknown route never inherits a section-root loading transition", () => {
  for (const path of [null, "/", "/library/books/example", "/study/course/notes/example", "/study/course",
    "/works/unknown", "/library/toString", "/unknown", "toString", "/content-unavailable"])
    assert.equal(sectionLoadingTitle(path), undefined);
});
