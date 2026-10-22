import assert from "node:assert/strict";
import test from "node:test";
import type { BlockObjectResponse, DataSourceObjectResponse, PageObjectResponse, RichTextItemResponse } from "@notionhq/client";
import { ContentServiceError } from "../contracts/repository.ts";
import { createNotionRepository } from "../src/server/notion/repository.ts";
import type { NotionReadClient, NotionSource, NotionSourcesConfig, ReleaseContentKind } from "../src/server/notion/types.ts";

/** Synthetic identifiers are generated here; fixtures never depend on private sources. */
const id = (value: number) => value.toString(16).padStart(32, "0");
const ids = {
  statuses: id(1), courses: id(2), notes: id(3), foreignNotes: id(4), extraStatuses: id(5),
  course: id(10), week: id(11), child: id(12), private: id(13), unrelated: id(14),
  foreignCourse: id(20), foreignNote: id(21),
  old: id(30), newest: id(31), undated: id(32), sameDate: id(33), middle: id(34),
};
const editTime = "2026-10-01T00:00:00.000Z";
function richText(value: string): RichTextItemResponse {
  return {
    type: "text", plain_text: value, href: null, text: { content: value, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  };
}
function titleProperty(value: string): PageObjectResponse["properties"][string] {
  return { id: "title", type: "title", title: [richText(value)] };
}
const parentSource = (sourceId: string): PageObjectResponse["parent"] => ({ type: "data_source_id", data_source_id: sourceId, database_id: id(100) });
function page(pageId: string, title: string, parent: PageObjectResponse["parent"], properties: PageObjectResponse["properties"] = {}): PageObjectResponse {
  return {
    object: "page", id: pageId, parent, properties: { Name: titleProperty(title), ...properties },
    created_time: editTime, last_edited_time: editTime,
    in_trash: false, archived: false, is_archived: false, is_locked: false,
    url: "https://example.test/source-page", public_url: null, cover: null, icon: null,
    created_by: { object: "user", id: id(900) }, last_edited_by: { object: "user", id: id(900) },
  };
}
function paragraph(pageId: string, value: string): BlockObjectResponse {
  return {
    object: "block", id: id(Number.parseInt(pageId, 16) + 1000), parent: { type: "page_id", page_id: pageId },
    type: "paragraph", paragraph: { rich_text: [richText(value)], color: "default", icon: null },
    has_children: false, archived: false, in_trash: false, created_time: editTime, last_edited_time: editTime,
    created_by: { object: "user", id: id(900) }, last_edited_by: { object: "user", id: id(900) },
  };
}
function source(kind: ReleaseContentKind, dataSourceId: string, pages: string[], overrides: Partial<NotionSource> = {}): NotionSource {
  return {
    key: `${kind}-${dataSourceId}`, kind, dataSourceId, enabled: true,
    coursePageId: kind === "study-note" ? ids.course : null,
    fields: { title: "Name", ...(kind === "status" ? { recordedAt: "Recorded", tags: "Tags" } : {}) },
    cover: { strategy: "none" }, publication: { mode: "allowlist", allowlistPageIds: pages }, ...overrides,
  };
}
function schema(sourceId: string, databaseParent: DataSourceObjectResponse["database_parent"] = { type: "workspace", workspace: true }): DataSourceObjectResponse {
  return {
    object: "data_source", id: sourceId, title: [], description: [],
    parent: { type: "database_id", database_id: id(100) }, database_parent: databaseParent,
    is_inline: false, database_type: null, in_trash: false, archived: false,
    created_time: editTime, last_edited_time: editTime,
    created_by: { object: "user", id: id(900) }, last_edited_by: { object: "user", id: id(900) },
    icon: null, cover: null, url: "https://example.test/source", public_url: null,
    properties: {
      Name: { id: "title", name: "Name", description: null, type: "title", title: {} },
      Recorded: { id: "recorded", name: "Recorded", description: null, type: "date", date: {} },
      Tags: { id: "tags", name: "Tags", description: null, type: "multi_select", multi_select: { options: [] } },
    },
  };
}
function setup(sources: NotionSource[]) {
  const config: NotionSourcesConfig = { schemaVersion: 1, sources };
  const pages = new Map<string, PageObjectResponse>();
  const schemas = new Map<string, DataSourceObjectResponse>();
  const bodies = new Map<string, BlockObjectResponse[]>();
  const reads = { pages: [] as string[], schemas: [] as string[], bodies: [] as string[], blocks: [] as string[] };
  for (const configured of sources) schemas.set(configured.dataSourceId, schema(configured.dataSourceId,
    configured.kind === "study-note" ? { type: "page_id", page_id: configured.coursePageId! } : undefined));
  const client: NotionReadClient = {
    async getPage(pageId) { reads.pages.push(pageId); return structuredClone(pages.get(pageId) ?? null); },
    async getDataSource(sourceId) {
      reads.schemas.push(sourceId);
      const result = schemas.get(sourceId);
      assert.ok(result, "unexpected source read");
      return structuredClone(result);
    },
    async getBlock(blockId) { reads.blocks.push(blockId); return null; },
    async listBlocks(pageId) { reads.bodies.push(pageId); return structuredClone(bodies.get(pageId) ?? []); },
  };
  return { config, pages, schemas, bodies, reads, client, repository: createNotionRepository({ client, config }) };
}
function learning() {
  const scenario = setup([
    source("course", ids.courses, [ids.course, ids.foreignCourse]),
    source("study-note", ids.notes, [ids.week, ids.child]),
    source("study-note", ids.foreignNotes, [ids.foreignNote], { coursePageId: ids.foreignCourse }),
  ]);
  scenario.pages.set(ids.course, page(ids.course, "DEMO101 Foundations", parentSource(ids.courses)));
  scenario.pages.set(ids.foreignCourse, page(ids.foreignCourse, "DEMO102 Another course", parentSource(ids.courses)));
  scenario.pages.set(ids.week, page(ids.week, "Week 1", parentSource(ids.notes)));
  scenario.pages.set(ids.child, page(ids.child, "Activity", { type: "page_id", page_id: ids.week }));
  scenario.pages.set(ids.foreignNote, page(ids.foreignNote, "Other course week", parentSource(ids.foreignNotes)));
  scenario.bodies.set(ids.child, [paragraph(ids.child, "Public note body")]);
  return scenario;
}
function statuses() {
  const scenario = setup([
    source("status", ids.statuses, [ids.old, ids.newest, ids.undated, ids.sameDate, ids.old]),
    source("status", ids.extraStatuses, [ids.middle]),
  ]);
  const entries: [string, string, string | null, string][] = [
    [ids.old, "A", "2026-10-01", ids.statuses],
    [ids.newest, "B", "2026-10-03", ids.statuses],
    [ids.undated, "C", null, ids.statuses],
    [ids.sameDate, "D", "2026-10-03", ids.statuses],
    [ids.middle, "E", "2026-10-02", ids.extraStatuses],
  ];
  for (const [pageId, title, date, dataSourceId] of entries) {
    scenario.pages.set(pageId, page(pageId, title, parentSource(dataSourceId), {
      Recorded: { id: "recorded", type: "date", date: date ? { start: date, end: null, time_zone: null } : null },
      Tags: { id: "tags", type: "multi_select", multi_select: [{ id: "tag", name: pageId === ids.old ? "old" : "current", color: "default" }] },
    }));
    scenario.bodies.set(pageId, [paragraph(pageId, `Body ${title}`)]);
  }
  return scenario;
}
const serviceError = (code: string) => (error: unknown) => error instanceof ContentServiceError && error.code === code;

test("whole-source Status media qualification reads only its fresh exact page and schema", async () => {
  const scenario = statuses();
  scenario.config.sources = [scenario.config.sources[0]];
  scenario.config.sources[0].publication = { mode: "all", allowlistPageIds: [] };
  scenario.client.listPages = async () => { assert.fail("A single media owner must not enumerate Status"); };
  assert.equal((await scenario.repository.resolveMediaOwner!(ids.old))?.page.id, ids.old);
  assert.deepEqual(scenario.reads.pages, [ids.old]);
  assert.deepEqual(scenario.reads.schemas, [ids.statuses]);
  assert.deepEqual(scenario.reads.bodies, []);
  assert.deepEqual(scenario.reads.blocks, []);
  // A later request uses a new session, so the earlier permission cannot persist.
  scenario.pages.get(ids.old)!.archived = true;
  assert.equal(await scenario.repository.resolveMediaOwner!(ids.old), null);
  assert.deepEqual(scenario.reads.pages, [ids.old, ids.old]);
});

test("whole-source Status media qualifies only its direct source without reading unrelated schemas", async () => {
  const scenario = statuses();
  scenario.config.sources.forEach(source => { source.publication = { mode: "all", allowlistPageIds: [] }; });
  scenario.schemas.delete(ids.statuses);
  scenario.client.listPages = async () => { assert.fail("A single media owner must not enumerate Status"); };
  assert.equal((await scenario.repository.resolveMediaOwner!(ids.middle))?.page.id, ids.middle);
  assert.deepEqual(scenario.reads.pages, [ids.middle]);
  assert.deepEqual(scenario.reads.schemas, [ids.extraStatuses]);
});

test("media-only whole-source optimization leaves generic qualification and listing queries unchanged", async () => {
  const scenario = statuses();
  scenario.config.sources = [scenario.config.sources[0]];
  scenario.config.sources[0].publication = { mode: "all", allowlistPageIds: [] };
  let queries = 0;
  scenario.client.listPages = async sourceId => {
    queries++;
    assert.equal(sourceId, ids.statuses);
    return [...scenario.pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === sourceId);
  };
  assert.ok(await scenario.repository.resolveMediaOwner!(ids.old));
  assert.equal(queries, 0);
  assert.ok(await scenario.repository.resolvePublicPage(ids.old));
  assert.equal(queries, 1);
  assert.equal((await scenario.repository.list("status")).items.length, 4);
  assert.equal(queries, 2);
});

test("direct Status media owners reject foreign sources, moved pages and inactive or mismatched identities", async () => {
  const replacements: (PageObjectResponse | null)[] = [
    null,
    page(ids.private, "Wrong returned identity", parentSource(ids.statuses)),
    page(ids.old, "Foreign source", parentSource(ids.unrelated)),
    page(ids.old, "Moved subpage", { type: "page_id", page_id: ids.newest }),
    { ...page(ids.old, "Archived", parentSource(ids.statuses)), archived: true },
    { ...page(ids.old, "Deleted", parentSource(ids.statuses)), in_trash: true },
    { ...page(ids.old, "Inactive", parentSource(ids.statuses)), is_archived: true },
  ];
  for (const replacement of replacements) {
    const scenario = statuses();
    scenario.config.sources = [scenario.config.sources[0]];
    scenario.config.sources[0].publication = { mode: "all", allowlistPageIds: [] };
    if (replacement) scenario.pages.set(ids.old, replacement);
    else scenario.pages.delete(ids.old);
    scenario.client.listPages = async () => { assert.fail("Media checks must not enumerate rows"); };
    assert.equal(await scenario.repository.resolveMediaOwner!(ids.old), null);
  }
});

test("direct Status media qualification still requires an enabled source and its valid current schema", async () => {
  const scenario = statuses();
  scenario.config.sources = [scenario.config.sources[0]];
  scenario.config.sources[0].publication = { mode: "all", allowlistPageIds: [] };
  scenario.client.listPages = async () => { assert.fail("Media checks must not enumerate rows"); };
  scenario.config.sources[0].enabled = false;
  assert.equal(await scenario.repository.resolveMediaOwner!(ids.old), null);
  assert.deepEqual(scenario.reads.pages, []);
  scenario.config.sources[0].enabled = true;
  for (const broken of [{ ...schema(ids.statuses), id: ids.unrelated }, { ...schema(ids.statuses), archived: true },
    { ...schema(ids.statuses), in_trash: true }, { ...schema(ids.statuses), properties: {} }]) {
    scenario.schemas.set(ids.statuses, broken);
    await assert.rejects(scenario.repository.resolveMediaOwner!(ids.old), serviceError("MISCONFIGURED"));
  }
  scenario.client.getDataSource = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Fictional source access failure"); };
  await assert.rejects(scenario.repository.resolveMediaOwner!(ids.old), serviceError("CONTENT_UNAVAILABLE"));
});

test("allowlisted media owners remain restricted for Status and every learning ancestor", async () => {
  const status = statuses();
  assert.equal(await status.repository.resolveMediaOwner!(ids.private), null);
  assert.deepEqual(status.reads.pages, []);
  assert.ok(await status.repository.resolveMediaOwner!(ids.old));
  status.config.sources[0].publication.allowlistPageIds = [];
  assert.equal(await status.repository.resolveMediaOwner!(ids.old), null);
  const notes = learning();
  notes.client.listPages = async () => { assert.fail("A media owner must not widen the learning allowlist"); };
  assert.equal((await notes.repository.resolveMediaOwner!(ids.child))?.page.id, ids.child);
  notes.config.sources[1].publication.allowlistPageIds = [ids.child];
  assert.equal(await notes.repository.resolveMediaOwner!(ids.child), null);
  notes.config.sources[1].publication.allowlistPageIds = [ids.week, ids.child];
  notes.config.sources[0].publication.allowlistPageIds = [ids.foreignCourse];
  assert.equal(await notes.repository.resolveMediaOwner!(ids.child), null);
});

test("Notion Status years load only qualified metadata; year paging and previews keep legacy worker detail", async () => {
  const scenario=statuses();
  const date=scenario.pages.get(ids.newest)!.properties.Recorded;
  assert.equal(date.type,"date");
  if(date.type==="date") date.date={start:"2025-12-31T14:30:00Z",end:null,time_zone:null};
  const repository=createNotionRepository({client:scenario.client,config:scenario.config,timeZone:"Australia/Melbourne"});
  assert.deepEqual(await repository.getStatusYears!(),{years:[{year:2026,count:4}],undatedCount:1,timeZone:"Australia/Melbourne"});
  assert.deepEqual(scenario.reads.bodies,[]);
  const first=await repository.list("status",{year:2026,limit:1});
  assert.equal(first.items[0].hasMoreBody,false);
  assert.deepEqual(first.items[0].images,[]);
  assert.equal(scenario.reads.bodies.length,1);
  await assert.rejects(repository.list("status",{year:2025,limit:1,cursor:first.nextCursor!}),serviceError("INVALID_QUERY"));
  assert.equal((await repository.list("status",{year:"undated"})).items[0].id,ids.undated);
  const detail=await repository.get("status",ids.newest);
  assert.ok(!Object.hasOwn(detail!.item,"images"));
  scenario.pages.get(ids.old)!.in_trash=true;
  assert.equal((await repository.getStatusYears!()).years[0].count,3);
});

test("unlisted identities and disabled kinds are rejected before reading pages, source schemas or bodies", async () => {
  const scenario = statuses();
  assert.equal(await scenario.repository.resolvePublicPage(ids.private), null);
  assert.equal(await scenario.repository.get("status", ids.private), null);
  assert.equal(await scenario.repository.get("study-note", ids.old), null);
  assert.equal(await scenario.repository.get("book", ids.old), null);
  assert.deepEqual(await scenario.repository.list("book"), { items: [], nextCursor: null, hasMore: false });
  assert.deepEqual(scenario.reads, { pages: [], schemas: [], bodies: [], blocks: [] });
});

test("an allowlisted page from a different source cannot enter lists, details or public link resolution", async () => {
  const scenario = statuses();
  scenario.pages.get(ids.old)!.parent = parentSource(ids.unrelated);
  assert.equal(await scenario.repository.resolvePublicPage(ids.old), null);
  assert.equal(await scenario.repository.get("status", ids.old), null);
  assert.ok(!(await scenario.repository.list("status")).items.some((entry) => entry.id === ids.old));
  assert.ok(!scenario.reads.bodies.includes(ids.old));
});

test("approved course, week and child preserve the tree, parent identity and breadcrumbs", async () => {
  const scenario = learning();
  const detail = await scenario.repository.get("study-note", ids.child);
  assert.equal(detail?.item.title, "Activity");
  assert.equal(detail?.item.courseId, ids.course);
  assert.equal(detail?.item.parentId, ids.week);
  assert.deepEqual(detail?.item.breadcrumbs, [
    { title: "学习", href: "/study" },
    { title: "DEMO101 Foundations", href: `/study/${ids.course}` },
    { title: "Week 1", href: `/study/${ids.course}/notes/${ids.week}` },
  ]);
  assert.equal(detail?.document?.blocks[0]?.type, "paragraph");
  const tree = await scenario.repository.getCourseTree(ids.course);
  assert.equal(tree?.nodes[0]?.id, ids.week);
  assert.equal(tree?.nodes[0]?.hasChildren, true);
  assert.equal(tree?.nodes[0]?.children?.[0]?.id, ids.child);
  assert.equal((await scenario.repository.getCourseTree(ids.course, ids.week))?.nodes[0]?.id, ids.child);
});

test("selecting a child never publishes an unlisted ancestor or its child subtree", async () => {
  const scenario = learning();
  scenario.config.sources[1]!.publication.allowlistPageIds = [ids.child];
  assert.equal(await scenario.repository.get("study-note", ids.child), null);
  assert.equal(await scenario.repository.resolvePublicPage(ids.week), null);
  assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes, []);
  assert.ok(!scenario.reads.pages.includes(ids.week));
  assert.ok(!scenario.reads.bodies.includes(ids.child));
});

