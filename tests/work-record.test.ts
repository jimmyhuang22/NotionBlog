import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock, ContentDocument, DateRange } from "../contracts/content.ts";
import { bookRecord, gameRecord, movieRecord } from "../src/lib/work-record.ts";

const runs = (text: string) => (text ? [{ text }] : []);
const h = (id: string, text: string, level: 1 | 2 | 3 = 1): ContentBlock => ({ id, type: "heading", level, text: runs(text) });
const p = (id: string, text = ""): ContentBlock => ({ id, type: "paragraph", text: runs(text) });
const table = (id: string, rows: string[][]): ContentBlock => ({ id, type: "table", hasColumnHeader: false, hasRowHeader: true, rows: rows.map(row => row.map(runs)) });
const doc = (blocks: ContentBlock[]): ContentDocument => ({
  blocks,
  toc: blocks.flatMap(block => block.type === "heading" ? [{ id: block.id, level: block.level, title: block.text.map(run => run.text).join("") }] : []),
  completeness: "complete",
});
const day = (start: string, end: string | null = null): DateRange => ({ start, end, precision: "date" });

/** The template as it comes from the source: outline, viewings, empty excerpts, a dated summary, empty other. */
const template = (rows: string[][]) => doc([
  { id: "toc", type: "table-of-contents" }, p("p0"),
  h("v", "多刷记录"), table("t", rows),
  h("x", "摘录"),
  h("s", "总结"), h("s1", "2024/04/03", 2), p("s2", "看了18:30的场。"), p("s3"),
  h("o", "其他"), p("o1"),
]);

test("the template's viewings move out of the body; the outline and empty headings go; 总结 reads 观后感", () => {
  const record = movieRecord(template([["1", "2024/04/03"], ["2", ""]]), day("2024-04-03"));
  assert.deepEqual(record.viewings, [day("2024-04-03")]);
  assert.deepEqual(record.document!.blocks.map(block => block.id), ["s", "s1", "s2"]);
  assert.equal((record.document!.blocks[0] as Extract<ContentBlock, { type: "heading" }>).text[0]!.text, "观后感");
  assert.equal((record.document!.blocks[1] as Extract<ContentBlock, { type: "heading" }>).text[0]!.text, "2024 年 4 月 3 日");
  assert.deepEqual(record.document!.toc.map(entry => [entry.id, entry.title]), [["s", "观后感"], ["s1", "2024 年 4 月 3 日"]]);
});

test("a row of two dates is one viewing over those days; viewings are oldest first", () => {
  const record = movieRecord(template([["1", "2023/08/24"], ["2", "2022/05/01 → 2022/05/07"]]), null);
  assert.deepEqual(record.viewings, [day("2022-05-01", "2022-05-07"), day("2023-08-24")]);
});

test("the record's own date joins the viewings only when the table does not already name that day", () => {
  assert.deepEqual(movieRecord(template([["1", "2022/05/01 → 2022/05/07"]]), day("2022-05-03")).viewings, [day("2022-05-01", "2022-05-07")]);
  assert.deepEqual(movieRecord(template([["1", "2022/05/01 → 2022/05/07"], ["2", "2023/08/24"]]), day("2024-04-03", "2024-04-03")).viewings,
    [day("2022-05-01", "2022-05-07"), day("2023-08-24"), day("2024-04-03", "2024-04-03")]);
  assert.deepEqual(movieRecord(doc([p("a", "写了几句。")]), day("2024-05-25")).viewings, [day("2024-05-25")]);
  assert.deepEqual(movieRecord(doc([]), null).viewings, []);
});

test("a viewings section holding anything but dates stays in the body as written", () => {
  const words = movieRecord(doc([h("v", "多刷记录"), table("t", [["1", "和朋友一起看"]])]), day("2024-01-01"));
  assert.deepEqual(words.document!.blocks.map(block => block.id), ["v", "t"]);
  assert.deepEqual(words.viewings, [day("2024-01-01")]);
  const mixed = movieRecord(doc([h("v", "多刷记录"), table("t", [["1", "2024/01/01"]]), p("n", "第二次在家")]), null);
  assert.deepEqual(mixed.document!.blocks.map(block => block.id), ["v", "t", "n"]);
  assert.deepEqual(mixed.viewings, []);
});

test("unknown headings and text before the first heading are kept; a body that did not load stays null", () => {
  const record = movieRecord(doc([p("a", "开头一句"), h("r", "参考资料"), { id: "b", type: "bookmark", title: "x", url: "https://example.com", description: null }]), null);
  assert.deepEqual(record.document!.blocks.map(block => block.id), ["a", "r", "b"]);
  assert.equal(movieRecord(null, day("2024-01-01")).document, null);
  assert.deepEqual(movieRecord(null, day("2024-01-01")).viewings, [day("2024-01-01")]);
});

