import type { BlockObjectResponse, DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { NotionReadClient } from "./types.ts";
import type { WebsiteNotionConfig, WebsiteNotionSource } from "./website-config.ts";
import { assertWebsiteSourceSchema } from "./website-config.ts";
import { normalizeId } from "./config.ts";
import { getProperty, getTitle, getDate } from "./properties.ts";
import { compareStudyEntries } from "./study-order.ts";
import type { StudyNote } from "../../../contracts/content.ts";

export interface AutomaticStudyPage {
  page: PageObjectResponse; source: WebsiteNotionSource;
  course: { page: PageObjectResponse; source: WebsiteNotionSource; course: null; ancestors: PageObjectResponse[] };
  ancestors: PageObjectResponse[];
}
/** Operational counters only; never publication evidence or a resumable snapshot. */
export interface StudyDiscoveryProgress {
  phase: "course-start" | "scanning" | "course-complete" | "complete";
  courseIndex: number;
  courseCount: number;
  coursesCompleted: number;
  pagesDiscovered: number;
  blocksScanned: number;
}
const active = (x: { archived?: boolean; in_trash?: boolean; is_archived?: boolean }) => !x.archived && !x.in_trash && !x.is_archived;
const titles = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
function unavailable(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Study ancestry or discovery is incomplete."); }
export function studyOverride(page: PageObjectResponse, source: WebsiteNotionSource): number | null {
  const value = getProperty(page, source.fields.order);
  return value?.type === "number" && value.number !== null && Number.isFinite(value.number) ? value.number : null;
}

/** Fresh per operation. Only physical ownership grants automatic study scope. */
export class AutomaticStudySession {
  readonly client: NotionReadClient;
  private config: WebsiteNotionConfig;
  private denied: ReadonlySet<string>;
  private resolutions = new Map<string, Promise<AutomaticStudyPage | null>>();
  private discoveries = new Map<string, Promise<string[]>>();
  private onProgress?: (progress: StudyDiscoveryProgress) => void;
  constructor(client: NotionReadClient, config: WebsiteNotionConfig, denied: ReadonlySet<string>, onProgress?: (progress: StudyDiscoveryProgress) => void) {
    this.config = config; this.denied = denied;
    this.onProgress = onProgress;
    const memo = <T>(read: (id: string) => Promise<T>) => {
      const entries = new Map<string, Promise<T>>();
      return (id: string) => { const key = normalizeId(id); if (!entries.has(key)) entries.set(key, read(key)); return entries.get(key)!; };
    };
    const pages = new Map<string, Promise<PageObjectResponse | null>>();
    const getPage = (id: string) => { const key = normalizeId(id); if (!pages.has(key)) pages.set(key, client.getPage(key)); return pages.get(key)!; };
    this.client = { ...client, getPage, getDataSource: memo(id => client.getDataSource(id)),
      getBlock: memo(id => client.getBlock(id)), listBlocks: memo(id => client.listBlocks(id)),
      ...(client.getDatabase ? { getDatabase: memo(id => client.getDatabase!(id)) } : {}),
      ...(client.listPages ? { listPages: memo(async id => {
        const rows = await client.listPages!(id);
        for (const page of rows) pages.set(normalizeId(page.id), Promise.resolve(page));
        return rows;
      }) } : {}),
    };
  }
  private root(source: WebsiteNotionSource): WebsiteNotionSource {
    const root = this.config.sources.find(s => s.kind === "course" && s.publication.mode === "all" && s.dataSourceId === source.dataSourceId);
    if (!root) unavailable(); return root;
  }
  private async owner(parent: { type: string; page_id?: string; block_id?: string }): Promise<string | null> {
    if (parent.type === "page_id") return normalizeId(parent.page_id!);
    if (parent.type !== "block_id") return null;
    let id = normalizeId(parent.block_id!); const seen = new Set<string>();
    for (let depth = 0; depth < 24; depth++) {
      if (seen.has(id)) unavailable(); seen.add(id);
      const block = await this.client.getBlock(id);
      if (!block || !active(block) || normalizeId(block.id) !== id ||
          (block.type === "synced_block" && block.synced_block.synced_from)) return null;
      if (block.parent.type === "page_id") return normalizeId(block.parent.page_id);
      if (block.parent.type !== "block_id") return null;
      id = normalizeId(block.parent.block_id);
    }
    unavailable();
  }
  private derived(source: WebsiteNotionSource, schema?: DataSourceObjectResponse, page?: PageObjectResponse): WebsiteNotionSource {
    const fields = schema ? Object.fromEntries(Object.entries(source.fields).filter(([, name]) =>
      schema.properties[name] || Object.values(schema.properties).some(p => p.id === name))) : {};
    const title = Object.entries(schema?.properties ?? page?.properties ?? {}).find(([, p]) => p.type === "title")?.[0];
    if (!title) unavailable(); fields.title = title;
    const result = { ...source, fields };
    if (schema) assertWebsiteSourceSchema(result, schema);
    return result;
  }
  async resolve(id: string, source: WebsiteNotionSource, trail: string[] = []): Promise<AutomaticStudyPage | null> {
    const key = normalizeId(id);
    if (this.denied.has(key)) return null;
    if (trail.includes(key) || trail.length >= 24) unavailable();
    const cacheKey = `${source.key}:${key}`;
    if (!this.resolutions.has(cacheKey)) this.resolutions.set(cacheKey, this.resolveFresh(key, source, [...trail, key]));
    return this.resolutions.get(cacheKey)!;
  }
  private async resolveFresh(id: string, source: WebsiteNotionSource, trail: string[]): Promise<AutomaticStudyPage | null> {
    const page = await this.client.getPage(id);
    if (!page || !active(page) || normalizeId(page.id) !== id) return null;
    const root = this.root(source); let parentId: string | null, derived: WebsiteNotionSource;
    if (page.parent.type === "data_source_id") {
      const dsId = normalizeId(page.parent.data_source_id);
      if (dsId === root.dataSourceId) return null; // A course cannot become its own note.
      const schema = await this.client.getDataSource(dsId);
      if (!active(schema) || normalizeId(schema.id) !== dsId) return null;
      parentId = await this.owner(schema.database_parent);
      derived = this.derived(source, schema);
    } else {
      parentId = await this.owner(page.parent); derived = this.derived(source, undefined, page);
    }
    if (!parentId || this.denied.has(parentId)) return null;
    const parent = await this.client.getPage(parentId);
    if (!parent || !active(parent) || normalizeId(parent.id) !== parentId) return null;
    if (parent.parent.type === "data_source_id" && normalizeId(parent.parent.data_source_id) === root.dataSourceId) {
      const schema = await this.client.getDataSource(root.dataSourceId!);
      if (!active(schema) || normalizeId(schema.id) !== root.dataSourceId) unavailable();
      assertWebsiteSourceSchema(root, schema);
      return { page, source: derived, course: { page: parent, source: root, course: null, ancestors: [] }, ancestors: [] };
    }
    const ancestor = await this.resolve(parentId, source, trail);
    return ancestor ? { page, source: derived, course: ancestor.course, ancestors: [...ancestor.ancestors, ancestor.page] } : null;
  }
  async ids(source: WebsiteNotionSource, courseId?: string): Promise<string[]> {
    const cacheKey = `${source.key}:${courseId ?? "all"}`;
    if (!this.discoveries.has(cacheKey)) this.discoveries.set(cacheKey, this.discover(source, courseId));
    return this.discoveries.get(cacheKey)!;
  }
  /** Immediate owned notes only: never read a child's body or another course. */
  async children(source: WebsiteNotionSource, pageId: string, courseId: string): Promise<{id:string;position:number;updatedAt:string}[]> {
    const result:{id:string;position:number;updatedAt:string}[]=[],seen=new Set<string>();let blocks=0;
    const add=async(id:string)=>{
      id=normalizeId(id);if(this.denied.has(id))return;
      if(seen.has(id)||result.length>=20000)unavailable();seen.add(id);
      const resolved=await this.resolve(id,source);
      if(!resolved){const page=await this.client.getPage(id);if(page&&!active(page))return;unavailable();}
      if(normalizeId(resolved.course.page.id)!==courseId||normalizeId(resolved.ancestors.at(-1)?.id??resolved.course.page.id)!==pageId)unavailable();
      result.push({id,position:result.length,updatedAt:resolved.page.last_edited_time});
    };
    const scan=async(id:string,path:Set<string>):Promise<void>=>{
      if(path.has(id)||path.size>=24)unavailable();const next=new Set([...path,id]);
      for(const block of await this.client.listBlocks(id)){
        if(++blocks>10000)unavailable();if(!active(block))continue;
        const parent=block.parent.type==="page_id"?block.parent.page_id:block.parent.type==="block_id"?block.parent.block_id:null;
        if(!parent||normalizeId(parent)!==id)unavailable();const key=normalizeId(block.id);
        if(block.type==="child_page")await add(key);
        else if(block.type==="child_database"){
          if(!this.client.getDatabase||!this.client.listPages)unavailable();
          const db=await this.client.getDatabase(key);
          if(!active(db)||normalizeId(db.id)!==key)unavailable();if(await this.owner(db.parent)!==pageId)continue;
          for(const ds of db.data_sources){
            const schema=await this.client.getDataSource(ds.id);
            if(normalizeId(schema.id)!==normalizeId(ds.id))unavailable();if(!active(schema))continue;
            if(schema.parent.type!=="database_id"||normalizeId(schema.parent.database_id)!==key||await this.owner(schema.database_parent)!==pageId)continue;
            const title=Object.keys(schema.properties).find(k=>schema.properties[k].type==="title");if(!title)unavailable();
            const rows=await this.client.listPages(normalizeId(ds.id));
            rows.sort((a,b)=>titles.compare(getTitle(a,title),getTitle(b,title))||a.id.localeCompare(b.id));
            for(const row of rows)if(active(row)){
              if(row.parent.type!=="data_source_id"||normalizeId(row.parent.data_source_id)!==normalizeId(ds.id))unavailable();
              await add(row.id);
            }
          }
        }else if(block.type==="link_to_page"||(block.type==="synced_block"&&block.synced_block.synced_from))continue;
        else if(block.has_children)await scan(key,next);
      }
    };
    await scan(normalizeId(pageId),new Set());return result;
  }
  private async discover(source: WebsiteNotionSource, selectedCourse?: string): Promise<string[]> {
    const root = this.root(source);
    if (!this.client.listPages || !this.client.getDatabase) throw new ContentServiceError("MISCONFIGURED", "Automatic study requires owned database discovery.");
    const roots = selectedCourse ? [await this.client.getPage(selectedCourse)] : await this.client.listPages(root.dataSourceId!);
    const result: string[] = [], seenPages = new Set<string>(); let blockCount = 0;
    const courses = roots.filter((p): p is PageObjectResponse => p !== null && active(p) && !this.denied.has(normalizeId(p.id)))
      .sort((a, b) => a.id.localeCompare(b.id));
    let coursesCompleted = 0, courseIndex = 0;
    const progress = (phase: StudyDiscoveryProgress["phase"]) => this.onProgress?.({ phase, courseIndex, courseCount: courses.length,
      coursesCompleted, pagesDiscovered: seenPages.size, blocksScanned: blockCount });
    for (const course of courses) {
      const courseId = normalizeId(course.id);
      if (course.parent.type !== "data_source_id" || normalizeId(course.parent.data_source_id) !== root.dataSourceId) unavailable();
      courseIndex++; progress("course-start");
      const groups = new Map<string, { resolved: AutomaticStudyPage; position: number }[]>();
      let position = 0;
      const add = async (id: string, owner: string, depth: number) => {
        const canonical = normalizeId(id); if (this.denied.has(canonical)) return;
        if (seenPages.has(canonical) || seenPages.size >= 20000 || depth >= 24) unavailable();
        const resolved = await this.resolve(canonical, source);
        if (!resolved) {
          const page = await this.client.getPage(canonical);
          if (page && !active(page)) return;
          unavailable();
        }
        const parentId = resolved.ancestors.at(-1)?.id ?? resolved.course.page.id;
        if (normalizeId(parentId) !== owner || normalizeId(resolved.course.page.id) !== courseId) unavailable();
        seenPages.add(canonical);
        progress("scanning");
        const siblings = groups.get(owner) ?? []; siblings.push({ resolved, position: position++ }); groups.set(owner, siblings);
        await scan(canonical, canonical, depth + 1, new Set());
      };
      const scan = async (blockId: string, pageId: string, depth: number, path: Set<string>): Promise<void> => {
        if (depth >= 24 || path.has(blockId)) unavailable();
        const nextPath = new Set([...path, blockId]);
        for (const block of await this.client.listBlocks(blockId)) {
          if (++blockCount > 100000) unavailable();
          if (blockCount % 100 === 0) progress("scanning");
          if (!active(block)) continue;
          const parent = block.parent.type === "page_id" ? block.parent.page_id : block.parent.type === "block_id" ? block.parent.block_id : null;
          if (!parent || normalizeId(parent) !== blockId) unavailable();
          const id = normalizeId(block.id);
          if (block.type === "child_page") await add(id, pageId, depth);
          else if (block.type === "child_database") {
            const database = await this.client.getDatabase!(id);
            if (!active(database) || normalizeId(database.id) !== id) unavailable();
            if (await this.owner(database.parent) !== pageId) continue; // Linked/foreign database, not ownership.
            for (const ds of database.data_sources) {
              const schema = await this.client.getDataSource(ds.id);
              if (normalizeId(schema.id)!==normalizeId(ds.id)) unavailable();
              if (!active(schema)) continue;
              if (schema.parent.type !== "database_id" || normalizeId(schema.parent.database_id) !== id || await this.owner(schema.database_parent) !== pageId) continue;
              const pages = await this.client.listPages!(normalizeId(ds.id));
              // Database rows have no block position. Natural titles give a
              // stable fallback within the database's position in the body.
              const titleField=Object.keys(schema.properties).find(k=>schema.properties[k].type==="title");
              if(!titleField)unavailable();
              pages.sort((a,b)=>titles.compare(getTitle(a,titleField),getTitle(b,titleField))||a.id.localeCompare(b.id));
              for (const page of pages) if (active(page)) {
                if (page.parent.type !== "data_source_id" || normalizeId(page.parent.data_source_id) !== normalizeId(ds.id)) unavailable();
                await add(page.id, pageId, depth);
              }
            }
          } else if (block.type === "link_to_page" || (block.type === "synced_block" && block.synced_block.synced_from !== null)) continue;
          else if (block.has_children) await scan(id, pageId, depth + 1, nextPath);
        }
      };
      await scan(courseId, courseId, 0, new Set());
      const visit = (parent: string) => {
        const siblings = groups.get(parent) ?? [];
        siblings.sort((a, b) => {
          const entry = ({ resolved, position }: typeof a) => ({ item: {
            id: normalizeId(resolved.page.id), title: getTitle(resolved.page, resolved.source.fields.title),
            parentId: parent === courseId ? null : parent, date: getDate(resolved.page, resolved.source.fields.date),
          } as StudyNote, override: studyOverride(resolved.page, resolved.source), bodyPosition: position });
          return compareStudyEntries(entry(a), entry(b));
        });
        for (const { resolved } of siblings) { const id = normalizeId(resolved.page.id); result.push(id); visit(id); }
      };
      visit(courseId);
      coursesCompleted++; progress("course-complete");
    }
    progress("complete");
    return result;
  }
  /** Ordering for explicitly selected descendants; references never grant scope. */
  async childPositions(pageId: string): Promise<Map<string, number>> {
    const result = new Map<string, number>(); let blocks = 0;
    const scan = async (id: string, depth: number) => {
      if (depth >= 24) unavailable();
      for (const block of await this.client.listBlocks(id)) {
        if (++blocks > 10000) unavailable();
        if (!active(block)) continue;
        const parent=block.parent.type==="page_id"?block.parent.page_id:block.parent.type==="block_id"?block.parent.block_id:null;
        if(!parent||normalizeId(parent)!==id)unavailable();
        if (block.type === "child_page") result.set(normalizeId(block.id), result.size);
        else if (block.has_children && block.type !== "child_database" && block.type !== "link_to_page" && !(block.type === "synced_block" && block.synced_block.synced_from)) await scan(normalizeId(block.id), depth + 1);
      }
    };
    await scan(pageId, 0); return result;
  }
}
