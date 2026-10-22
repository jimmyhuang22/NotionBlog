import type { DataSourceObjectResponse } from "@notionhq/client";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { NotionSource, NotionSourcesConfig, ReleaseContentKind } from "./types.ts";

const releaseKinds = new Set<ReleaseContentKind>(["status", "course", "study-note"]);
type PropertyType = DataSourceObjectResponse["properties"][string]["type"];
const commonFields: Record<string, readonly PropertyType[]> = {
  title: ["title"], tags: ["multi_select"], summary: ["rich_text"],
};
const fieldsByKind: Record<ReleaseContentKind, Record<string, readonly PropertyType[]>> = {
  status: { ...commonFields, recordedAt: ["date", "created_time"] },
  course: {
    ...commonFields,
    code: ["rich_text", "title"], semester: ["select", "multi_select", "rich_text"],
    experience: ["select", "rich_text", "number"], usefulness: ["select", "rich_text", "number"],
    recommendation: ["select", "rich_text", "number"], difficulty: ["select", "rich_text", "number"],
    experienceRating: ["select", "rich_text", "number"], usefulnessRating: ["select", "rich_text", "number"],
    recommendationRating: ["select", "rich_text", "number"], difficultyRating: ["select", "rich_text", "number"],
  },
  "study-note": {
    ...commonFields, date: ["date", "created_time"], type: ["select", "status", "rich_text"], moodleUrl: ["url"],
  },
};

function misconfigured(): never {
  throw new ContentServiceError("MISCONFIGURED", "The Notion source configuration is invalid.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) misconfigured();
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    misconfigured();
  }
  return value;
}

/** Notion's UUID and compact formats share one identity throughout authorization. */
export function normalizeId(value: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(value)) {
    misconfigured();
  }
  return value.replaceAll("-", "").toLowerCase();
}

/** Parse a private server configuration; disabled sources never require working IDs. */
export function parseNotionSourcesConfig(input: unknown): NotionSourcesConfig {
  const config = record(input);
  if (config.schemaVersion !== 1 || config.isExampleOnly === true || !Array.isArray(config.sources) || config.sources.length > 128) {
    misconfigured();
  }
  const sources: NotionSource[] = [];
  const keys = new Set<string>();
  const dataSources = new Set<string>();
  for (const inputSource of config.sources) {
    const source = record(inputSource);
    if (source.enabled === false) continue;
    if (source.enabled !== true || typeof source.kind !== "string" || !releaseKinds.has(source.kind as ReleaseContentKind)) {
      misconfigured();
    }
    const kind = source.kind as ReleaseContentKind;
    const key = nonemptyString(source.key, 128);
    const dataSourceId = normalizeId(nonemptyString(source.dataSourceId));
    if (keys.has(key) || dataSources.has(dataSourceId)) misconfigured();
    keys.add(key);
    dataSources.add(dataSourceId);
    const inputFields = record(source.fields);
    const fields: Record<string, string> = {};
    for (const [field, property] of Object.entries(inputFields)) {
      if (!Object.hasOwn(fieldsByKind[kind], field)) misconfigured();
      fields[field] = nonemptyString(property);
    }
    if (!fields.title) misconfigured();
    const publication = record(source.publication);
    const mode = publication.mode;
    if (mode !== "allowlist" && (mode !== "all" || kind !== "status")) misconfigured();
    const inputAllowlist = mode === "all" && publication.allowlistPageIds === undefined ? [] : publication.allowlistPageIds;
    if (!Array.isArray(inputAllowlist) || inputAllowlist.length > 10_000 || (mode === "all" && inputAllowlist.length !== 0)) {
      misconfigured();
    }
    const allowlistPageIds = [...new Set(inputAllowlist.map((id) => normalizeId(nonemptyString(id))))];
    const inputCover = record(source.cover ?? { strategy: "none" });
    let cover: NotionSource["cover"];
    switch (inputCover.strategy) {
      case "none": case "native-page-cover": cover = { strategy: inputCover.strategy }; break;
      case "files-property": cover = { strategy: "files-property", property: nonemptyString(inputCover.property) }; break;
      default: misconfigured();
    }
    const coursePageId = kind === "study-note" ? normalizeId(nonemptyString(source.coursePageId)) : null;
    sources.push({
      key, kind, dataSourceId, enabled: true, coursePageId, fields, cover,
      publication: { mode, allowlistPageIds },
    });
  }
  return { schemaVersion: 1, sources };
}

function decodedPropertyId(id: string): string {
  try { return decodeURIComponent(id); } catch { return id; }
}

/** Property IDs remain usable if the Notion property is renamed. */
export function assertSourceSchema(source: NotionSource, schema: DataSourceObjectResponse): void {
  const properties = schema.properties;
  const resolve = (field: string) => properties[field] ?? Object.values(properties).find((property) =>
    property.name === field || decodedPropertyId(property.id) === decodedPropertyId(field));
  for (const [field, mapping] of Object.entries(source.fields)) {
    const allowedTypes = fieldsByKind[source.kind][field];
    const property = resolve(mapping);
    if (!allowedTypes || !property || !allowedTypes.includes(property.type)) misconfigured();
  }
  if (source.cover.strategy === "files-property") {
    const property = source.cover.property && resolve(source.cover.property);
    if (!property || property.type !== "files") misconfigured();
  }
}
