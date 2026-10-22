import test from "node:test";
import assert from "node:assert/strict";
import { fixtureItems } from "../fixtures/content.ts";
import type { StudyNode } from "../contracts/content.ts";
import { parseStudyProjects, studyProjects, studyProjectForCourse, coursesBySemester } from "../src/lib/study-projects.ts";
import { filterStudyEntries, orderStudyOverview, courseQuickLinks, studyReadingNodes, studyOverviewEntries, studyView, missingStudyChildren, documentStudyLinks, studyDateText, studyTypeLabels } from "../src/lib/study-overview.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { defaultContentFeatures } from "../config/features.ts";
import { routeVerdict } from "../src/lib/route-verdict.ts";

test("project membership only groups public courses and reserves explicit members before a catch-all", () => {
  const courses = fixtureItems.course;
  const rules = parseStudyProjects([
    { slug: "degree", title: "Degree", courseCodes: null },
    { slug: "practical", title: "Practical", layout: "sections", courseCodes: [courses[1].code.toLowerCase(), "UNPUBLISHED"] },
  ]);
  const projects = studyProjects(courses, rules);
  assert.deepEqual(projects[1].courses.map(c => c.id), [courses[1].id]);
  assert.ok(!projects[0].courses.some(c => c.id === courses[1].id));
  assert.equal(projects[1].layout, "sections");
  assert.equal(projects.flatMap(p => p.courses).length, courses.length);
  assert.equal(studyProjects([], rules).length, 0);
});

test("malformed project membership cannot accidentally collect all eligible courses", () => {
  const rules = parseStudyProjects([{ slug: "../../wrong", title: "Wrong", courseCodes: null }, { slug: "missing", title: "Missing membership" }, { slug: "invalid", title: "Invalid", courseCodes: [""] }]);
  assert.deepEqual(rules, []);
  assert.deepEqual(studyProjects(fixtureItems.course, rules), []);
  assert.equal(studyProjects(fixtureItems.course)[0].slug, "courses");
  assert.equal(coursesBySemester([{ ...fixtureItems.course[0], semester: null }, { ...fixtureItems.course[1], semester: "25S1" }])[1][0], null);
});

test("a qualified course resolves the same breadcrumb without loading other courses", () => {
  const courses = fixtureItems.course;
  const configurations = [undefined, [], parseStudyProjects([
    { slug: "general", title: "General", courseCodes: null },
    { slug: "selected", title: "Selected", courseCodes: [courses[1].code.toLowerCase()] },
    { slug: "duplicate", title: "Duplicate", courseCodes: [courses[1].code] },
  ]), parseStudyProjects([{ slug: "missing", title: "Missing", courseCodes: ["UNPUBLISHED"] }])];
  for (const rules of configurations) for (const course of courses) {
    const expected = studyProjects(courses, rules).find(project => project.courses.some(item => item.id === course.id));
    const actual = studyProjectForCourse(course, rules);
    assert.equal(actual?.slug, expected?.slug);
    assert.equal(actual?.href, expected?.href);
    assert.deepEqual(actual?.courses.map(item => item.id) ?? [], actual ? [course.id] : []);
  }
});

test("overview filters keep interleaved source order, equal dates, unknown dates and child boundaries", () => {
  const date = { start: "2026-03-02", end: "2026-03-08", precision: "date" as const };
  const entry = (id: string, title: string, noteType: StudyNode["noteType"]): StudyNode => ({ id, title, href: `/study/course/notes/${id}`, hasChildren: false, noteType, date });
  const nodes = [entry("note", "About", "note"), entry("week", "Week 1", "course"), entry("folio", "eFolio Week 1", "unknown"), entry("assignment", "Task", "assignment"), { ...entry("undated", "Reading", "note"), date: null }];
  nodes[1].children = [entry("nested", "Nested Task", "assignment")];
  assert.deepEqual(filterStudyEntries(nodes, "all", "").map(n => n.id), nodes.map(n => n.id));
  assert.deepEqual(filterStudyEntries(nodes, "assignments", "").map(n => n.id), ["folio", "assignment"]);
  assert.deepEqual(filterStudyEntries(nodes, "notes", "").map(n => n.id), ["note", "undated"]);
  assert.deepEqual(filterStudyEntries(nodes, "courses", "WEEK").map(n => n.id), ["week"]);
  assert.equal(filterStudyEntries(nodes, "assignments", "Nested").length, 0);
  assert.equal(nodes[4].date, null);
  const before = [nodes[0], nodes[3], nodes[1], nodes[2], nodes[4]];
  assert.deepEqual(orderStudyOverview(before).map(n => n.id), ["note", "week", "assignment", "folio", "undated"]);
  assert.deepEqual(before.map(n => n.id), ["note", "assignment", "week", "folio", "undated"]);
  assert.deepEqual(filterStudyEntries(orderStudyOverview(before), "assignments", "").map(n => n.id), ["assignment", "folio"]);
});

test("course quick links deduplicate only public targets and do not promote unavailable pages", () => {
  const target = { title: "Unit Structure", href: "/study/course/notes/structure" };
  assert.deepEqual(courseQuickLinks({ completeness: "partial", toc: [], blocks: [
    { id: "a", type: "child-page", title: "Unit Structure", target },
    { id: "b", type: "columns", columns: [{ ratio: null, blocks: [{ id: "c", type: "child-page", title: "Unit Structure", target }, { id: "d", type: "child-page", title: "Private", target: null }] }] },
  ] }), [target]);
});

