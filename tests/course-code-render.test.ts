import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import { fixtureItems } from "../fixtures/content.ts";
import type { Course } from "../contracts/content.ts";
import * as format from "../src/lib/format.ts";
import * as projects from "../src/lib/study-projects.ts";
import * as overview from "../src/lib/study-overview.ts";

// Render the actual TSX views. Next navigation, images and the asynchronous directory are
// unrelated boundaries, replaced with explicit local ports; no application environment is loaded.
function view(path: string, ports: Record<string, unknown> = {}): Record<string, any> {
  const output = transformSync(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    filename: path, swcrc: false, configFile: false, module: { type: "commonjs" },
    jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } },
  });
  const module = { exports: {} };
  const Link = ({ href, children, prefetch: _prefetch, ...props }: any) => React.createElement("a", { href, ...props }, children);
  const imports: Record<string, unknown> = { "react/jsx-runtime": jsx, react: React, "next/link": Link,
    "@/lib/format": format, "@/components/link-pending": { LinkPending: () => null }, ...ports };
  runInNewContext(output.code, { module, exports: module.exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected view dependency: ${name}`); return imports[name];
  } }, { timeout: 1000 });
  return module.exports;
}
const course = (code: string | null): Course => ({ ...fixtureItems.course[0], cover: null, semester: null, code,
  title: code ? `${code} Source title` : "ABC123 Full source title" });

test("course cards keep a missing code out of accessible labels and retain the full source title", () => {
  const { StudyCourseGrid } = view("src/components/study-course-grid.tsx", { "./cover-image": { CoverImage: () => null } });
  for (const code of [null, "REAL42"]) {
    const item = course(code), html = renderToStaticMarkup(React.createElement(StudyCourseGrid, { courses: [item] }));
    assert.ok(html.includes(`href="${item.href}"`));
    assert.ok(html.includes(`aria-label="${item.title}"`));
    assert.ok(html.includes(`<span class="course-card__code">${code ?? ""}</span>`));
    assert.ok(html.includes(`<span class="course-card__title">${code ? "Source title" : item.title}</span>`));
    assert.equal(html.includes("null"), false);
  }
});

test("course page headers and breadcrumbs render nullable DTOs without guessing a code", async () => {
  for (const code of [null, "REAL42"]) {
    const item = course(code);
    const { default: CoursePage } = view("src/app/study/[course]/page.tsx", {
      react: { ...React, Suspense: () => null },
      "next/navigation": { notFound: () => assert.fail("Qualified course must remain available") },
      "@/components/cover-image": { CoverImage: () => null },
      "@/components/directory-retry": { DirectoryRetry: () => null },
      "@/components/rich-document": { RichDocumentBody: () => null },
      "@/components/study-overview": { StudyOverview: () => null },
      "@/lib/request-cache": { getCourse: async () => ({ item, document: null }), getCourseTree: async () => assert.fail("Directory boundary is excluded") },
      "@/lib/study-projects": projects, "@/lib/study-overview": overview,
      "@/lib/site": { getSiteConfig: () => ({ studyProjects: undefined }) },
      "@/lib/seo/metadata": { contentMetadata: () => ({}) }, "@/lib/page-freshness": { alwaysFresh: async () => {} },
    });
    const html = renderToStaticMarkup(await CoursePage({ params: Promise.resolve({ course: item.slug }) }));
    assert.ok(html.includes(`<h1>${code ? "Source title" : item.title}</h1>`));
    assert.ok(html.includes(`<span aria-current="page">${code ?? item.title}</span>`));
    assert.equal(html.includes("null"), false);
  }
});

test("note breadcrumbs and the back link use the course title when its code is null", () => {
  const { NoteCrumbs } = view("src/components/note-crumbs.tsx");
  for (const code of [null, "REAL42"]) {
    const item = course(code), html = renderToStaticMarkup(React.createElement(NoteCrumbs, {
      trail: [{ href: item.href, title: item.title }], title: "Week 1", courseCode: code,
    }));
    assert.ok(html.includes(`href="${item.href}"`));
    assert.ok(html.includes(`>${code ?? item.title}</a>`));
    assert.ok(html.includes(`<span>${code ?? item.title}</span>`));
    assert.equal(html.includes("null"), false);
  }
});
