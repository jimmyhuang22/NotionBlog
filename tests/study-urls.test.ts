import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import type { Course, StudyNote } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { qualifyRoute } from "../src/lib/qualify-route.ts";
import { routeAnswer, routeVerdict } from "../src/lib/route-verdict.ts";
import { sitemapXml } from "../src/lib/seo/discovery.ts";
import { createIncrementalPublisher, preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createStudyUrlProjection } from "../src/server/database/study-urls.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { ownerInstallFixture } from "./helpers/owner-install.ts";
import { studyId } from "./helpers/study-runtime.ts";

const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as ContentFeatures;

function course(number: number, code: string | null, title: string): Course {
  const id = studyId(number);
  return { ...structuredClone(fixtureItems.course[0]), id, slug: id, href: `/study/${id}`, code, title, cover: null };
}

function note(number: number, owner: Course, title: string, parent?: StudyNote): StudyNote {
  const id = studyId(number);
  return { ...structuredClone(fixtureItems["study-note"][0]), id, slug: id, href: `${owner.href}/notes/${id}`,
    courseId: owner.id, parentId: parent?.id ?? null, title, cover: null, noteType: "note",
    breadcrumbs: [owner, ...(parent ? [parent] : [])].map(item => ({ title: item.title, href: item.href })) };
}

function row(item: Course | StudyNote, ordinal: number): WebsiteRecord {
  const owner = item.kind === "study-note" ? item : null;
  return { detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
    evidence: { sourceKey: owner ? "notes" : "courses", dataSourceId: "example-study-source",
      databaseParentId: null, courseId: owner?.courseId ?? null, parentId: owner?.parentId ?? owner?.courseId ?? null, ordinal } };
}

