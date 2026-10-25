import assert from "node:assert/strict";
import test from "node:test";
import type { RichTextItemResponse } from "@notionhq/client";
import type { TextRun } from "../contracts/content.ts";
import type { SyncRecord } from "../contracts/sync.ts";
import { convertNotionRichText } from "../src/server/notion/blocks.ts";
import { rewriteStudyLinks } from "../src/server/notion/rewrite-study-links.ts";
import { validateWebsiteRecord } from "../src/server/database/website-validation.ts";
import { validateSyncRecord } from "../src/server/database/validation.ts";
import { cacheFixture } from "./helpers/content-cache.ts";

test("only an opted-in page mention retains title provenance; v1 and authored labels keep their shape", async () => {
  const annotations = { bold: true, italic: false, code: false, underline: false, strikethrough: false, color: "default" as const };
  const page = "00000000000000000000000000000001", href = "/study/course/notes/note";
  const mention: RichTextItemResponse = { type: "mention", mention: { type: "page", page: { id: page } }, plain_text: "Raw source label", href: null, annotations };
  const authored: RichTextItemResponse = { type: "text", text: { content: "My own label", link: { url: new URL(`/${page}`, "https://www.notion.so").href } }, plain_text: "My own label", href: null, annotations };
  const equation: RichTextItemResponse = { type: "equation", equation: { expression: "x=1" }, plain_text: "x=1", href: null, annotations };
  const database: RichTextItemResponse = { ...mention, mention: { type: "database", database: { id: page } } };
  const user: RichTextItemResponse = { ...mention, mention: { type: "user", user: { object: "user", id: page } } };
  const context = { resolvePageLink: async () => ({ href, title: "Current title" }), registerImage: async () => assert.fail() };
  const legacy = await convertNotionRichText([mention, authored], context);
  assert.deepEqual(legacy.map(run => run.pageMention), [undefined, undefined]);
  const runs = await convertNotionRichText([mention, authored, equation, database, user], { ...context, pageMentions: true, inlineEquations: true });
  assert.deepEqual(runs.map(run => run.pageMention), [true, undefined, undefined, undefined, undefined]);
  assert.equal(runs[0].text, "Current title"); assert.equal(runs[0].bold, true);
  assert.equal(runs[1].text, "My own label"); assert.equal(runs[2].equation, true);
  const unavailable = await convertNotionRichText([mention], { ...context, pageMentions: true, resolvePageLink: async () => null });
  assert.deepEqual(unavailable[0], { text: "Unavailable page", bold: true, color: "default", link: { kind: "unavailable" }, pageMention: true });
});

test("v2 accepts only a strict page-mention marker with an internal or unavailable target; v1 rejects it", () => {
  const record = cacheFixture().ordinary;
  const setRun = (run: unknown) => { record.detail.document!.blocks = [{ id: "mention", type: "paragraph", text: [run as TextRun] }]; };
  setRun({ text: "Legacy", link: { kind: "internal", href: "/study/course" } });
  assert.doesNotThrow(() => validateWebsiteRecord(record));
  assert.doesNotThrow(() => validateSyncRecord(record as SyncRecord));
  for (const link of [{ kind: "internal", href: "/study/course" }, { kind: "unavailable" }]) {
    setRun({ text: "Title", pageMention: true, link });
    assert.doesNotThrow(() => validateWebsiteRecord(record));
    assert.throws(() => validateSyncRecord(record as SyncRecord));
  }
  for (const run of [
    ...[false, "true", null, 1].map(pageMention => ({ text: "Title", pageMention, link: { kind: "internal", href: "/study/course" } })),
    { text: "Title", pageMention: true },
    { text: "Title", pageMention: true, link: { kind: "external", url: "https://example.test/" } },
    { text: "Title", pageMention: true, equation: true, link: { kind: "internal", href: "/study/course" } },
  ]) { setRun(run); assert.throws(() => validateWebsiteRecord(record)); }
});

test("rename and withdrawal update marked labels and existing TOC entries without guessing legacy or authored text", () => {
  const href = "/study/course/notes/old", target = { href: "/study/course/notes/new", title: "New title" };
  const marked = { text: "Old title", pageMention: true as const, bold: true, italic: true, color: "accent" as const, link: { kind: "internal" as const, href } };
  const authored = { text: "My label", link: { kind: "internal" as const, href } }, legacy = { ...authored, text: "Old title" };
  const document = { blocks: [{ id: "heading", type: "heading", level: 2, text: [marked, { text: " suffix" }] },
    { id: "body", type: "paragraph", text: [authored, legacy] }],
    toc: [{ id: "heading", level: 2, title: "Old title suffix" }, { id: "other", level: 3, title: "Keep this" }], completeness: "complete" };
  const before = JSON.stringify(document);
  const renamed = rewriteStudyLinks(document, new Map([[href, target]])) as typeof document;
  assert.deepEqual(renamed.blocks[0].text[0], { ...marked, text: target.title, link: { kind: "internal", href: target.href } });
  assert.deepEqual(renamed.blocks[1].text, [{ ...authored, link: { kind: "internal", href: target.href } }, { ...legacy, link: { kind: "internal", href: target.href } }]);
  assert.deepEqual(renamed.toc, [{ ...document.toc[0], title: "New title suffix" }, document.toc[1]]);
  const withdrawn = rewriteStudyLinks(document, new Map([[href, null]])) as typeof document;
  assert.equal(withdrawn.blocks[0].text[0].text, "Unavailable page");
  assert.deepEqual((withdrawn.blocks[0].text[0] as TextRun).link, { kind: "unavailable" });
  assert.equal(withdrawn.toc[0].title, "Unavailable page suffix");
  assert.equal(withdrawn.blocks[1].text[0].text, authored.text);
  assert.equal(JSON.stringify(document), before);
});