test("an unlisted course prevents selected notes from exposing their page or tree", async () => {
  const scenario = learning();
  scenario.config.sources[0]!.publication.allowlistPageIds = [ids.foreignCourse];
  assert.equal(await scenario.repository.get("study-note", ids.child), null);
  assert.equal(await scenario.repository.getCourseTree(ids.course), null);
  assert.ok(!scenario.reads.pages.includes(ids.course));
});

test("foreign course ancestors and parent subtree requests fail publication checks", async () => {
  const scenario = learning();
  scenario.pages.get(ids.child)!.parent = { type: "page_id", page_id: ids.foreignNote };
  assert.equal(await scenario.repository.get("study-note", ids.child), null);
  assert.equal(await scenario.repository.getCourseTree(ids.course, ids.foreignNote), null);
  assert.equal(await scenario.repository.getCourseTree(ids.foreignCourse, ids.week), null);
  assert.ok(!scenario.reads.bodies.includes(ids.child));
});

test("cyclic note parents fail closed without exposing a partial public tree", async () => {
  const scenario = learning();
  scenario.pages.get(ids.week)!.parent = { type: "page_id", page_id: ids.child };
  assert.equal(await scenario.repository.get("study-note", ids.child), null);
  assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes, []);
});

test("ordinary child-page intrinsic title is available without inheriting database field names", async () => {
  const scenario = learning();
  const child = scenario.pages.get(ids.child)!;
  child.properties = { title: titleProperty("Intrinsic child title") };
  const detail = await scenario.repository.get("study-note", ids.child);
  assert.equal(detail?.item.title, "Intrinsic child title");
  assert.equal((await scenario.repository.getCourseTree(ids.course))?.nodes[0]?.children?.[0]?.title, "Intrinsic child title");
});