test("study names stay stable across normal and incremental publication and still honor study ownership", async t => {
  const { db, close } = await ownerInstallFixture();
  t.after(close);
  await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

  const role = (name: string): SqlExecutor => ({
    query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`);
      return tx.query<T>(sql, values);
    }),
  });
  const reader = role("nb_reader"), writer = role("nb_writer");
  const sources = [
    { key: "courses", kind: "course", mode: "all", dataSourceId: "example-study-source", databaseParentId: null, pageId: null },
    { key: "notes", kind: "study-note", mode: "course-descendants", dataSourceId: "example-study-source", databaseParentId: null, pageId: null },
  ];
  const digest = configDigest(sources);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const first = course(1, "EX101", "Example Methods");
  const other = course(2, "EX102", "Example Practice");
  const withoutCode = course(3, null, "Course Without Code");
  const duplicateCode = course(4, "EX101", "A Different Course");
  const week = note(5, first, "Week 1 Why Methods?");
  const secondWeek = note(6, first, "Week 2");
  const workshop = note(7, first, "Workshop", week);
  const secondWorkshop = note(8, first, "Workshop", secondWeek);
  const duplicate = note(9, first, "Workshop", week);
  const leaf = note(10, first, "练习", workshop);
  const weekElsewhere = note(11, other, "Week 1 Intro");
  const laterRestored = note(12, other, "Restored page");
  const media = new URL("https://example.test/temporary");
  media.searchParams.set("signature", "fictional-test-value");
  const guide = note(13, first, `EX101 Coding Guideline ${media}`);
  const assessment = { ...note(14, first, "Assessment 1 - 15%"), noteType: "assignment" } as const;
  const items = [first, other, withoutCode, duplicateCode, week, secondWeek, workshop, secondWorkshop, duplicate,
    leaf, weekElsewhere, laterRestored, guide, assessment];
  const records = items.map(row);
  records[0].detail.document!.blocks.push({ id: "course-links", type: "paragraph", text: [
    { text: "Week", link: { kind: "internal", href: week.href } },
    { text: "Nested", link: { kind: "external", url: `https://www.example.test${leaf.href}?from=course#section` } },
    { text: "Other site", link: { kind: "external", url: `https://elsewhere.example${week.href}` } },
  ] });
  const full = publicationWriter(writer, "published");
  const lease = await full.begin(randomUUID(), digest);
  await full.stage(lease, records);
  await full.promote(lease, { records: records.length, media: 0, complete: true });
  await db.query("SELECT nb_v2_api.set_denied($1,true)", [laterRestored.id]);
  const migration = await readFile(new URL("../database/study-url-migrations/001_study_urls.sql", import.meta.url), "utf8");
  await db.transaction(tx => tx.exec(migration));
  for (const name of ["anon", "authenticated", "service_role", "nb_writer"]) {
    await assert.rejects(role(name).query("SELECT nb_study_urls_api.read_names('published', ARRAY['/study/ex101'], false)"), /permission denied/);
  }
  await assert.rejects(reader.query("SELECT * FROM nb_study_urls.names"), /permission denied/);
  const naming = createStudyUrlProjection(reader, "published", "https://example.test");
  const base = createWebsiteDatabaseRepository(publicationReader(reader, "published"));
  const repository = createContentService({ provider: "database", features, databaseRepository: naming.repository(base) }).repository;
  const expected = new Map<StudyNote, string>([
    [week, "week-01"], [secondWeek, "week-02"], [workshop, "week-01-workshop"],
    [secondWorkshop, "week-02-workshop"], [duplicate, "week-01-workshop-2"], [leaf, "week-01-workshop-练习"],
    [weekElsewhere, "week-01"], [guide, "coding-guideline"], [assessment, "assessment-1"],
  ]);
  for (const [item, slug] of expected) {
    const code = item.courseId === first.id ? "ex101" : "ex102";
    const href = `/study/${code}/notes/${encodeURIComponent(slug)}`;
    assert.equal(await qualifyRoute(href, features, repository), true);
    assert.deepEqual(routeAnswer(await routeVerdict(item.href, features, repository)), { status: 404, standIn: "/content-not-found" });
    assert.equal(await repository.isStudyNoteAvailable!(code, item.slug), false);
    const detail = (await repository.readStudyNote!(code, encodeURIComponent(slug)))?.note?.item;
    assert.equal(detail?.id, item.id);
    assert.equal(detail?.href, href);
    assert.equal(detail?.slug, item.id);
  }
  for (const [item, slug] of [[first, "ex101"], [other, "ex102"], [withoutCode, "course-without-code"], [duplicateCode, "ex101-2"]] as const) {
    assert.equal((await repository.get("course", slug))?.item.id, item.id);
    assert.equal((await repository.getCourseMetadata!(slug))?.slug, slug);
    assert.equal(await qualifyRoute(`/study/${slug}`, features, repository), true);
    assert.deepEqual(routeAnswer(await routeVerdict(item.href, features, repository)), { status: 404, standIn: "/content-not-found" });
  }
  assert.equal(await repository.isStudyNoteAvailable!("ex102", "week-01-workshop"), false);
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "%2Fweek-01"), false);
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "%252f"), false);
  assert.equal(await repository.isStudyNoteAvailable!("ex102", "restored-page"), false);
  const directory = await repository.getCourseTree("ex101", week.id);
  assert.deepEqual(directory?.nodes.map(node => node.href).sort(),
    ["/study/ex101/notes/week-01-workshop", "/study/ex101/notes/week-01-workshop-2"]);
  assert.deepEqual((await repository.readStudyNote!("ex101", "week-01-workshop"))?.note?.item.breadcrumbs.map(link => link.href),
    ["/study/ex101", "/study/ex101/notes/week-01"]);
  const links = (await repository.get("course", "ex101"))?.document?.blocks[0];
  assert(links?.type === "paragraph");
  assert.deepEqual(links.text.map(run => run.link), [
    { kind: "internal", href: "/study/ex101/notes/week-01" },
    { kind: "internal", href: `/study/ex101/notes/${encodeURIComponent("week-01-workshop-练习")}?from=course#section` },
    { kind: "external", url: `https://elsewhere.example${week.href}` },
  ]);
  assert.deepEqual((await repository.search!({ q: "Workshop", kinds: ["study-note"] })).items.map(item => item.href).sort(), [
    "/study/ex101/notes/week-01-workshop", "/study/ex101/notes/week-01-workshop-2", "/study/ex101/notes/week-02-workshop",
  ]);
  const xml = await sitemapXml(repository, features, { enabled: true, origin: "https://example.test", kinds: ["course", "study-note"] });
  assert.ok(xml.includes("/study/ex101/notes/week-01-workshop-2"));
  assert.ok(!xml.includes(workshop.href));

  await db.query("SELECT nb_v2_api.set_denied($1,false)", [laterRestored.id]);
  assert.equal(await repository.isStudyNoteAvailable!("ex102", "restored-page"), true);
  const renamed = { ...week, title: "First Module" };
  const fresh = note(15, first, "New Exercise");
  const publisher = createIncrementalPublisher(writer);
  await publisher.publish(randomUUID(), preparePublicationDelta({
    expectedRevision: (await publisher.state()).publicationRevision, configDigest: digest,
    upserts: [row(renamed, 4), row(fresh, items.length)], withdrawals: [], media: [],
  }));
  assert.equal((await repository.readStudyNote!("ex101", "week-01"))?.note?.item.title, "First Module");
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "first-module"), false);
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "new-exercise"), true);

  await db.query("SELECT nb_v2_api.set_denied($1,true)", [week.id]);
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "week-01-workshop"), false);
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "week-02-workshop"), true);
  assert.equal((await repository.search!({ q: "Workshop", kinds: ["study-note"] })).items.length, 1);
  await db.query("SELECT nb_v2_api.set_denied($1,false)", [week.id]);
  assert.equal(await repository.isStudyNoteAvailable!("ex101", "week-01-workshop"), true);
});
