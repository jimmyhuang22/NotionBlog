import type { BlockObjectResponse, DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { assertSourceSchema, normalizeId } from "../../src/server/notion/config.ts";
import { createNotionRepository, type PublicNotionPage } from "../../src/server/notion/repository.ts";
import type { NotionReadClient, NotionSource, NotionSourcesConfig } from "../../src/server/notion/types.ts";
import type { ConfirmedAbsence, SyncRecord } from "../../contracts/sync.ts";
import { WorkerError, checkSignal } from "./errors.ts";

export interface CollectionPlan {
  client: NotionReadClient;
  config: NotionSourcesConfig;
  ordered: PublicNotionPage[];
  databaseParents: Map<string, string | null>;
  absences: ConfirmedAbsence[];
  excluded: number;
  metadataReads: number;
}

/** A cache lives for ONE full reconcile. Bodies are read once and never cached between runs. */
export async function planCollection(raw: NotionReadClient, config: NotionSourcesConfig,
  deniedIds: string[], signal?: AbortSignal, maxRecords = 10_000): Promise<CollectionPlan> {
  if (!raw.listPages || config.sources.some(source => source.kind === "status" && source.publication.mode !== "all")) throw new WorkerError("MISCONFIGURED");
  const pages = new Map<string, PageObjectResponse | null>();
  const schemas = new Map<string, DataSourceObjectResponse>();
  const blocks = new Map<string, BlockObjectResponse | null>();
  const rows = new Map<string, PageObjectResponse[]>();
  const candidates = new Map<string, NotionSource>();
  const parents = new Map<string, string | null>();
  const databaseParents = new Map<string, string | null>();
  const absences = new Map<string, ConfirmedAbsence>();
  const excluded = new Set(deniedIds.map(normalizeId));
  let metadataReads = 0;
  const identity = <T extends { id: string }>(result: T, expected: string) => {
    if (normalizeId(result.id) !== expected) throw new WorkerError("SCOPE_INCOMPLETE");
    return result;
  };
  const getPage = async (id: string) => {
    checkSignal(signal); id = normalizeId(id);
    if (!pages.has(id)) { metadataReads++; pages.set(id, await raw.getPage(id)); }
    checkSignal(signal);
    const value = pages.get(id)!;
    return value ? identity(value, id) : null;
  };
  const getBlock = async (id: string) => {
    checkSignal(signal); id = normalizeId(id);
    if (!blocks.has(id)) { metadataReads++; blocks.set(id, await raw.getBlock(id)); }
    checkSignal(signal);
    const value = blocks.get(id)!;
    return value ? identity(value, id) : null;
  };
  const containingPage = async (parent: PageObjectResponse["parent"] | DataSourceObjectResponse["database_parent"]): Promise<string | null> => {
    if (parent.type === "page_id") return normalizeId(parent.page_id);
    if (parent.type !== "block_id") return null;
    let current = normalizeId(parent.block_id);
    const seen = new Set<string>();
    for (let depth = 0; depth < 24; depth++) {
      if (seen.has(current)) throw new WorkerError("SCOPE_INCOMPLETE");
      seen.add(current);
      const block = await getBlock(current);
      if (!block || block.archived || block.in_trash) throw new WorkerError("SCOPE_INCOMPLETE");
      if (block.parent.type === "page_id") return normalizeId(block.parent.page_id);
      if (block.parent.type !== "block_id") throw new WorkerError("SCOPE_INCOMPLETE");
      current = normalizeId(block.parent.block_id);
    }
    throw new WorkerError("LIMIT_EXCEEDED");
  };

  for (const source of config.sources) {
    checkSignal(signal); metadataReads++;
    const schema = identity(await raw.getDataSource(source.dataSourceId), source.dataSourceId);
    if (schema.archived || schema.in_trash) throw new WorkerError("SCOPE_INCOMPLETE");
    assertSourceSchema(source, schema);
    // Status/course qualify by exact data source and selected page. Their outer
    // containers need not be shared with the read-only integration. Only notes
    // require the source's containing course page as qualification evidence.
    const databaseParent = source.kind === "study-note" ? await containingPage(schema.database_parent) : null;
    if (source.kind === "study-note" && databaseParent !== source.coursePageId) throw new WorkerError("SCOPE_INCOMPLETE");
    schemas.set(source.dataSourceId, schema); databaseParents.set(source.key, databaseParent);
    // Transport owns all API cursors. Learning enumeration does not grant publication.
    metadataReads++;
    const sourceRows = await raw.listPages(source.dataSourceId);
    checkSignal(signal);
    const unique = new Map<string, PageObjectResponse>();
    for (const page of sourceRows) {
      const id = normalizeId(page.id);
      if (page.parent.type !== "data_source_id" || normalizeId(page.parent.data_source_id) !== source.dataSourceId) throw new WorkerError("SCOPE_INCOMPLETE");
      if (!page.archived && !page.in_trash && !page.is_archived) unique.set(id, page);
    }
    rows.set(source.dataSourceId, [...unique.values()]);
    const ids = source.publication.mode === "all" ? [...unique.keys()] : source.publication.allowlistPageIds;
    for (const id of ids) {
      if (candidates.has(id)) throw new WorkerError("MISCONFIGURED");
      candidates.set(id, source);
      if (source.publication.mode === "all") pages.set(id, unique.get(id)!);
    }
    if (candidates.size > maxRecords) throw new WorkerError("LIMIT_EXCEEDED");
  }

  for (const [id, source] of candidates) {
    if (excluded.has(id)) continue;
    const page = await getPage(id);
    // A 404 cannot prove removal. Stop without reading any candidate bodies.
    if (!page) throw new WorkerError("SCOPE_INCOMPLETE");
    if (page.in_trash || page.archived || page.is_archived) {
      absences.set(id, { id, reason: page.in_trash ? "deleted" : "archived" }); excluded.add(id);
      continue;
    }
    if (source.kind !== "study-note") {
      parents.set(id, null);
      if (page.parent.type !== "data_source_id" || normalizeId(page.parent.data_source_id) !== source.dataSourceId) {
        absences.set(id, { id, reason: "out-of-scope" }); excluded.add(id);
      }
    } else if (page.parent.type === "data_source_id") {
      parents.set(id, source.coursePageId);
      if (normalizeId(page.parent.data_source_id) !== source.dataSourceId) {
        absences.set(id, { id, reason: "out-of-scope" }); excluded.add(id);
      }
    } else {
      parents.set(id, await containingPage(page.parent));
    }
  }
  // A denied/confirmed-removed course excludes all its notes, even after a move.
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, source] of candidates) {
      const parent = parents.get(id);
      if (!excluded.has(id) && ((parent && excluded.has(parent)) || (source.coursePageId && excluded.has(source.coursePageId)))) {
        excluded.add(id); changed = true;
      }
    }
  }
  // Descendant tombstones are unnecessary: frozen SQL follows the permit parent chain.
  for (const [id, absence] of absences) {
    const source = candidates.get(id)!;
    if ((parents.get(id) && excluded.has(parents.get(id)!)) || (source.coursePageId && excluded.has(source.coursePageId))) absences.delete(absence.id);
  }
  const accepted = new Set([...candidates.keys()].filter(id => !excluded.has(id)));
  const courseCounts = new Map<string, number>();
  for (const id of accepted) {
    const source = candidates.get(id)!;
    if (source.kind === "study-note") {
      const count = (courseCounts.get(source.coursePageId!) ?? 0) + 1;
      if (count > 5000) throw new WorkerError("LIMIT_EXCEEDED");
      courseCounts.set(source.coursePageId!, count);
    }
  }
  const effective: NotionSourcesConfig = {
    schemaVersion: 1,
    sources: config.sources.map(source => ({ ...source, publication: { ...source.publication,
      allowlistPageIds: source.publication.allowlistPageIds.filter(id => accepted.has(id)) } })),
  };
  const client: NotionReadClient = {
    getPage: async id => { checkSignal(signal); return accepted.has(normalizeId(id)) ? await getPage(id) : null; },
    getDataSource: async id => { checkSignal(signal); const schema = schemas.get(normalizeId(id)); if (!schema) throw new WorkerError("SCOPE_INCOMPLETE"); return schema; },
    getBlock,
    listPages: async id => {
      checkSignal(signal); id = normalizeId(id);
      const result = rows.get(id); if (!result) throw new WorkerError("SCOPE_INCOMPLETE");
      // Prefer the fresh per-page qualification read over earlier learning query metadata.
      return result.filter(p => accepted.has(normalizeId(p.id))).map(p => pages.get(normalizeId(p.id))!)
        .filter((p): p is PageObjectResponse => Boolean(p && p.parent.type === "data_source_id" && normalizeId(p.parent.data_source_id) === id));
    },
    listBlocks: async id => { checkSignal(signal); const result = await raw.listBlocks(normalizeId(id)); checkSignal(signal); return result; },
  };
  const repository = createNotionRepository({ client, config: effective });
  const qualified = new Map<string, PublicNotionPage>();
  for (const id of accepted) {
    const resolved = await repository.resolvePublicPage(id);
    if (!resolved || resolved.source.key !== candidates.get(id)!.key) throw new WorkerError("SCOPE_INCOMPLETE");
    qualified.set(id, resolved);
  }
  const ordered: PublicNotionPage[] = [];
  for (const resolved of qualified.values()) if (resolved.source.kind === "status") ordered.push(resolved);
  for (const resolved of qualified.values()) if (resolved.source.kind === "course") {
    ordered.push(resolved);
    const tree = await repository.getCourseTree(normalizeId(resolved.page.id));
    if (!tree) throw new WorkerError("SCOPE_INCOMPLETE");
    const walk = (nodes: typeof tree.nodes) => {
      for (const node of nodes) {
        const note = qualified.get(node.id);
        if (!note || note.source.kind !== "study-note") throw new WorkerError("SCOPE_INCOMPLETE");
        ordered.push(note); walk(node.children ?? []);
      }
    };
    walk(tree.nodes);
  }
  if (ordered.length !== accepted.size || new Set(ordered.map(r => normalizeId(r.page.id))).size !== accepted.size) throw new WorkerError("SCOPE_INCOMPLETE");
  return { client, config: effective, ordered, databaseParents, absences: [...absences.values()], excluded: candidates.size - accepted.size, metadataReads };
}

export function evidence(resolved: PublicNotionPage, plan: CollectionPlan, ordinal: number): SyncRecord["evidence"] {
  const courseId = resolved.course ? normalizeId(resolved.course.page.id) : null;
  return { sourceKey: resolved.source.key, dataSourceId: resolved.source.dataSourceId,
    databaseParentId: plan.databaseParents.get(resolved.source.key) ?? null, courseId,
    parentId: resolved.ancestors.length ? normalizeId(resolved.ancestors.at(-1)!.id) : courseId, ordinal };
}
