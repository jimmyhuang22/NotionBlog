import test from "node:test";
import assert from "node:assert/strict";
import { CONTENT_KINDS } from "../config/features.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { projectLinks, projectMeta } from "../src/lib/project.ts";
import { MAX_QUERY, isSearchShortcut, kindLabels, readQuery, searchHref, searchResultHref, searchKinds, splitMatch, stepOption, readableExcerpt } from "../src/lib/search.ts";
import { readStatusFocus, readStatusHash } from "../src/lib/status-focus.ts";

test("a search query is trimmed and refused when empty, too long or unprintable", () => {
  assert.equal(readQuery("  学习  "), "学习");
  assert.equal(readQuery(""), null);
  assert.equal(readQuery("   "), null);
  assert.equal(readQuery(["a", "b"]), null);
  assert.equal(readQuery(undefined), null);
  assert.equal(readQuery("x".repeat(MAX_QUERY)), "x".repeat(MAX_QUERY));
  assert.equal(readQuery("x".repeat(MAX_QUERY + 1)), null);
  assert.equal(readQuery("a\u0000b"), null);
});

test("every content kind has a label, and the address keeps the words when the section changes", () => {
  assert.deepEqual(searchKinds.map(([kind]) => kind).sort(), [...CONTENT_KINDS].sort());
  assert.equal(kindLabels["study-note"], "笔记");
  assert.equal(searchHref("学习 笔记", null), "/search?q=%E5%AD%A6%E4%B9%A0+%E7%AC%94%E8%AE%B0");
  assert.equal(searchHref("a&b", "study-note"), "/search?q=a%26b&kind=study-note");
});

test("the first match is split out for marking, ignoring case, and nothing is invented when absent", () => {
  assert.deepEqual(splitMatch("慢慢记录学习和生活", "学习"), ["慢慢记录", "学习", "和生活"]);
  assert.deepEqual(splitMatch("Hello TypeScript", "typescript"), ["Hello ", "TypeScript", ""]);
  assert.deepEqual(splitMatch("aXbXc", "x"), ["a", "X", "bXc"]);
  assert.equal(splitMatch("没有这个词", "学习"), null);
  assert.equal(splitMatch("anything", ""), null);
  // "<b>" in a title is text, and stays text in each part.
  assert.deepEqual(splitMatch("a <b>学习</b>", "学习"), ["a <b>", "学习", "</b>"]);
});

test("a project states an unknown period, omits an unknown role and only offers web links", () => {
  const base = fixtureItems.project[0]!;
  assert.equal(projectMeta({ ...base, role: "个人项目", period: { start: "2026-09-03", end: null, precision: "date" } }, "UTC"), "个人项目 · 2026 年 9 月 3 日");
  assert.equal(projectMeta({ ...base, role: null, period: null }, "UTC"), "时间未记录");
  assert.equal(projectMeta({ ...base, role: "课程作业", period: { start: "2026-03-01", end: "2026-06-30", precision: "date" } }, "UTC"), "课程作业 · 2026 年 3 月 1 日 至 6 月 30 日");
  const links = [{ label: "演示", url: "https://example.test/a" }, { label: "脚本", url: "javascript:alert(1)" }, { label: "", url: "https://example.test/b" }, { label: "本地", url: "/relative" }, { label: "旧站", url: "HTTP://example.test" }];
  assert.deepEqual(projectLinks({ ...base, links }).map(link => link.label), ["演示", "旧站"]);
});

test("quick search opens on slash outside text fields and on Ctrl or Command K anywhere", () => {
  const press = (key: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...extra });
  assert.equal(isSearchShortcut(press("/"), false), true);
  assert.equal(isSearchShortcut(press("/"), true), false);
  assert.equal(isSearchShortcut(press("/", { ctrlKey: true }), false), false);
  assert.equal(isSearchShortcut(press("k", { metaKey: true }), true), true);
  assert.equal(isSearchShortcut(press("K", { ctrlKey: true }), false), true);
  assert.equal(isSearchShortcut(press("k"), false), false);
  assert.equal(isSearchShortcut(press("k", { metaKey: true, altKey: true }), false), false);
  // A slash typed through an input method is text, not a shortcut.
  assert.equal(isSearchShortcut(press("/", { isComposing: true }), false), false);
});

test("arrow keys walk the options, wrap at both ends and start from the nearest edge", () => {
  assert.equal(stepOption(-1, 3, 1), 0);
  assert.equal(stepOption(-1, 3, -1), 2);
  assert.equal(stepOption(2, 3, 1), 0);
  assert.equal(stepOption(0, 3, -1), 2);
  assert.equal(stepOption(1, 3, 1), 2);
  assert.equal(stepOption(0, 0, 1), -1);
});

test("an older status search hit requests its record independently of list pagination", () => {
  const hit = { kind: "status" as const, id: "older-status", href: "/status#older-status" };
  const url = new URL(searchResultHref(hit), "https://example.test");
  assert.equal(url.pathname, "/status");
  assert.equal(url.searchParams.get("focus"), hit.id);
  assert.equal(url.hash, "#older-status");
  assert.equal(searchResultHref({ kind: "book", id: "book-1", href: "/library/books/first" }), "/library/books/first");
});

test("focus keys and legacy hashes cannot inject a path, repeated query, or malformed escape", () => {
  for (const key of ["", "a/b", "a\\b", "a?year=2025", "#target", " a ", "x".repeat(129), ["a", "b"], undefined]) {
    assert.equal(readStatusFocus(key), null);
  }
  assert.equal(readStatusFocus("status-older_1"), "status-older_1");
  assert.equal(readStatusHash("#status-older_1"), "status-older_1");
  assert.equal(readStatusHash("#%2Fprivate"), null);
  assert.equal(readStatusHash("#%broken"), null);
  assert.equal(readStatusHash(""), null);
  // The footer's "回到顶部" on the status page must not be read as a status to find (it led to /status?focus=top, a 404).
  assert.equal(readStatusHash("#top"), null);
});

test("an excerpt folds a Markdown table into （表格） and leaves a stray bar alone", () => {
  assert.equal(readableExcerpt("直接粘贴到Notion Page | 水果 | 蔬菜 | | ---- | ---- | | 西瓜 | 香菜 | Sw"), "直接粘贴到Notion Page （表格） Sw");
  assert.equal(readableExcerpt("A | B 不是表格"), "A | B 不是表格");
  assert.equal(readableExcerpt("| :--- | --- |"), "（表格）");
});
