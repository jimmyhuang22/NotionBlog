import assert from "node:assert/strict";
import test from "node:test";
import type { DataSourceObjectResponse } from "@notionhq/client";
import { ContentServiceError } from "../contracts/repository.ts";
import { assertSourceSchema, normalizeId, parseNotionSourcesConfig } from "../src/server/notion/config.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222";
const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const invalid = (error: unknown) => error instanceof ContentServiceError && error.code === "MISCONFIGURED";
function source(overrides: Record<string, unknown> = {}) {
  return {
    key: "updates", kind: "status", enabled: true, dataSourceId: sourceId,
    fields: { title: "Name", recordedAt: "Recorded" },
    publication: { mode: "allowlist", allowlistPageIds: [pageId] },
    cover: { strategy: "none" }, ...overrides,
  };
}
function parse(sources: unknown[], overrides: Record<string, unknown> = {}) {
  return parseNotionSourcesConfig({ schemaVersion: 1, sources, ...overrides });
}
function schema(properties: DataSourceObjectResponse["properties"]): DataSourceObjectResponse {
  return {
    object: "data_source", id: sourceId, title: [], description: [], properties,
    parent: { type: "database_id", database_id: sourceId }, database_parent: { type: "workspace", workspace: true },
    is_inline: false, database_type: null, in_trash: false, archived: false,
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    created_by: { object: "user", id: courseId }, last_edited_by: { object: "user", id: courseId },
    icon: null, cover: null, url: "https://example.test/source", public_url: null,
  };
}
const name = { id: "title", name: "Name", description: null, type: "title", title: {} } as const;
const recorded = { id: "date%3Afield", name: "Recorded", description: null, type: "date", date: {} } as const;

test("Notion identity normalization accepts compact and UUID formats with one lowercase identity", () => {
  assert.equal(normalizeId(pageId.toUpperCase()), "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa");
  assert.equal(normalizeId("AAAAAAAAAAAA4AAA8AAAAAAAAAAAAAAA"), "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa");
  for (const value of ["", ` ${pageId}`, `${pageId} `, "https://example.test/a", "../private", "a".repeat(31), "g".repeat(32), "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa"]) {
    assert.throws(() => normalizeId(value), invalid);
  }
});

test("source parser canonicalizes allowlists, removes duplicates and ignores unrelated server metadata", () => {
  const config = parse([source({
    publishedProperty: null, inventoryLabel: "private-inventory-value", name: "private-name", notes: "private-notes",
    publication: { mode: "allowlist", allowlistPageIds: [pageId, pageId.replaceAll("-", "").toUpperCase()] },
  })]);
  assert.equal(config.sources[0]?.dataSourceId, normalizeId(sourceId));
  assert.deepEqual(config.sources[0]?.publication.allowlistPageIds, [normalizeId(pageId)]);
  assert.equal(config.sources[0]?.coursePageId, null);
  assert.ok(!JSON.stringify(config).includes("private-"));
});

test("source-wide publication is explicit and available only for Status", () => {
  for (const publication of [{ mode: "all" }, { mode: "all", allowlistPageIds: [] }]) {
    assert.deepEqual(parse([source({ publication })]).sources[0]?.publication, { mode: "all", allowlistPageIds: [] });
  }
  for (const publication of [
    { mode: "all", allowlistPageIds: [pageId] },
    { mode: "all", allowlistPageIds: "any" },
    { mode: "all", allowlistPageIds: null },
  ]) assert.throws(() => parse([source({ publication })]), invalid);
  for (const kind of ["course", "study-note"]) {
    const overrides = { kind, coursePageId: courseId, fields: { title: "Name" } };
    assert.throws(() => parse([source({ ...overrides, publication: { mode: "all", allowlistPageIds: [] } })]), invalid);
    assert.equal(parse([source(overrides)]).sources[0]?.publication.mode, "allowlist");
  }
});

test("disabled sources are ignored even when future kinds or source IDs are placeholders", () => {
  assert.deepEqual(parse([
    { enabled: false, kind: "book", dataSourceId: "placeholder" },
    { enabled: false, kind: "course" },
  ]), { schemaVersion: 1, sources: [] });
  assert.deepEqual(parse([]), { schemaVersion: 1, sources: [] });
});