test("allowlist revocation is effective on the next operation of the same repository", async () => {
  const scenario = statuses();
  assert.ok(await scenario.repository.get("status", ids.old));
  const previousPageReads = scenario.reads.pages.length;
  scenario.config.sources[0]!.publication.allowlistPageIds = scenario.config.sources[0]!.publication.allowlistPageIds.filter((pageId) => pageId !== ids.old);
  assert.equal(await scenario.repository.get("status", ids.old), null);
  assert.equal(scenario.reads.pages.length, previousPageReads);
  assert.ok(!(await scenario.repository.list("status")).items.some((entry) => entry.id === ids.old));
});

test("revoking a previously public ancestor removes descendants from details and the course tree", async () => {
  const scenario = learning();
  assert.equal((await scenario.repository.get("study-note", ids.child))?.item.parentId, ids.week);
  scenario.config.sources[1]!.publication.allowlistPageIds = [ids.child];
  assert.equal(await scenario.repository.get("study-note", ids.child), null);
  assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes, []);
  assert.equal(scenario.reads.bodies.filter((pageId) => pageId === ids.child).length, 1);
});

test("archive, trash and deletion are rechecked on the next operation without public qualification caching", async () => {
  for (const flag of ["archived", "is_archived", "in_trash", "deleted"] as const) {
    const scenario = statuses();
    assert.ok(await scenario.repository.get("status", ids.old));
    if (flag === "deleted") scenario.pages.delete(ids.old);
    else scenario.pages.get(ids.old)![flag] = true;
    assert.equal(await scenario.repository.get("status", ids.old), null, flag);
    assert.ok(!(await scenario.repository.list("status")).items.some((entry) => entry.id === ids.old), flag);
    assert.equal(scenario.reads.bodies.filter((pageId) => pageId === ids.old).length, 1, flag);
  }
});

