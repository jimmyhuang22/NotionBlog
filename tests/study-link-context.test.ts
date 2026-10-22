import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, ContentDocument } from "../contracts/content.ts";
import { studyLinkContexts } from "../src/lib/study-link-context.ts";

const heading = (id: string, title: string, level: 1 | 2 = 1): ContentBlock => ({ id, type: "heading", level, text: [{ text: title }] });
const child = (id: string, title = "Lesson summary", visible = true): ContentBlock => ({ id, type: "child-page", title, target: visible ? { href: `/study/demo/notes/${id}`, title } : null });
const document = (blocks: ContentBlock[]): ContentDocument => ({ blocks, toc: [], completeness: "complete" });

test("same-titled distinct children use actual main chapters without mutating the document", () => {
  const doc = document([heading("a", "Data exchange"), heading("a-sub", "Key ideas", 2), child("one"), heading("b", "Template bindings"), child("two")]);
  const before = structuredClone(doc);
  assert.deepEqual(studyLinkContexts(doc), { "/study/demo/notes/one": "Data exchange", "/study/demo/notes/two": "Template bindings" });
  assert.deepEqual(doc, before);
});

test("nested branches inherit their chapter without leaking a column's heading to its sibling", () => {
  const doc = document([heading("root", "Shared introduction"), { id: "columns", type: "columns", columns: [
    { ratio: 1, blocks: [heading("left", "Left chapter"), child("one")] },
    { ratio: 1, blocks: [child("two")] },
  ] }]);
  assert.deepEqual(studyLinkContexts(doc), { "/study/demo/notes/one": "Left chapter", "/study/demo/notes/two": "Shared introduction" });
});

test("unique targets, hidden pages and missing chapter evidence never fabricate a topic", () => {
  assert.deepEqual(studyLinkContexts(null), {});
  assert.deepEqual(studyLinkContexts(document([child("one"), child("two")])), {});
  assert.deepEqual(studyLinkContexts(document([heading("a", "Chapter"), child("one"), child("one"), child("hidden", "Lesson summary", false), child("unique", "Other page")])), {});
});
