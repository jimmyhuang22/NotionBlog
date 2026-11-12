import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import { demoSocialWorks } from "../fixtures/social-works.ts";
import * as format from "../src/lib/format.ts";
import * as homeFeed from "../src/lib/home-feed.ts";
import * as works from "../src/lib/works.ts";
import { mergeNumberedHeadings } from "../src/lib/headings.ts";

// Render the actual TSX views with their unrelated boundaries (pictures, platform signs, browser-only hooks)
// replaced by explicit local ports; no application environment is loaded.
function view(path: string, ports: Record<string, unknown> = {}): Record<string, any> {
  const output = transformSync(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    filename: path, swcrc: false, configFile: false, module: { type: "commonjs" },
    jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } },
  });
  const module = { exports: {} };
  const imports: Record<string, unknown> = { "react/jsx-runtime": jsx, react: React, ...ports };
  runInNewContext(output.code, { module, exports: module.exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected view dependency: ${name}`); return imports[name];
  } }, { timeout: 1000 });
  return module.exports;
}

const toc = [
  { id: "a", title: "第一章", level: 2 },
  { id: "a1", title: "第一章的小节", level: 3 },
  { id: "b", title: "第二章", level: 2 },
];

function outline(current = "") {
  return view("src/components/page-outline.tsx", {
    "./reading-outline": { useCurrentHeading: () => [current, () => {}], markArrival: () => {} },
    "./use-dismiss": { useModal: () => {}, closeOnBackdrop: () => {} },
    "./course-tree": { CourseTreeNav: () => null },
    "./directory-retry": { DirectoryRetry: () => null },
    "./study-reading-context": { useStudyReadingTree: () => null },
  }).PageOutline;
}

test("the in-page outline starts hidden and lists every heading as a real anchor in a labelled dialog", () => {
  const html = renderToStaticMarkup(React.createElement(outline("a1"), { toc }));
  // Shown only once the page has been measured: never in the first markup.
  assert.match(html, /<button[^>]*class="page-outline__open"[^>]*hidden=""/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.ok(html.includes('aria-label="本页目录，当前章节：第一章的小节"'));
  assert.match(html, /<dialog[^>]*class="page-outline"[^>]*aria-labelledby="([^"]+)"/);
  assert.ok(html.includes('aria-label="关闭目录"'));
  // The course tab is added in the browser below 1100 only; the first markup is the plain outline.
  assert.ok(!html.includes('role="tablist"'));
  for (const entry of toc) assert.ok(html.includes(`href="#${entry.id}"`), entry.id);
  // Only the chapter being read is marked, as a location; a deeper heading is set in.
  assert.equal(html.match(/aria-current="location"/g)?.length, 1);
  assert.match(html, /page-outline__item--2"><a href="#a1" aria-current="location"/);
  assert.match(html, /page-outline__item--1"><a href="#b">/);
});

test("a note with one heading or none gets no in-page outline button", () => {
  const PageOutline = outline();
  assert.equal(renderToStaticMarkup(React.createElement(PageOutline, { toc: [] })), "");
  assert.equal(renderToStaticMarkup(React.createElement(PageOutline, { toc: toc.slice(0, 1) })), "");
});

function workLine() {
  return view("src/components/home-works.tsx", {
    "../lib/home-feed.ts": homeFeed, "../lib/format.ts": format, "../lib/works.ts": works,
    "./cover-image": { CoverImage: ({ className }: { className: string }) => React.createElement("img", { className }) },
    "./entry-moment": { EntryMoment: () => null },
    "./platform-signs": { PlatformMark: () => React.createElement("svg"), PlatformExitNote: ({ name }: { name: string }) => React.createElement("span", null, `，在${name}打开`) },
    "./bili-card": { BiliCard: () => null, isBiliCard: () => false },
    "./social-work-card": { SocialWorkCard: () => null },
    "./work-strip": { WorkStrip: () => null },
  }).HomeWorkLine;
}
const render = (work: (typeof demoSocialWorks)[number]) => renderToStaticMarkup(React.createElement(workLine(), { work, timeZone: "UTC" }));
const byId = (id: string) => demoSocialWorks.find(work => work.id === id)!;

test("a single work on the home timeline is one light line that keeps its platform, kind and own figures", () => {
  const html = render(byId("demo-bilibili-1"));
  // Title first in the source, the picture after it (drawn first by the style sheet).
  assert.ok(html.indexOf("work-line__title") < html.indexOf("work-line__thumb"));
  assert.ok(html.includes("work-line__thumb--wide"));
  assert.ok(html.includes("B 站") && html.includes("视频") && html.includes("播放 0"));
  // Bilibili shows no likes; an address that was never checked is no link.
  assert.ok(!html.includes("点赞"));
  assert.ok(!html.includes("<a "));
});

test("a Xiaohongshu work keeps its upright picture and its likes", () => {
  const html = render(byId("demo-xiaohongshu-1"));
  assert.ok(html.includes("work-line__thumb--tall"));
  assert.ok(html.includes("点赞"));
  assert.ok(!html.includes("播放"));
});

test("a collection links to its newest episode and says what was added; a second platform gets its own line", () => {
  const collection = render(byId("demo-bilibili-2"));
  assert.match(collection, /<a class="work-line__main" href="https:\/\/www\.bilibili\.com\/video\/BV0000000002\/"[^>]*title="打开最新一集"/);
  assert.ok(collection.includes("work-line__update"));
  const both = render(byId("demo-bilibili-3"));
  assert.equal(both.match(/work-line__more/g)?.length, 1);
  assert.ok(both.includes("小红书"));
});

test("a heading that is only a number joins the heading after it and leads to the number", () => {
  const merged = mergeNumberedHeadings([
    { id: "n1", title: "1.", level: 2 }, { id: "t1", title: "Datalink Layer（Ethernet II Header）大小", level: 2 },
    { id: "n2", title: " 2 、", level: 2 }, { id: "t2", title: "IP Header", level: 3 },
    { id: "plain", title: "小结", level: 2 },
    { id: "n3", title: "3.", level: 2 }, { id: "n4", title: "4.", level: 2 },
  ]);
  assert.deepEqual(merged.map(entry => [entry.id, entry.title, entry.level, entry.covers ?? []]), [
    ["n1", "1. Datalink Layer（Ethernet II Header）大小", 2, ["t1"]],
    ["n2", "2 、 IP Header", 2, ["t2"]],
    ["plain", "小结", 2, []],
    // A number followed by another number, or by nothing, stays as it is.
    ["n3", "3.", 2, []],
    ["n4", "4.", 2, []],
  ]);
  // Headings with words and numbers are not numbers.
  assert.equal(mergeNumberedHeadings([{ id: "a", title: "Week 3", level: 2 }, { id: "b", title: "2024", level: 2 }, { id: "c", title: "x", level: 2 }]).length, 2);
});
