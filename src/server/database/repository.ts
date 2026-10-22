import type { AnyContent, ContentByKind, ContentDetail, ContentKind, Course, ListQuery, StatusEntry, StatusYears, StudyNode, StudyNote } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { validateListQuery } from "../../lib/content/query.ts";
import { sanitizePublicText } from "../notion/public-text.ts";
import { configDigest } from "./validation.ts";
import { SYNC_SCHEMA_DIGEST } from "../../../contracts/sync.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { statusPreview, statusTimeZone, type StatusReadOptions } from "../../lib/content/status.ts";
import readerProtocol from "../../../database/reader-protocol.json" with { type: "json" };

interface Projection {
  runId: string;
  revision: string;
  records: ContentDetail<AnyContent>[];
  hasMore: boolean;
  links: string[];
  mediaIds: string[];
  schemaDigest: string;
  readerCapability?: string;
}
interface Cursor { v: 1; run: string; rev: string; offset: number; query: string }
function invalid(): never { throw new ContentServiceError("INVALID_QUERY", "Invalid database cursor. Restart from the first page."); }
function parseCursor(value: string, fingerprint: string): Cursor {
  try {
    if (!/^d1\.[A-Za-z0-9_-]+$/.test(value)) return invalid();
    const c=JSON.parse(Buffer.from(value.slice(3),"base64url").toString("utf8")) as Cursor;
    if(c.v!==1||typeof c.run!=="string"||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(c.run)||!/^\d+$/.test(c.rev)||!Number.isSafeInteger(c.offset)||c.offset<0||c.offset>100000||c.query!==fingerprint) return invalid();
    return c;
  } catch { return invalid(); }
}

/** Scrub references against CURRENT eligibility even when stored AST predates a withdrawal. */
function project<T>(value: T, snapshot: Projection): T {
  const links=new Set(snapshot.links), images=new Set(snapshot.mediaIds);
  function visit(x: unknown): unknown {
    if (typeof x==="string") return sanitizePublicText(x);
    if (Array.isArray(x)) return x.map(visit).filter(v=>v!==null);
    if (!x||typeof x!=="object") return x;
    const o=x as Record<string,unknown>;
    if(o.kind==="internal" && !links.has(o.href as string))return {kind:"unavailable"};
    if(typeof o.src==="string"&&o.src.startsWith("/media/")&&!images.has(o.id as string))return null;
    if(o.type==="child-page"&&o.target&&!links.has((o.target as {href:string}).href))return {id:o.id,type:"child-page",title:"Unavailable page",target:null};
    if(typeof o.href==="string"&&!o.kind&&!links.has(o.href))return null;
    const out=Object.fromEntries(Object.entries(o).map(([k,v])=>[k,visit(v)]));
    if(o.type==="image"&&out.image===null)return {id:o.id,type:"unsupported",label:"Image unavailable"};
    if(o.link&&out.link&&(out.link as {kind:string}).kind==="unavailable")out.text="Unavailable page";
    return out;
  }
  return visit(value) as T;
}