test("schema missing or wrong property types returns a sanitized MISCONFIGURED error", async () => {
  for (const modification of ["missing", "wrong-type"] as const) {
    const scenario = statuses();
    const sourceSchema = scenario.schemas.get(ids.statuses)!;
    if (modification === "missing") delete sourceSchema.properties.Name;
    else sourceSchema.properties.Recorded = { id: "recorded", name: "Recorded", description: "private-schema-description", type: "rich_text", rich_text: {} };
    await assert.rejects(scenario.repository.list("status"), (error: unknown) => {
      assert.ok(serviceError("MISCONFIGURED")(error));
      assert.ok(!(error as Error).message.includes("private-schema-description"));
      assert.ok(!(error as Error).message.includes(ids.statuses));
      return true;
    });
    assert.deepEqual(scenario.reads.bodies, []);
  }
});

test("notes source must actually live below its configured course", async () => {
  for (const wrongParent of [{ type: "page_id", page_id: ids.foreignCourse }, { type: "workspace", workspace: true }] as const) {
    const scenario = learning();
    scenario.schemas.get(ids.notes)!.database_parent = wrongParent;
    await assert.rejects(scenario.repository.get("study-note", ids.week), serviceError("MISCONFIGURED"));
    assert.deepEqual(scenario.reads.bodies, []);
  }
});