test("the mock directory includes existing eligible type/date metadata without reading note bodies", async () => {
  const repository = createContentService().repository;
  const tree = await repository.getCourseTree("demo101");
  const note = fixtureItems["study-note"].find(n => n.id === tree!.nodes[0].id)!;
  assert.equal(tree!.nodes[0].noteType, note.noteType);
  assert.deepEqual(tree!.nodes[0].date, note.date);
  assert.equal("document" in tree!.nodes[0], false);
});

test("learning project routes check eligible membership before streaming and preserve 404/503 semantics", async () => {
  const repo = createContentService().repository;
  const lookup = { studyProject: async (slug: string) => slug === "degree" };
  assert.equal(await routeVerdict("/study/projects/degree", defaultContentFeatures, repo, undefined, lookup), "found");
  assert.equal(await routeVerdict("/study/projects/missing", defaultContentFeatures, repo, undefined, lookup), "missing");
  assert.equal(await routeVerdict("/study/projects/degree", { ...defaultContentFeatures, course: false }, repo, undefined, lookup), "missing");
  assert.equal(await routeVerdict("/study/projects/degree", defaultContentFeatures, repo, undefined, { studyProject: async () => { throw Error("unavailable"); } }), "unknown");
});


test("overview and reading share root order while search finds qualified descendants with their context", () => {
  const node = (id: string, title: string, noteType: StudyNode["noteType"]): StudyNode => ({ id, title, href: `/study/course/notes/${id}`, hasChildren: false, noteType, date: { start: "2026-03-02", end: null, precision: "date" } });
  const child = node("child", "Getting started", "note"), task = node("task", "Nested Task", "assignment");
  child.children = [task];
  const week = { ...node("week", "Week 1", "course"), children: [child], hasChildren: true };
  const resource = { ...node("resource", "Resource", "note"), children: [node("excluded", "Getting started private", "note")] };
  const source = [node("assignment", "Assignment", "assignment"), week, resource];
  const ordered = studyReadingNodes(source, [resource.href]);
  assert.deepEqual(ordered.map(n => n.id), ["week", "assignment"]);
  assert.deepEqual(source.map(n => n.id), ["assignment", "week", "resource"]);
  assert.equal(ordered[0].children, week.children);
  assert.deepEqual(studyOverviewEntries(ordered, "all", "").map(e => e.node.id), ["week", "assignment"]);
  assert.deepEqual(studyOverviewEntries(ordered, "all", "GETTING").map(e => ({ id: e.node.id, path: e.path })), [{ id: "child", path: ["Week 1"] }]);
  assert.deepEqual(studyOverviewEntries(ordered, "assignments", "Nested").map(e => ({ id: e.node.id, path: e.path })), [{ id: "task", path: ["Week 1", "Getting started"] }]);
  assert.equal(studyOverviewEntries(ordered, "courses", "Getting").length, 0);
  assert.equal(studyOverviewEntries(ordered, "notes", "private").length, 0);
  assert.equal(studyView("invalid"), "all");
  assert.equal(studyView("assignments"), "assignments");
});

test("parent navigation supplements only missing qualified immediate children and deduplicates body links", () => {
  const child = (id: string): StudyNode => ({ id, title: id, href: `/study/course/notes/${id}`, hasChildren: false });
  const first = child("one"), second = child("two"), third = child("three"), grandchild = child("deep");
  third.children = [grandchild];
  const parent = { ...child("parent"), children: [first, second, third], hasChildren: true };
  const roots = [{ ...child("root"), children: [parent] }];
  assert.deepEqual(missingStudyChildren(roots, parent.href, []).map(n => n.id), ["one", "two", "three"]);
  assert.deepEqual(missingStudyChildren(roots, parent.href, documentStudyLinks({ toc: [], completeness: "partial", blocks: [
    { id: "toggle", type: "toggle", title: [], children: [{ id: "link", type: "child-page", title: "One", target: { href: first.href, title: "One" } }] },
    { id: "paragraph", type: "paragraph", text: [{ text: "Two", link: { kind: "internal", href: second.href + "#part" } }] },
    { id: "notice", type: "unsupported", label: "Unavailable" },
  ] })).map(n => n.id), ["three"]);
  assert.deepEqual(missingStudyChildren(roots, "/not-qualified", []), []);
  assert.deepEqual(missingStudyChildren(roots, first.href, []), []);
});

test("overview dates read as site words: a year only across years, the month only when it changes", () => {
  const day = (year: number, month: number, d: number, time: string | null = null) => ({ year, month, day: d, time });
  assert.deepEqual(studyDateText(day(2025, 3, 3), day(2025, 3, 9)), ["3 月 3 日", "9 日"]);
  assert.deepEqual(studyDateText(day(2025, 3, 31), day(2025, 4, 6)), ["3 月 31 日", "4 月 6 日"]);
  assert.deepEqual(studyDateText(day(2025, 12, 29), day(2026, 1, 4)), ["2025 年 12 月 29 日", "2026 年 1 月 4 日"]);
  assert.deepEqual(studyDateText(day(2025, 5, 12), null), ["5 月 12 日", null]);
  assert.deepEqual(studyDateText(day(2025, 5, 12, "09:00"), day(2025, 5, 12, "11:30")), ["5 月 12 日 09:00", "11:30"]);
  assert.deepEqual(Object.values(studyTypeLabels).map(label => label.mark), ["课", "记", "作", "作"]);
});