export function createDatabaseRepository(db: SqlExecutor, options: StatusReadOptions = {}): ContentRepository {
  const read=async (kind: ContentKind, options: {slug?:string;course?:string;query?:ListQuery;offset?:number;limit?:number;run?:string;revision?:string;document?:boolean}={}) => {
    const result=await callSql<Projection>(db,"SELECT nb_api.read_content($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) AS result",[
      kind,options.slug??null,options.course??null,JSON.stringify(options.query??{}),options.offset??0,
      options.limit??1,options.run??null,options.revision??null,options.document??false,
    ]);
    if(result.schemaDigest!==SYNC_SCHEMA_DIGEST)throw new ContentServiceError("CONTENT_UNAVAILABLE","Database schema is incompatible.");
    return result;
  };
  const getMetadata=async (slug: string): Promise<Course|null> => {
    const p=await read("course",{slug});return p.records[0]?project(p.records[0].item,p) as Course:null;
  };
  const repository: ContentRepository={
    async list<K extends ContentKind>(kind: K, query: ListQuery={}) {
      validateListQuery(kind,query);
      const {cursor, ...filters}=query;
      const normalized={...filters,limit:query.limit??12,order:query.order??(kind==="course"?"title-asc":"date-desc")};
      const timeZone = kind === "status" ? statusTimeZone(options) : "UTC";
      const fingerprint=configDigest([kind,normalized,timeZone]);
      const c=cursor?parseCursor(cursor,fingerprint):null;
      const p = kind === "status" ? await callSql<Projection>(db,"SELECT nb_api.read_status($1,$2::jsonb,$3,$4,$5,$6) AS result",[
        timeZone,JSON.stringify(normalized),c?.offset??0,normalized.limit,c?.run??null,c?.rev??null,
      ]) : await read(kind,{query:normalized,limit:normalized.limit,offset:c?.offset,run:c?.run,revision:c?.rev});
      if (p.schemaDigest !== SYNC_SCHEMA_DIGEST || (kind === "status" && p.readerCapability !== readerProtocol.capability)) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Database reader is incompatible.");
      const details = project(p.records, p);
      const items=details.map(d=>kind === "status" ? statusPreview(d.item as StatusEntry,d.document) : d.item) as ContentByKind[K][];
      return {items,hasMore:p.hasMore,nextCursor:p.hasMore?`d1.${Buffer.from(JSON.stringify({v:1,run:p.runId,rev:p.revision,offset:(c?.offset??0)+items.length,query:fingerprint})).toString("base64url")}`:null};
    },
    async get<K extends ContentKind>(kind: K,slug: string) {
      const p=await read(kind,{slug,document:true});return p.records[0]?project(p.records[0],p) as ContentDetail<ContentByKind[K]>:null;
    },
    getCourseMetadata:getMetadata,
    async getStatusYears() {
      const p=await callSql<StatusYears & {schemaDigest:string;readerCapability:string}>(db,"SELECT nb_api.status_years($1) AS result",[statusTimeZone(options)]);
      if(p.schemaDigest!==SYNC_SCHEMA_DIGEST || p.readerCapability!==readerProtocol.capability) throw new ContentServiceError("CONTENT_UNAVAILABLE","Database reader is incompatible.");
      return {years:p.years,undatedCount:p.undatedCount,timeZone:p.timeZone};
    },
    async getHome() {
      const [statuses,courses]=await Promise.all([repository.list("status",{limit:12}),repository.list("course",{limit:6})]);
      return {featuredPosts:[],recentStatuses:statuses.items,latestAlbums:[],readingBooks:[],playingGames:[],featuredCourses:courses.items};
    },
    async getCourseTree(slug: string,parentId?: string) {
      const c=await read("course",{slug});
      const course=c.records[0]?.item;
      if(!course)return null;
      const p=await read("study-note",{course:course.id,limit:5000,run:c.runId,revision:c.revision});
      if(p.hasMore)throw new ContentServiceError("CONTENT_UNAVAILABLE","The course tree exceeds the supported size.");
      const notes=project(p.records.map(d=>d.item),p) as StudyNote[];
      if(parentId!==undefined&&!notes.some(n=>n.id===parentId))return null;
      const byParent=new Map<string|null,StudyNote[]>();
      for(const note of notes){const siblings=byParent.get(note.parentId)??[];siblings.push(note);byParent.set(note.parentId,siblings);}
      function build(parent: string|null,depth=0): StudyNode[] {
        if(depth>128)throw new ContentServiceError("CONTENT_UNAVAILABLE","The course tree is unavailable.");
        return (byParent.get(parent)??[]).map(note=>{const children=build(note.id,depth+1);return {id:note.id,title:note.title,href:note.href,hasChildren:children.length>0,children,noteType:note.noteType,date:note.date};});
      }
      return {courseId:course.id,nodes:build(parentId??null)};
    },
  };
  return repository;
}