test("global metadata ordering spans sources, keeps ties stable and places unknown dates last", async () => {
  const scenario = statuses();
  const collected: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await scenario.repository.list("status", { limit: 2, ...(cursor ? { cursor } : {}) });
    collected.push(...result.items.map((item) => item.id));
    cursor = result.nextCursor ?? undefined;
    assert.equal(result.hasMore, cursor !== undefined);
  } while (cursor);
  assert.deepEqual(collected, [ids.newest, ids.sameDate, ids.middle, ids.old, ids.undated]);
  assert.equal(new Set(collected).size, collected.length);
  const ascending = await scenario.repository.list("status", { order: "date-asc" });
  assert.deepEqual(ascending.items.map((item) => item.id), [ids.old, ids.middle, ids.newest, ids.sameDate, ids.undated]);
});

test("status pagination reads bodies only for the selected page of the globally sorted list", async () => {
  const scenario = statuses();
  const result = await scenario.repository.list("status", { limit: 2 });
  assert.deepEqual(result.items.map((item) => item.id), [ids.newest, ids.sameDate]);
  assert.deepEqual(scenario.reads.bodies, [ids.newest, ids.sameDate]);
  assert.deepEqual(new Set(scenario.reads.pages), new Set([ids.old, ids.newest, ids.undated, ids.sameDate, ids.middle]));
  assert.ok(result.items[0]!.text.some((run) => run.text === "Body B"));
});

