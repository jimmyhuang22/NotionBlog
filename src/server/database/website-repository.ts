import type { AnyContent, ContentDetail, ContentKind, ContentByKind, Course, Game, ListQuery, StudyNote, StudyNode } from "../../../contracts/content.ts";
import type { ContentRepository } from "../../../contracts/repository.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { sanitizePublicText } from "../notion/public-text.ts";
import { validateListQuery, validateLibraryYearsQuery } from "../../lib/content/query.ts";
import { libraryYears } from "../../lib/content/years.ts";
import { studyTree } from "../notion/study-order.ts";
import { compareContent, matchesContent, pageOf, documentPlainText, searchContentSnapshot, validateSearchQuery } from "../../lib/content/website.ts";
import { CONTENT_KINDS } from "../../../config/features.ts";
import { GAME_DATE_POLICY, projectGameDates } from "../../lib/content/game-date.ts";
import { statusPreview, statusTimeZone, statusYears, type StatusReadOptions } from "../../lib/content/status.ts";
import { WEBSITE_CONTENT_SQL, WEBSITE_SNAPSHOT_SQL, WEBSITE_STATUS_INDEX_SQL, WEBSITE_STATUS_PAGE_SQL } from "./website-projection.ts";
import { measureContentRead, measureContentReadAsync } from "../content-read-timing.ts";
import { SCOPED_INDEX_SQL, SCOPED_SEARCH_SQL, SCOPED_FILTERED_SEARCH_SQL, SCOPED_SELECTED_SQL, SCOPED_VERSION_SQL, SCOPED_STATUS_INDEX_SQL } from "./scoped-reads.ts";
import { contentReadBudgetIdentity } from "../content-read-budget.ts";
import { STUDY_DIRECTORY_SQL, STUDY_NOTE_ELIGIBILITY_SQL, STUDY_NOTE_DETAIL_SQL } from "./study-reads.ts";
import { readSearchContexts } from "./search-context.ts";
import { SEARCH_CONTEXT_VERSION } from "../../lib/content/search-context.ts";
import type { SearchHit } from "../../../contracts/website.ts";
import type { Page } from "../../../contracts/content.ts";
interface Projection { runId: string; revision: string; schemaDigest: string; records: ContentDetail<AnyContent>[]; links: string[]; mediaIds: string[]; hasMore?: boolean }
/** Scrub references against CURRENT eligibility even when stored AST predates a withdrawal. */
function project<T>(value: T, snapshot: Projection, timeZone: string): T {
  const links=new Set(snapshot.links), images=new Set(snapshot.mediaIds);
  function visit(x: unknown): unknown {
    if (typeof x==="string") return sanitizePublicText(x);
    if (Array.isArray(x)) return x.map(visit).filter(v=>v!==null);
    if (!x||typeof x!=="object") return x;
    const o=x as Record<string,unknown>;
    if(o.kind==="internal" && !links.has(o.href as string))return {kind:"unavailable"};
    if(typeof o.src==="string"&&o.src.startsWith("/media/")&&!images.has(o.id as string))return null;
    if(o.type==="child-page"&&(!o.target||!links.has((o.target as {href:string}).href)))return {id:o.id,type:"child-page",title:"Unavailable page",target:null};
    if(typeof o.href==="string"&&!o.kind&&!links.has(o.href))return null;
    const out=Object.fromEntries(Object.entries(o).map(([k,v])=>[k,visit(v)]));
    if(o.kind==="game")return projectGameDates(out as unknown as Game,timeZone);
    if(o.type==="image"&&out.image===null)return {id:o.id,type:"unsupported",label:"Image unavailable"};
    if(o.link&&out.link&&(out.link as {kind:string}).kind==="unavailable")out.text="Unavailable page";
    return out;
  }
  return measureContentRead("dto-projection", () => visit(value) as T);
}

export interface WebsiteReadOptions extends StatusReadOptions {
  /** Explicit opt-in after the independent context reader is installed and verified. */
  searchContext?: boolean;
  scoped?: boolean;
  filteredSearch?: boolean;
  /** Explicit operator export only. Ordinary website readers keep the SQL snapshot cap. */
  snapshotPageSize?: number;
  maxSnapshotBytes?: number;
}