test("the episode tracker is left out while nothing in it is ticked, and kept once anything is", () => {
  const boxes = (id: string, from: number, ticked = -1): ContentBlock => ({ id, type: "list", ordered: false, items: [0, 1, 2].map(step => ({ id: `${id}${step}`, text: runs(String(from + step)), checked: from + step === ticked, children: [] })) });
  const tracker = (ticked = -1): ContentBlock => ({ id: "c", type: "columns", columns: [{ ratio: null, blocks: [boxes("l", 1, ticked)] }, { ratio: null, blocks: [boxes("r", 4, ticked)] }] });
  assert.deepEqual(movieRecord(doc([tracker(), h("s", "总结"), p("a", "好看")]), null).document!.blocks.map(block => block.id), ["s", "a"]);
  assert.deepEqual(movieRecord(doc([tracker(5), h("s", "总结"), p("a", "好看")]), null).document!.blocks.map(block => block.id), ["c", "s", "a"]);
  // A heading over an untouched tracker alone says nothing either.
  assert.deepEqual(movieRecord(doc([h("e", "集数"), boxes("l", 1)]), null).document!.blocks, []);
  // A list of words with boxes is the owner's, ticked or not.
  const words: ContentBlock = { id: "w", type: "list", ordered: false, items: [{ id: "w0", text: runs("重看结尾"), checked: false, children: [] }] };
  assert.deepEqual(movieRecord(doc([words]), null).document!.blocks.map(block => block.id), ["w"]);
});

const list = (id: string, texts: string[]): ContentBlock => ({ id, type: "list", ordered: false, items: texts.map((text, index) => ({ id: `${id}${index}`, text: runs(text), checked: null, children: [] })) });
const ids = (document: ContentDocument | null) => document?.blocks.map(block => block.id);
const heading = (document: ContentDocument | null, id: string) => (document!.blocks.find(block => block.id === id) as Extract<ContentBlock, { type: "heading" }>).text[0]!.text;

test("a book's excerpts come apart from the rest, each part headed with its count", () => {
  const record = bookRecord(doc([
    { id: "toc", type: "table-of-contents" }, p("p0"),
    h("x", "摘录"), h("a", "第一部", 2), list("l1", ["一", "二"]), p("q", "三"), h("b", "第二部", 2), list("l2", ["四"]), { id: "d", type: "divider" },
    h("r", "感想"), p("r1", "读完了。"),
  ]));
  assert.equal(record.excerptCount, 4);
  assert.deepEqual(ids(record.excerpts), ["a", "l1", "q", "b", "l2", "d"]);
  assert.equal(heading(record.excerpts, "a"), "第一部 · 3 条");
  assert.equal(heading(record.excerpts, "b"), "第二部 · 1 条");
  assert.deepEqual(record.excerpts!.toc.map(entry => entry.title), ["第一部 · 3 条", "第二部 · 1 条"]);
  assert.deepEqual(ids(record.rest), ["r", "r1"]);
  assert.equal(heading(record.rest, "r"), "读后感");
});

test("an empty review heading goes, other headings keep their names, and a book without excerpts has none", () => {
  const record = bookRecord(doc([h("x", "摘录"), list("l", ["一"]), h("r", "书评"), p("e1"), p("e2"), h("g", "梗概"), p("g1", "讲的是……")]));
  assert.deepEqual(ids(record.rest), ["g", "g1"]);
  assert.equal(heading(record.rest, "g"), "梗概");
  const none = bookRecord(doc([h("r", "感受"), p("r1", "好书")]));
  assert.equal(none.excerpts, null);
  assert.equal(none.excerptCount, 0);
  assert.deepEqual(ids(none.rest), ["r", "r1"]);
  assert.deepEqual(ids(bookRecord(doc([])).rest), []);
});

test("a book's body that did not load stays unloaded", () => {
  assert.deepEqual(bookRecord(null), { excerpts: null, excerptCount: 0, rest: null });
});

test("an empty bullet among the excerpts is neither a slip nor counted", () => {
  const record = bookRecord(doc([h("x", "摘录"), list("l", ["一", "", "二"]), list("e", [""])]));
  assert.equal(record.excerptCount, 2);
  assert.deepEqual(ids(record.excerpts), ["l"]);
  assert.equal((record.excerpts!.blocks[0] as Extract<ContentBlock, { type: "list" }>).items.length, 2);
});

test("a game's record keeps its own headings and drops the outline and the empty ones", () => {
  const record = gameRecord(doc([{ id: "toc", type: "table-of-contents" }, h("g", "游玩内容目标"), p("g1", "主线剩盖侬没打"), h("f", "游玩感受"), p("f1")]));
  assert.deepEqual(ids(record), ["g", "g1"]);
  assert.equal(heading(record, "g"), "游玩内容目标");
  assert.equal(gameRecord(null), null);
});

test("a sub-heading with nothing under it before the next heading goes", () => {
  const record = gameRecord(doc([h("a", "游戏相关"), p("a1", "官网"), h("g", "图片收集", 2), h("b", "游玩历程"), h("w", "等待快递中", 2), p("w1", "快到了"), h("e", "收尾", 2)]));
  assert.deepEqual(ids(record), ["a", "a1", "b", "w", "w1"]);
});