test("cursor rejects changed filters, publication lists and edited metadata before reading selected bodies", async () => {
  for (const change of ["filter", "allowlist", "edit"] as const) {
    const scenario = statuses();
    const first = await scenario.repository.list("status", { limit: 2 });
    assert.ok(first.nextCursor);
    const bodyReads = scenario.reads.bodies.length;
    if (change === "allowlist") scenario.config.sources[0]!.publication.allowlistPageIds = [ids.old, ids.newest, ids.undated];
    if (change === "edit") scenario.pages.get(ids.old)!.last_edited_time = "2026-10-02T00:00:00.000Z";
    await assert.rejects(scenario.repository.list("status", { limit: 2, cursor: first.nextCursor, ...(change === "filter" ? { tag: "current" } : {}) }), serviceError("INVALID_QUERY"));
    assert.equal(scenario.reads.bodies.length, bodyReads);
  }
});

test("title ordering remains consistent with the title returned for untitled statuses", async () => {
  const scenario = statuses();
  scenario.config.sources = [source("status", ids.statuses, [ids.old, ids.newest])];
  scenario.pages.get(ids.old)!.properties.Name = titleProperty("");
  scenario.pages.get(ids.newest)!.properties.Name = titleProperty("");
  scenario.bodies.set(ids.old, [paragraph(ids.old, "Zulu")]);
  scenario.bodies.set(ids.newest, [paragraph(ids.newest, "Alpha")]);
  const result = await scenario.repository.list("status", { order: "title-asc" });
  const returnedTitles = result.items.map((entry) => entry.title);
  assert.deepEqual(returnedTitles, [...returnedTitles].sort((a, b) => a.localeCompare(b)));
});

test("public metadata cannot expose literal Notion locations for unlisted targets", async () => {
  const scenario = learning();
  const privateLocation = `https:${"//notion.so/"}${ids.private}`;
  scenario.pages.get(ids.course)!.properties.Name = titleProperty(`Course ${privateLocation}`);
  scenario.pages.get(ids.child)!.properties.Name = titleProperty(`Child ${privateLocation}`);
  scenario.config.sources[1]!.fields = { title: "Name", summary: "Summary" };
  scenario.schemas.get(ids.notes)!.properties.Summary = { id: "summary", name: "Summary", description: null, type: "rich_text", rich_text: {} };
  scenario.pages.get(ids.child)!.properties.Summary = { id: "summary", type: "rich_text", rich_text: [richText(`See ${privateLocation}`)] };
  const detail = await scenario.repository.get("study-note", ids.child);
  assert.ok(detail);
  const serialized = JSON.stringify(detail);
  assert.ok(!serialized.includes(privateLocation));
  assert.ok(!serialized.includes(ids.private));
  assert.ok(!scenario.reads.pages.includes(ids.private));
});

test("all Status source includes new entries on the next operation without reading foreign pages", async () => {
  const scenario = statuses();
  scenario.config.sources = [source("status", ids.statuses, [], { publication: { mode: "all", allowlistPageIds: [] } })];
  let queries = 0;
  scenario.client.listPages = async () => {
    queries++;
    return structuredClone([...scenario.pages.values()]);
  };
  const first = await scenario.repository.list("status", { limit: 1 });
  assert.equal(first.items[0]?.id, ids.newest);
  assert.equal(queries, 1);
  assert.deepEqual(scenario.reads.pages, []);
  assert.deepEqual(scenario.reads.bodies, [ids.newest]);
  assert.equal(await scenario.repository.get("status", ids.middle), null);
  assert.deepEqual(scenario.reads.pages, []);
  scenario.pages.set(ids.private, page(ids.private, "New status", parentSource(ids.statuses), {
    Recorded: { id: "recorded", type: "date", date: { start: "2026-10-04", end: null, time_zone: null } },
  }));
  scenario.bodies.set(ids.private, [paragraph(ids.private, "New body")]);
  assert.equal((await scenario.repository.list("status", { limit: 1 })).items[0]?.id, ids.private);
  await assert.rejects(scenario.repository.list("status", { limit: 1, cursor: first.nextCursor! }), serviceError("INVALID_QUERY"));
  scenario.pages.get(ids.private)!.archived = true;
  assert.equal(await scenario.repository.get("status", ids.private), null);
  scenario.config.sources[0]!.publication = { mode: "allowlist", allowlistPageIds: [] };
  assert.deepEqual((await scenario.repository.list("status")).items, []);
});

test("all Status mode fails explicitly when the query adapter is absent", async () => {
  const scenario = statuses();
  scenario.config.sources = [source("status", ids.statuses, [], { publication: { mode: "all", allowlistPageIds: [] } })];
  await assert.rejects(scenario.repository.list("status"), serviceError("MISCONFIGURED"));
});

test("approved learning links and media qualification do not query unrelated all Status sources", async () => {
  const scenario = learning();
  scenario.config.sources.unshift(source("status", ids.statuses, [], { publication: { mode: "all", allowlistPageIds: [] } }));
  scenario.client.listPages = async () => { throw new Error("Unrelated Status outage"); };
  assert.equal((await scenario.repository.resolvePublicPage(ids.child))?.source.kind, "study-note");
  assert.equal((await scenario.repository.get("study-note", ids.child))?.item.id, ids.child);
});