/** Qualified SQL projections without a persistent publication cache or Notion calls. */
export function createWebsiteDatabaseRepository(db: SqlExecutor, options: WebsiteReadOptions = {}): ContentRepository {
  // Resolve the same existing option as scopedReader, once per repository. The
  // shared runtime factory and its frozen producer compatibility pins stay intact.
  const filteredSearch = options.filteredSearch ?? (options.scoped === true && process.env.DATABASE_SEARCH_PROJECTION === "filtered");
  if (filteredSearch && !options.scoped) throw new ContentServiceError("MISCONFIGURED", "Filtered search requires scoped reads.");
  const zone=()=>statusTimeZone(options);
  const pageSize=options.snapshotPageSize, maxSnapshotBytes=options.maxSnapshotBytes??16*1024*1024;
  if ((pageSize!==undefined&&(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100))||
      !Number.isSafeInteger(maxSnapshotBytes)||maxSnapshotBytes<1||maxSnapshotBytes>64*1024*1024||
      (pageSize===undefined&&options.maxSnapshotBytes!==undefined))
    throw new ContentServiceError("MISCONFIGURED","Invalid bounded snapshot options.");
  const validate = (p: Projection) => {
    if(p.schemaDigest!==WEBSITE_SCHEMA_DIGEST || !Array.isArray(p.records) || p.records.length>20000 ||
      !Array.isArray(p.links) || !Array.isArray(p.mediaIds))throw new ContentServiceError("CONTENT_UNAVAILABLE","Website database schema is incompatible.");
    return p;
  };
  const version = (p: Projection) => `${p.runId}:${p.revision}`;
  const searchVersion = (p: Projection) => `${version(p)}${options.searchContext ? `:${SEARCH_CONTEXT_VERSION}` : ""}`;
  const contextPage = async (page: Page<SearchHit>, pin: Projection): Promise<Page<SearchHit>> => {
    if (!options.searchContext) return page;
    const contexts = await readSearchContexts(db, page.items.filter(hit => hit.kind === "study-note").map(hit => hit.id), pin);
    return { ...page, items: page.items.map(hit => hit.kind === "study-note" ? { ...hit, context: contexts.get(hit.id) ?? null } : hit) };
  };
  const readContent = async (kind: ContentKind, slug: string | null, documents: boolean,
    pin?: Projection, offset = 0, limit = 1, index = false) => validate(await callSql<Projection>(db,index ? options.scoped ? SCOPED_STATUS_INDEX_SQL : WEBSITE_STATUS_INDEX_SQL : WEBSITE_CONTENT_SQL,
      [kind,documents,slug,pin?.runId??null,pin?.revision??null,offset,limit]));
  const readStudy = async (slug: string, noteSlug?: string, documents = false) => {
    const pair = await callSql<{ course: Projection; notes: Projection | null }>(db,
      noteSlug === undefined ? STUDY_DIRECTORY_SQL : documents ? STUDY_NOTE_DETAIL_SQL : STUDY_NOTE_ELIGIBILITY_SQL, noteSlug === undefined ? [slug] : [slug,noteSlug]);
    const owner = validate(pair.course);
    if (owner.records.length > 1 || owner.records.some(record => record.item.kind !== "course" || record.item.slug !== slug))
      throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study course.");
    if (!owner.records.length) return null;
    const course = project(owner.records,owner,zone())[0].item as Course;
    if (!pair.notes) throw new ContentServiceError("CONTENT_UNAVAILABLE","Missing study projection.");
    const notes = validate(pair.notes);
    if (version(notes)!==version(owner) || notes.records.some(record => record.item.kind!=="study-note" || record.item.courseId!==course.id || noteSlug!==undefined && record.item.slug!==noteSlug))
      throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study snapshot.");
    return { course, owner, notes };
  };
  const metadataPending = new WeakMap<object, Map<ContentKind, Promise<Projection>>>();
  const loadMetadata = async (kind: ContentKind) => {
    let p = await readContent(kind,null,false,undefined,0,5000,kind==="status");
    const records = project(p.records,p,zone());
    let more = p.hasMore;
    while(more) {
      if(records.length>=20000)throw new ContentServiceError("CONTENT_UNAVAILABLE","The public content snapshot exceeds the supported size.");
      const next = await readContent(kind,null,false,p,records.length,5000,kind==="status");
      if(version(next)!==version(p) || !next.records.length)throw new ContentServiceError("CONTENT_UNAVAILABLE","Content changed during metadata reading.");
      records.push(...project(next.records,next,zone()));more=next.hasMore;
    }
    p = {...p,records};
    return p;
  };
  // Only overlapping callers (for example list + year counts) share the read.
  // Other request scopes cannot replace that registration. Settled results and
  // failures never survive for another qualification check.
  const metadata = (kind: ContentKind): Promise<Projection> => {
    const context = contentReadBudgetIdentity();
    if (!context) return loadMetadata(kind);
    const requests = metadataPending.get(context) ?? new Map<ContentKind, Promise<Projection>>();
    metadataPending.set(context, requests);
    const existing = requests.get(kind);
    if (existing) return existing.then(value => structuredClone(value));
    const pending = loadMetadata(kind);
    requests.set(kind, pending);
    const clear = () => {
      if (requests.get(kind) === pending) requests.delete(kind);
      if (!requests.size) metadataPending.delete(context);
    };
    void pending.then(clear, clear);
    return pending.then(value => structuredClone(value));
  };
  const readVersion = () => callSql<Projection>(db, options.scoped ? SCOPED_VERSION_SQL : WEBSITE_SNAPSHOT_SQL,
    options.scoped ? [] : [[], false]).then(validate);
  const readSnapshot: NonNullable<ContentRepository["readSnapshot"]> = async (kinds,documents=false) => {
    if(pageSize===undefined){
      const p=validate(await callSql<Projection>(db,WEBSITE_SNAPSHOT_SQL,[[...new Set(kinds)],documents]));
      return {version:version(p),records:project(p.records,p,zone())};
    }
    const allowed=["status","course","study-note","post","album","book","movie","game","project","page"];
    if(!Array.isArray(kinds)||kinds.length>10||kinds.some(k=>!allowed.includes(k))||typeof documents!=="boolean")
      throw new ContentServiceError("INVALID_QUERY","Invalid snapshot selection.");
    // Pin every page to the same current run/revision. SQL still enforces expiry,
    // deny, ownership and current eligibility; no staged rows are read directly.
    const pin=validate(await callSql<Projection>(db,WEBSITE_SNAPSHOT_SQL,[[],false]));
    const records:ContentDetail<AnyContent>[]=[],seen=new Set<string>();let bytes=2;
    for(const kind of new Set(kinds)){
      for(let offset=0;;offset+=pageSize){
        const next=await readContent(kind,null,documents||kind==="status",pin,offset,pageSize);
        if(version(next)!==version(pin)||typeof next.hasMore!=="boolean"||next.records.length>pageSize||
            next.hasMore&&next.records.length!==pageSize)throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid snapshot page.");
        for(const record of project(next.records,next,zone())){
          if(record.item.kind!==kind||seen.has(record.item.id)||records.length>=20000)
            throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid snapshot records.");
          seen.add(record.item.id);bytes+=Buffer.byteLength(JSON.stringify(record))+1;
          if(bytes>maxSnapshotBytes)throw new ContentServiceError("CONTENT_UNAVAILABLE","Snapshot export exceeds its byte budget.");
          records.push(record);
        }
        if(!next.hasMore)break;
      }
    }
    const end=validate(await callSql<Projection>(db,WEBSITE_SNAPSHOT_SQL,[[],false]));
    if(version(end)!==version(pin))throw new ContentServiceError("CONTENT_UNAVAILABLE","Content changed during snapshot export.");
    records.sort((a,b)=>a.item.id.localeCompare(b.item.id));
    return {version:version(pin),records};
  };
  const repository: ContentRepository = {
    readSnapshot,
    ...(options.scoped ? { async getSelected<K extends ContentKind>(kind: K, slugs: string[], expectedVersion: string) {
      const pin = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,20})$/i.exec(expectedVersion);
      if (!pin || !Array.isArray(slugs) || !slugs.length || slugs.length > 50 || slugs.some(slug => !/^[a-zA-Z0-9_-]{1,128}$/.test(slug)))
        throw new ContentServiceError("INVALID_QUERY", "Invalid selected content query.");
      const selected = new Set(slugs);
      const p = validate(await callSql<Projection>(db, SCOPED_SELECTED_SQL, [kind, [...selected], pin[1], pin[2]]));
      if (version(p) !== expectedVersion || p.records.length > selected.size ||
        new Set(p.records.map(record => record.item.id)).size !== p.records.length ||
        p.records.some(record => record.item.kind !== kind || !selected.has(record.item.slug)))
        throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid selected content projection.");
      return project(p.records, p, zone()) as ContentDetail<ContentByKind[K]>[];
    }, async readIndex(kinds: ContentKind[]) {
      const p = validate(await callSql<Projection>(db, SCOPED_INDEX_SQL, [[...new Set(kinds)]]));
      return { version: version(p), records: project(p.records, p, zone()) };
    } } : {}),
    async search(query) {
      validateSearchQuery(query);
      const selected = [...new Set(query.kinds ?? CONTENT_KINDS)].sort();
      if (options.scoped) {
        const patterns = filteredSearch ? (await import("./search-filter.ts")).searchFilterPatterns(query.q) : undefined;
        const p = await measureContentReadAsync("search-read", () => callSql<Omit<Projection, "records"> & { records: (ContentDetail<AnyContent> & { parts: unknown[] })[] }>(db,
          patterns ? SCOPED_FILTERED_SEARCH_SQL : SCOPED_SEARCH_SQL, patterns ? [selected, patterns] : [selected]));
        const records = measureContentRead("search-text", () => {
          validate(p);
          const links = new Set(p.links), images = new Set(p.mediaIds);
          const items = new Map(project(p.records.map(record => record.item), p, zone()).map(item => [item.id, item]));
          const records = p.records.map(record => {
            const item = items.get(record.item.id);
            if (!item || !Array.isArray(record.parts)) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid search projection.");
            const text: string[] = [];
            for (const part of record.parts) {
              if (typeof part === "string") text.push(sanitizePublicText(part));
              else if (Array.isArray(part) && part.length === 3 && typeof part[0] === "string" &&
                (part[1] === null || typeof part[1] === "string") && (part[2] === null || typeof part[2] === "string")) {
                if ((part[1] === null || links.has(part[1])) && (part[2] === null || images.has(part[2]))) text.push(sanitizePublicText(part[0]));
              } else throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid search projection.");
            }
            return { item,
            document: { toc: [], completeness: "complete" as const, blocks: [{ id: "search-text", type: "paragraph" as const,
              text: [{ text: text.join(" ").replace(/\s+/g, " ").trim() }] }] } };
          });
          if (Buffer.byteLength(JSON.stringify(records)) > 16 * 1024 * 1024 ||
            new Set(records.map(record => record.item.id)).size !== records.length ||
            records.some(record => !selected.includes(record.item.kind)))
            throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid search projection.");
          return records;
        });
        const result = await contextPage(measureContentRead("search-match", () => searchContentSnapshot({ version: searchVersion(p), records }, query, selected)), p);
        if (version(await measureContentReadAsync("search-version", readVersion)) !== version(p))
          throw new ContentServiceError("INVALID_QUERY", "Content changed during search.");
        return result;
      }
      let pin: Projection | undefined, bytes = 2;
      const records: ContentDetail<AnyContent>[] = [], seen = new Set<string>();
      // Reuse bounded, qualified content pages. Compact after reference scrubbing
      // in the application; do not recursively materialize the AST in PostgreSQL.
      for (const kind of selected) {
        for (let offset = 0; ; offset += 100) {
          const p = await readContent(kind, null, true, pin, offset, 100);
          if ((pin && version(p) !== version(pin)) || typeof p.hasMore !== "boolean" ||
              p.records.length > 100 || (p.hasMore && p.records.length !== 100))
            throw new ContentServiceError("INVALID_QUERY", "Content changed during search.");
          pin ??= p;
          for (const record of project(p.records, p, zone())) {
            if (record.item.kind !== kind || seen.has(record.item.id) || records.length >= 20000)
              throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid search projection.");
            const compact = { item: record.item, document: { toc: [], completeness: "complete" as const,
              blocks: [{ id: "search-text", type: "paragraph" as const, text: [{ text: documentPlainText(record.document) }] }] } };
            seen.add(record.item.id); bytes += Buffer.byteLength(JSON.stringify(compact)) + 1;
            if (bytes > 16 * 1024 * 1024)
              throw new ContentServiceError("CONTENT_UNAVAILABLE", "Search text exceeds its byte budget.");
            records.push(compact);
          }
          if (!p.hasMore) break;
        }
      }
      const result = await contextPage(measureContentRead("search-match", () => searchContentSnapshot({ version: searchVersion(pin!), records }, query, selected)), pin!);
      const end = await measureContentReadAsync("search-version", readVersion);
      if (version(end) !== version(pin!)) throw new ContentServiceError("INVALID_QUERY", "Content changed during search.");
      return result;
    },
    async getContentMetadata<K extends ContentKind>(kind: K, slug: string) {
      if (kind === "page" && slug !== "about") return null;
      const p = await readContent(kind,slug,false);
      return (project(p.records,p,zone())[0]?.item ?? null) as ContentByKind[K] | null;
    },
    async list<K extends ContentKind>(kind: K,query: ListQuery={}) {
      validateListQuery(kind,query);const {cursor,limit,...filters}=query, timeZone=zone(), snapshot=await metadata(kind);
      const records=snapshot.records.filter(d=>matchesContent(d.item,filters,timeZone)).sort((a,b)=>compareContent(a.item,b.item,query.order??(kind==="course"?"title-asc":"date-desc"),timeZone));
      const page=pageOf(records.map(d=>d.item) as ContentByKind[K][],{cursor,limit},["list",kind,version(snapshot),filters,limit??12,timeZone,...(kind==="game"?[GAME_DATE_POLICY]:[])]);
      if(kind!=="status" || !page.items.length)return page;
      const p=validate(await callSql<Projection>(db,options.scoped ? SCOPED_SELECTED_SQL : WEBSITE_STATUS_PAGE_SQL,
        options.scoped ? [kind,page.items.map(item=>item.slug),snapshot.runId,snapshot.revision] : [[kind],true,page.items.map(item=>item.slug)]));
      if(version(p)!==version(snapshot))throw new ContentServiceError("INVALID_QUERY","Content changed during pagination. Restart from the first page.");
      const details=new Map(project(p.records,p,zone()).map(detail=>[detail.item.id,detail]));
      const items=page.items.map(item=>{
        const detail=details.get(item.id);
        if(!detail)throw new ContentServiceError("CONTENT_UNAVAILABLE","Content changed during pagination.");
        return statusPreview(detail.item as ContentByKind["status"],detail.document);
      }) as ContentByKind[K][];
      return {...page,items};
    },
    async get<K extends ContentKind>(kind: K,slug: string) {
      if(kind==="page"&&slug!=="about")return null;
      const p=await readContent(kind,slug,true);return (project(p.records,p,zone())[0]??null) as ContentDetail<ContentByKind[K]>|null;
    },
    async getPage(key) {if(key!=="about")return null;const d=await repository.get("page",key);return d?{slug:"about",title:d.item.title,updatedAt:d.item.updatedAt,document:d.document}:null;},
    async getCourseMetadata(slug) {return repository.getContentMetadata!("course",slug);},
    async isStudyNoteAvailable(courseSlug,noteSlug) {
      const pair = await readStudy(courseSlug,noteSlug);
      if (pair && (pair.notes.records.length>1 || pair.notes.hasMore))
        throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study note.");
      return !!pair?.notes.records.length;
    },
    async readStudyNote(courseSlug,noteSlug) {
      const pair=await readStudy(courseSlug,noteSlug,true);
      if(!pair)return null;
      if(pair.notes.records.length>1 || pair.notes.hasMore)throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study note.");
      return {course:pair.course,note:(project(pair.notes.records,pair.notes,zone())[0]??null) as ContentDetail<StudyNote>|null};
    },
    async getStatusYears() {const s=await metadata("status");return statusYears(s.records.map(d=>d.item as ContentByKind["status"]),zone());},
    async getLibraryYears(kind, query = {}) {
      validateLibraryYearsQuery(kind, query);
      const timeZone = zone(), snapshot = await metadata(kind);
      return libraryYears(snapshot.records.map(record => record.item).filter(item => matchesContent(item, query, timeZone)), timeZone);
    },
    async getHome() {
      const [posts,statuses,albums,books,games,courses]=await Promise.all([repository.list("post",{limit:3}),repository.list("status",{limit:12}),repository.list("album",{limit:3}),repository.list("book",{status:"reading",limit:3}),repository.list("game",{status:"playing",limit:3}),repository.list("course",{limit:6})]);
      return {featuredPosts:posts.items,recentStatuses:statuses.items,latestAlbums:albums.items,readingBooks:books.items,playingGames:games.items,featuredCourses:courses.items};
    },
    async getCourseTree(slug,parentId) {
      const pair=await readStudy(slug);
      if(!pair)return null;
      const {course,owner}=pair,run=owner.runId,revision=owner.revision;
      const notes: StudyNote[]=[];
      for(let offset=0;offset<20000;offset+=5000) {
        const p=offset===0 ? pair.notes : await callSql<Projection & {hasMore:boolean}>(db,
          "SELECT nb_v2_api.read_content($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) AS result",
          ["study-note",null,course.id,"{}",offset,5000,run,revision,false]);
        if(p.runId!==run||p.revision!==revision||p.schemaDigest!==WEBSITE_SCHEMA_DIGEST||typeof p.hasMore!=="boolean"||!Array.isArray(p.records)||p.records.length>5000||
          p.records.some(d=>d.item.kind!=="study-note"||d.item.courseId!==course.id))
          throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid study snapshot.");
        notes.push(...project(p.records,p,zone()).map(d=>d.item as StudyNote));
        if(!p.hasMore)return studyTree(notes,course.id,parentId);
      }
      throw new ContentServiceError("CONTENT_UNAVAILABLE","Study directory exceeds its boundary.");
    }
  };return repository;
}