test("enabled sources only accept the release kinds and require explicit publication mode", () => {
  for (const overrides of [
    { kind: "book" }, { kind: "other" }, { enabled: "yes" }, { enabled: undefined },
    { publication: { mode: "property", property: "Public" } },
    { publication: { mode: "allowlist", allowlistPageIds: ["untrusted-private-id"] } },
    { publication: { mode: "allowlist" } }, { fields: {} }, { fields: { title: "" } },
    { fields: { title: "Name", unsupportedMapping: "Unknown" } },
    { dataSourceId: "untrusted-private-id" }, { key: "\u0000invalid" },
    { cover: { strategy: "files-property" } }, { cover: { strategy: "unknown" } },
  ]) assert.throws(() => parse([source(overrides)]), invalid);
});

test("example-only config, malformed versions and non-object sources fail closed", () => {
  for (const input of [null, [], "config", {}, { schemaVersion: 2, sources: [] }, { schemaVersion: 1, sources: [null] }]) {
    assert.throws(() => parseNotionSourcesConfig(input), invalid);
  }
  assert.throws(() => parse([], { isExampleOnly: true }), invalid);
});

test("source keys and normalized data source IDs must be unique", () => {
  assert.throws(() => parse([source(), source({ key: "other", dataSourceId: sourceId.replaceAll("-", "").toUpperCase() })]), invalid);
  assert.throws(() => parse([source(), source({ dataSourceId: courseId })]), invalid);
});

test("study source requires an explicit course identity and retains private url mapping without publishing it", () => {
  const fields = { title: "Name", date: "Date", type: "Type", moodleUrl: "Moodle" };
  assert.throws(() => parse([source({ kind: "study-note", fields })]), invalid);
  const result = parse([source({ kind: "study-note", fields, coursePageId: courseId })]);
  assert.equal(result.sources[0]?.coursePageId, normalizeId(courseId));
  assert.equal(result.sources[0]?.fields.moodleUrl, "Moodle");
});

test("schema validation accepts configured names and encoded or decoded native property IDs", () => {
  const config = parse([source()]);
  const sourceSchema = schema({ Name: name, Recorded: recorded });
  assert.doesNotThrow(() => assertSourceSchema(config.sources[0]!, sourceSchema));
  const idConfig = parse([source({ fields: { title: "title", recordedAt: "date:field" } })]);
  assert.doesNotThrow(() => assertSourceSchema(idConfig.sources[0]!, sourceSchema));
  const renamed = schema({ Renamed: { ...name, name: "Renamed" }, RenamedDate: { ...recorded, name: "RenamedDate" } });
  assert.doesNotThrow(() => assertSourceSchema(idConfig.sources[0]!, renamed));
});

test("schema validation rejects missing fields, wrong types and non-files cover properties", () => {
  const configured = parse([source()]).sources[0]!;
  assert.throws(() => assertSourceSchema(configured, schema({ Name: name })), invalid);
  assert.throws(() => assertSourceSchema(configured, schema({ Name: name, Recorded: { ...recorded, type: "rich_text", rich_text: {} } })), invalid);
  const covers = parse([source({ cover: { strategy: "files-property", property: "Photo" } })]).sources[0]!;
  assert.throws(() => assertSourceSchema(covers, schema({ Name: name, Recorded: recorded, Photo: { ...name, name: "Photo" } })), invalid);
  assert.doesNotThrow(() => assertSourceSchema(covers, schema({ Name: name, Recorded: recorded, Photo: { id: "photo", name: "Photo", description: null, type: "files", files: {} } })));
});

test("date schema explicitly permits created_time and errors do not echo private mappings", () => {
  const configured = parse([source({ fields: { title: "private-title-field", recordedAt: "Recorded" } })]).sources[0]!;
  assert.throws(() => assertSourceSchema(configured, schema({ Name: name, Recorded: recorded })), (error: unknown) => {
    assert.ok(invalid(error));
    assert.ok(!(error as Error).message.includes("private-title-field"));
    return true;
  });
  const valid = parse([source()]).sources[0]!;
  assert.doesNotThrow(() => assertSourceSchema(valid, schema({ Name: name, Recorded: { id: "created", name: "Recorded", description: null, type: "created_time", created_time: {} } })));
});