test("course metadata validates publication without reading the course body", async () => {
  const scenario = learning();
  assert.equal((await scenario.repository.getCourseMetadata(ids.course))?.id, ids.course);
  assert.deepEqual(scenario.reads.bodies, []);
  scenario.pages.get(ids.course)!.archived = true;
  assert.equal(await scenario.repository.getCourseMetadata(ids.course), null);
  scenario.config.sources[0]!.publication.allowlistPageIds = [];
  const reads = scenario.reads.pages.length;
  assert.equal(await scenario.repository.getCourseMetadata(ids.course), null);
  assert.equal(scenario.reads.pages.length, reads);
});

test("learning source metadata batches only selected direct rows and still resolves child ancestry", async () => {
  const scenario = learning();
  scenario.config.sources[1]!.publication.allowlistPageIds.push(ids.old);
  scenario.pages.set(ids.old, { ...page(ids.old, "Archived", parentSource(ids.notes)), archived: true });
  scenario.pages.set(ids.private, page(ids.private, "Unselected row", parentSource(ids.notes)));
  let queries = 0;
  scenario.client.listPages = async sourceId => {
    assert.equal(sourceId, ids.notes);
    queries++;
    return structuredClone([...scenario.pages.values()]);
  };
  const tree = await scenario.repository.getCourseTree(ids.course);
  assert.deepEqual(tree?.nodes.map(node => node.id), [ids.week]);
  assert.deepEqual(tree?.nodes[0]?.children?.map(node => node.id), [ids.child]);
  assert.equal(queries, 1);
  assert.ok(!scenario.reads.pages.includes(ids.week));
  assert.ok(scenario.reads.pages.includes(ids.child));
  assert.ok(!scenario.reads.pages.includes(ids.private));
  assert.ok(!scenario.reads.pages.includes(ids.foreignNote));
  assert.deepEqual(scenario.reads.bodies, []);
});

test("batched learning metadata rechecks revocation, deleted ancestors and source moves on each operation", async () => {
  for (const change of ["allowlist", "archived", "is_archived", "in_trash", "deleted", "moved"] as const) {
    const scenario = learning();
    scenario.config.sources[1]!.publication.allowlistPageIds.push(ids.unrelated);
    scenario.pages.set(ids.unrelated, page(ids.unrelated, "Deep note", { type: "page_id", page_id: ids.child }));
    let queries = 0;
    scenario.client.listPages = async () => { queries++; return structuredClone([...scenario.pages.values()]); };
    assert.equal((await scenario.repository.getCourseTree(ids.course))?.nodes[0]?.children?.[0]?.children?.[0]?.id, ids.unrelated);
    if (change === "allowlist") scenario.config.sources[1]!.publication.allowlistPageIds = [ids.child, ids.unrelated];
    else if (change === "deleted") scenario.pages.delete(ids.week);
    else if (change === "moved") scenario.pages.get(ids.week)!.parent = parentSource(ids.foreignNotes);
    else scenario.pages.get(ids.week)![change] = true;
    assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes, [], change);
    assert.equal(queries, 2, change);
    assert.deepEqual(scenario.reads.bodies, [], change);
  }
});

test("learning query failures and wrong source parents fail closed without reading note bodies", async () => {
  for (const change of ["query-failure", "wrong-parent"] as const) {
    const scenario = learning();
    let queries = 0;
    scenario.client.listPages = async () => { queries++; throw new ContentServiceError("RATE_LIMITED", "Busy."); };
    if (change === "wrong-parent") scenario.schemas.get(ids.notes)!.database_parent = { type: "page_id", page_id: ids.foreignCourse };
    await assert.rejects(scenario.repository.getCourseTree(ids.course), serviceError(change === "wrong-parent" ? "MISCONFIGURED" : "RATE_LIMITED"));
    assert.equal(queries, change === "wrong-parent" ? 0 : 1);
    assert.deepEqual(scenario.reads.pages, [ids.course]);
    assert.deepEqual(scenario.reads.bodies, []);
  }
});

test("empty or unapproved courses do not query learning metadata", async () => {
  const scenario = learning();
  scenario.client.listPages = async () => { throw new Error("Unexpected learning query"); };
  scenario.config.sources[1]!.publication.allowlistPageIds = [];
  assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes, []);
  scenario.config.sources[0]!.publication.allowlistPageIds = [];
  assert.equal(await scenario.repository.getCourseTree(ids.course), null);
});

