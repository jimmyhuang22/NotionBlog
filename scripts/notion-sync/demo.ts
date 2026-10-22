import type { BlockObjectResponse, DataSourceObjectResponse, PageObjectResponse, RichTextItemResponse } from "@notionhq/client";
import { createNotionClient } from "../../src/server/notion/client.ts";
import type { NotionSourcesConfig } from "../../src/server/notion/types.ts";

/** Entirely synthetic. This transport cannot make outbound requests. */
export const demoId = (n: number) => n.toString(16).padStart(32, "0");
export const DEMO = { statuses: demoId(1), courses: demoId(2), notes: demoId(3),
  course: demoId(10), week: demoId(11), child: demoId(12), grandchild: demoId(13), private: demoId(14) };
const time = "2026-10-01T00:00:00.000Z";
export const DEMO_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
export function demoText(value: string): RichTextItemResponse {
  return { type: "text", plain_text: value, href: null, text: { content: value, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } };
}
export function demoPage(id: string, title: string, parent: PageObjectResponse["parent"]): PageObjectResponse {
  return { object: "page", id, parent, properties: { Name: { id: "title", type: "title", title: [demoText(title)] } },
    created_time: time, last_edited_time: time, in_trash: false, archived: false, is_archived: false, is_locked: false,
    url: "https://example.test/page", public_url: null, cover: null, icon: null,
    created_by: { object: "user", id: demoId(999) }, last_edited_by: { object: "user", id: demoId(999) } };
}
function schema(id: string, course?: string): DataSourceObjectResponse {
  return { object: "data_source", id, title: [], description: [], parent: { type: "database_id", database_id: demoId(100) },
    database_parent: course ? { type: "page_id", page_id: course } : { type: "workspace", workspace: true },
    is_inline: false, database_type: null, in_trash: false, archived: false, created_time: time, last_edited_time: time,
    created_by: { object: "user", id: demoId(999) }, last_edited_by: { object: "user", id: demoId(999) },
    icon: null, cover: null, url: "https://example.test/source", public_url: null,
    properties: { Name: { id: "title", name: "Name", description: null, type: "title", title: {} } } };
}
export function demoParagraph(id: string, parent: string, text: string): BlockObjectResponse {
  return { object: "block", id, parent: { type: "page_id", page_id: parent }, type: "paragraph",
    paragraph: { rich_text: [demoText(text)], color: "default", icon: null }, has_children: false, archived: false,
    in_trash: false, created_time: time, last_edited_time: time,
    created_by: { object: "user", id: demoId(999) }, last_edited_by: { object: "user", id: demoId(999) } };
}
export function createDemo(statusCount = 125) {
  const config: NotionSourcesConfig = { schemaVersion: 1, sources: [
    { key: "status", kind: "status", dataSourceId: DEMO.statuses, enabled: true, coursePageId: null,
      fields: { title: "Name" }, cover: { strategy: "none" }, publication: { mode: "all", allowlistPageIds: [] } },
    { key: "course", kind: "course", dataSourceId: DEMO.courses, enabled: true, coursePageId: null,
      fields: { title: "Name" }, cover: { strategy: "none" }, publication: { mode: "allowlist", allowlistPageIds: [DEMO.course] } },
    { key: "notes", kind: "study-note", dataSourceId: DEMO.notes, enabled: true, coursePageId: DEMO.course,
      fields: { title: "Name" }, cover: { strategy: "none" }, publication: { mode: "allowlist", allowlistPageIds: [DEMO.week, DEMO.child, DEMO.grandchild] } },
  ] };
  const pages = new Map<string, PageObjectResponse>(), schemas = new Map<string, DataSourceObjectResponse>();
  const blocks = new Map<string, BlockObjectResponse[]>();
  const sourceParent = (dataSourceId: string): PageObjectResponse["parent"] => ({ type: "data_source_id", data_source_id: dataSourceId, database_id: demoId(100) });
  for (let n = 0; n < statusCount; n++) {
    const id = demoId(1000 + n); pages.set(id, demoPage(id, `Synthetic status ${n}`, sourceParent(DEMO.statuses)));
    blocks.set(id, [demoParagraph(demoId(10_000 + n), id, `Synthetic body ${n}`)]);
  }
  pages.set(DEMO.course, demoPage(DEMO.course, "Synthetic course", sourceParent(DEMO.courses)));
  pages.set(DEMO.week, demoPage(DEMO.week, "Week one", sourceParent(DEMO.notes)));
  pages.set(DEMO.child, demoPage(DEMO.child, "Activity", { type: "page_id", page_id: DEMO.week }));
  pages.set(DEMO.grandchild, demoPage(DEMO.grandchild, "Knowledge", { type: "page_id", page_id: DEMO.child }));
  pages.set(DEMO.private, demoPage(DEMO.private, "Unapproved", { type: "page_id", page_id: DEMO.week }));
  for (const id of [DEMO.course, DEMO.child, DEMO.grandchild, DEMO.private]) blocks.set(id, [demoParagraph(demoId(20_000 + Number.parseInt(id, 16)), id, "Synthetic learning body")]);
  blocks.set(DEMO.week, Array.from({ length: 110 }, (_, n) => demoParagraph(demoId(30_000 + n), DEMO.week, `Paragraph ${n}`)));
  const image = { ...demoParagraph(demoId(40_000), DEMO.grandchild, ""), type: "image", image: {
    type: "external", external: { url: "https://images.example.test/one.png" }, caption: [demoText("Synthetic image")] } } as BlockObjectResponse;
  blocks.get(DEMO.grandchild)!.push(image);
  for (const source of config.sources) schemas.set(source.dataSourceId, schema(source.dataSourceId, source.coursePageId ?? undefined));
  const requests: { method: string; category: string; id: string; cursor: string | null }[] = [];
  let fault: ((category: string, id: string, cursor: string | null) => Response | undefined) | undefined;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.notion.com") throw new Error("Offline transport only");
    const path = url.pathname.split("/").filter(Boolean), id = (path[2] ?? "").replaceAll("-", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const cursor = body.start_cursor ?? url.searchParams.get("start_cursor");
    const category = path[3] === "query" ? "rows" : path[3] === "children" ? "blocks" : path[1] === "blocks" ? "block" : path[1];
    requests.push({ method: init?.method ?? "GET", category, id, cursor });
    const failure = fault?.(category, id, cursor); if (failure) return failure;
    let value: unknown;
    if (category === "rows" || category === "blocks") {
      const all = category === "blocks" ? blocks.get(id) ?? [] : [...pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === id);
      const offset = cursor ? Number(String(cursor).replace("offset-", "")) : 0;
      const results = all.slice(offset, offset + 100), hasMore = offset + results.length < all.length;
      value = { object: "list", results, has_more: hasMore, next_cursor: hasMore ? `offset-${offset + results.length}` : null,
        type: category === "rows" ? "page_or_data_source" : "block", request_status: { type: "complete" } };
    } else if (category === "pages") value = pages.get(id);
    else if (category === "data_sources") value = schemas.get(id);
    else if (category === "block") value = [...blocks.values()].flat().find(block => block.id === id);
    if (!value) return Response.json({ object: "error", status: 404, code: "object_not_found", message: "Synthetic missing object" }, { status: 404 });
    return Response.json(value);
  };
  return { config, pages, schemas, blocks, requests, client: createNotionClient({ token: "offline-fixture", fetch: transport }),
    setFault: (next: typeof fault) => { fault = next; },
    download: async () => ({ bytes: Uint8Array.from(DEMO_PNG), mime: "image/png" as const }) };
}