test("shared parent blocks are read once per operation and rechecked for later requests", async () => {
  const scenario = learning();
  const blockId = id(500);
  const uuidBlockId = `${blockId.slice(0, 8)}-${blockId.slice(8, 12)}-${blockId.slice(12, 16)}-${blockId.slice(16, 20)}-${blockId.slice(20)}`;
  scenario.config.sources[1]!.publication.allowlistPageIds.push(ids.unrelated);
  scenario.pages.get(ids.child)!.parent = { type: "block_id", block_id: uuidBlockId };
  scenario.pages.set(ids.unrelated, page(ids.unrelated, "Second child", { type: "block_id", block_id: blockId }));
  const container = { ...paragraph(ids.week, "Container"), id: blockId };
  scenario.client.getBlock = async requested => { scenario.reads.blocks.push(requested); return structuredClone(container); };
  assert.equal((await scenario.repository.getCourseTree(ids.course))?.nodes[0]?.children?.length, 2);
  assert.deepEqual(scenario.reads.blocks, [blockId]);
  container.archived = true;
  assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes[0]?.children, []);
  assert.deepEqual(scenario.reads.blocks, [blockId, blockId]);
  container.archived = false;
  container.id = id(501);
  assert.deepEqual((await scenario.repository.getCourseTree(ids.course))?.nodes[0]?.children, []);
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("independent parent block checks overlap within the same read bound", async () => {
  const scenario = learning();
  const children = Array.from({ length: 6 }, (_, index) => id(700 + index));
  scenario.config.sources[1]!.publication.allowlistPageIds = [ids.week, ...children];
  children.forEach((pageId, index) => scenario.pages.set(pageId, page(pageId, String(index), { type: "block_id", block_id: id(800 + index) })));
  const pending: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  scenario.client.getBlock = async blockId => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => pending.push(resolve));
    active--;
    return { ...paragraph(ids.week, "Container"), id: blockId };
  };
  const result = scenario.repository.getCourseTree(ids.course);
  await tick();
  assert.equal(pending.length, 4);
  while (pending.length) { pending.pop()!(); await tick(); }
  assert.deepEqual((await result)?.nodes[0]?.children?.map(node => node.id), children);
  assert.equal(peak, 4);
  assert.equal(active, 0);
});

test("metadata reads overlap with a bound of four and retain deterministic list ordering", async () => {
  const scenario = statuses();
  const selected = Array.from({ length: 9 }, (_, index) => id(400 + index));
  scenario.config.sources = [source("status", ids.statuses, selected)];
  selected.forEach((pageId, index) => scenario.pages.set(pageId, page(pageId, String(index), parentSource(ids.statuses))));
  const original = scenario.client.getPage;
  const pending: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  scenario.client.getPage = async pageId => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => pending.push(resolve));
    active--;
    return original(pageId);
  };
  const result = scenario.repository.list("status", { order: "title-asc" });
  await tick();
  assert.equal(pending.length, 4);
  while (pending.length) { pending.pop()!(); await tick(); }
  assert.deepEqual((await result).items.map(item => item.id), selected);
  assert.equal(peak, 4);
  assert.equal(active, 0);
});

test("failed bounded reads drain started work, stop queuing new pages and retry in a fresh session", async () => {
  const scenario = statuses();
  const selected = Array.from({ length: 7 }, (_, index) => id(600 + index));
  scenario.config.sources = [source("status", ids.statuses, selected)];
  selected.forEach(pageId => scenario.pages.set(pageId, page(pageId, "Entry", parentSource(ids.statuses))));
  const original = scenario.client.getPage;
  const pending: { resolve(): void; reject(error: Error): void }[] = [];
  let started = 0;
  scenario.client.getPage = async pageId => {
    started++;
    await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
    return original(pageId);
  };
  let completed = false;
  const result = scenario.repository.list("status").catch(error => { completed = true; return error; });
  await tick();
  assert.equal(started, 4);
  pending.shift()!.reject(new ContentServiceError("RATE_LIMITED", "Busy."));
  await tick();
  assert.equal(completed, false);
  while (pending.length) { pending.shift()!.resolve(); await tick(); }
  assert.ok(serviceError("RATE_LIMITED")(await result));
  assert.equal(started, 4);
  scenario.client.getPage = original;
  assert.equal((await scenario.repository.list("status")).items.length, selected.length);
});

test("Notion Status list derives bounded rich text only after current visibility checks", async () => {
  const scenario = statuses();
  const block = paragraph(ids.newest, "x".repeat(450));
  if (block.type !== "paragraph") throw Error("Fixture invalid");
  block.paragraph.rich_text[0].annotations.bold = true;
  scenario.bodies.set(ids.newest, [block]);
  const first = (await scenario.repository.list("status", { limit: 1 })).items[0];
  const detail = (await scenario.repository.get("status", ids.newest))!;
  const source = detail.document!.blocks[0];
  assert.equal(source.type, "paragraph"); if (source.type !== "paragraph") throw Error("Fixture invalid");
  assert.deepEqual(first.previewBody, [{ ...source, text: [{ ...source.text[0], text: "x".repeat(400) }] }]);
  assert.equal(first.previewBodyTruncated, true);
  assert.ok(!Object.hasOwn((await scenario.repository.get("status", ids.newest))!.item, "previewBody"));
  scenario.pages.get(ids.newest)!.in_trash = true;
  assert.ok(!(await scenario.repository.list("status")).items.some(x => x.id === ids.newest));
});
