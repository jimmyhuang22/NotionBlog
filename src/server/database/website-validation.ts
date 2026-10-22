import { createHash } from "node:crypto";
import type { StoredMedia } from "../../../contracts/sync.ts";
import type { WebsiteRecord } from "../../../contracts/website-sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { isNotionPageHost, isTemporaryMediaUrl } from "../notion/public-text.ts";
import { isMoviePublicRating, isMovieRatingSource } from "../../lib/content/movie-rating.ts";

function bad(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid synchronization payload."); }
const object = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return bad();
  return x as Record<string, unknown>;
};
const keys = (x: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(x).some(k => !allowed.includes(k))) bad();
};
const text = (x: unknown): x is string => typeof x === "string" && x.length <= 200000 && !x.includes("\u0000");
const identity = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const num = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(x).sort(([a],[b]) => a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
export const configDigest = (config: unknown) => createHash("sha256").update(canonicalJson(config)).digest("hex");
export function mediaIdentity(ownerPageId: string, locator: string, sha256: string): string {
  // Owner binding prevents sharing a publicly authorized asset ID with a private owner.
  return `a1.${configDigest([ownerPageId,locator,sha256])}`;
}
function href(x: unknown): boolean {
  return typeof x === "string" && /^\/(?:about|(?:blog|photos|projects|library\/(?:games|movies|books))\/[a-zA-Z0-9_-]+|status#[a-zA-Z0-9_-]+|study\/[a-zA-Z0-9_-]+(?:\/notes\/[a-zA-Z0-9_-]+)?)$/.test(x);
}
function url(x: unknown) {
  if (!text(x)) bad();
  let u: URL; try { u=new URL(x); } catch { return bad(); }
  if (!["http:","https:"].includes(u.protocol) || u.username || u.password || isNotionPageHost(u.hostname) || isTemporaryMediaUrl(u)) bad();
}
function date(x: unknown) {
  if (x===null) return;
  const o=object(x); keys(o,["start","end","precision"]);
  const valid=(v: unknown) => text(v) && (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{4}-\d{2}-\d{2}T[^\s]+(?:Z|[+-]\d{2}:\d{2})$/.test(v)) && Number.isFinite(Date.parse(v));
  if (!valid(o.start) || (o.end!==null && !valid(o.end)) || !["date","datetime"].includes(o.precision as string)) bad();
}
function playDay(x: unknown) {
  date(x);if(x===null)return;
  const d=object(x),value=String(d.start),parsed=new Date(`${value}T00:00:00.000Z`);
  if(d.precision!=="date"||d.end!==null||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)bad();
}
function rating(x: unknown) {
  if (x===null) return;
  const o=object(x); keys(o,["value","scale","label"]);
  if (!num(o.value)||!num(o.scale)||!text(o.label)) bad();
}
function image(x: unknown) {
  const o=object(x); keys(o,["id","src","alt","width","height"]);
  if (typeof o.id!=="string" || !/^a1\.[a-f0-9]{64}$/.test(o.id) || o.src!==`/media/v2/${o.id}` || !text(o.alt) || !num(o.width) || !num(o.height)) bad();
}
function link(x: unknown) {
  const o=object(x); keys(o,["title","href"]); if (!text(o.title)||!href(o.href)) bad();
}
function runs(x: unknown) {
  if (!Array.isArray(x)) bad();
  for (const v of x) {
    const o=object(v); keys(o,["text","bold","italic","code","underline","strike","color","link","equation"]);
    if (!text(o.text) || (o.equation !== undefined && o.equation !== true)) bad();
    for (const k of ["bold","italic","code","underline","strike"]) if (o[k]!==undefined&&typeof o[k]!=="boolean") bad();
    if (o.color!==undefined && !["default","muted","accent","warning"].includes(o.color as string)) bad();
    if (o.link!==undefined) {
      const l=object(o.link);
      if (l.kind==="external") {keys(l,["kind","url"]);url(l.url);}
      else if (l.kind==="internal") {keys(l,["kind","href"]);if (!href(l.href)) bad();}
      else if(l.kind==="unavailable") keys(l,["kind"]);
      else bad();
    }
  }
}
function blocks(x: unknown, depth=0) {
  if (depth>32 || !Array.isArray(x) || x.length>20000) bad();
  for (const v of x) {
    const b=object(v); if (!identity(b.id)) bad();
    const base=["id","type"];
    const check=(extra: string[])=>keys(b,[...base,...extra]);
    switch (b.type) {
      case "paragraph": case "quote": check(["text"]); runs(b.text); break;
      case "heading": check(["text","level"]); runs(b.text); if (![1,2,3].includes(b.level as number)) bad(); break;
      case "list": check(["ordered","items"]); if(typeof b.ordered!=="boolean"||!Array.isArray(b.items)) bad();
        for(const v of b.items){const i=object(v);keys(i,["id","text","checked","children"]);if(!identity(i.id)||!(i.checked===null||typeof i.checked==="boolean"))bad();runs(i.text);blocks(i.children,depth+1);} break;
      case "callout": check(["tone","icon","text","children"]); if(!["default","info","warning"].includes(b.tone as string)||!(b.icon===null||text(b.icon)))bad();runs(b.text);blocks(b.children,depth+1);break;
      case "toggle": check(["title","children"]);runs(b.title);blocks(b.children,depth+1);break;
      case "code": check(["language","code","caption"]);if(!text(b.language)||!text(b.code))bad();runs(b.caption);break;
      case "image": check(["image","caption"]);image(b.image);runs(b.caption);break;
      case "divider": case "table-of-contents": check([]);break;
      case "table": check(["hasColumnHeader","hasRowHeader","rows"]);if(typeof b.hasColumnHeader!=="boolean"||typeof b.hasRowHeader!=="boolean"||!Array.isArray(b.rows))bad();for(const row of b.rows){if(!Array.isArray(row))bad();for(const cell of row)runs(cell);}break;
      case "columns": check(["columns"]);if(!Array.isArray(b.columns))bad();for(const v of b.columns){const c=object(v);keys(c,["ratio","blocks"]);if(!num(c.ratio))bad();blocks(c.blocks,depth+1);}break;
      case "bookmark": check(["title","url","description"]);if(!text(b.title)||!(b.description===null||text(b.description)))bad();url(b.url);break;
      case "embed": check(["title","url","display"]);if(!text(b.title)||b.display!=="link")bad();url(b.url);break;
      case "child-page": check(["title","target"]);if(!text(b.title))bad();if(b.target!==null)link(b.target);break;
      case "equation": check(["expression"]);if(!text(b.expression))bad();break;
      case "unsupported": check(["label"]);if(!text(b.label))bad();break;
      default: bad();
    }
  }
}
export function validateWebsiteRecord(record: WebsiteRecord): void {
  const r=object(record); keys(r,["detail","evidence"]);
  const detail=object(r.detail);keys(detail,["item","document"]);
  const i=object(detail.item), e=object(r.evidence);
  const fields: Record<string,string[]> = {
    status:["recordedAt","text"],course:["code","semester","ratings"],"study-note":["courseId","parentId","noteType","date","breadcrumbs"],
    post:["publishedAt"],album:["date","photoCount"],book:["authors","status","readingDate","pagesRead","totalPages","progressPercent","personalRating","doubanRating","externalUrl"],
    movie:["originalTitle","mediaType","status","watchedDate","releaseDate","director","actors","rating","doubanRating","publicRating","ratingSource"],
    game:["status","platforms","playedDate","lastPlayedDate","firstPlayedDate","archiveDate","releaseDate","playedTime","estimatedTime","progressPercent","rating"],
    project:["period","role","stack","links"],page:["pageKey"]
  };
  const extra=fields[String(i.kind)];if(!extra)bad();
  keys(i,["id","kind","slug","href","title","summary","tags","cover","updatedAt",...extra]);
  if(!identity(i.id)||!identity(i.slug)||!href(i.href)||!text(i.title)||!(i.summary===null||text(i.summary))||!Array.isArray(i.tags)||!i.tags.every(text)||!(i.updatedAt===null||(text(i.updatedAt)&&Number.isFinite(Date.parse(i.updatedAt)))))bad();
  const routes: Record<string,string>={post:"blog",album:"photos",book:"library/books",movie:"library/movies",game:"library/games",project:"projects"};
  const expected=i.kind==="status"?`/status#${i.id}`:i.kind==="course"?`/study/${i.slug}`:i.kind==="study-note"?`/study/${i.courseId}/notes/${i.slug}`:i.kind==="page"?"/about":`/${routes[String(i.kind)]}/${i.slug}`;
  if(i.href!==expected)bad();
  if(i.cover!==null)image(i.cover);
  const strings=(v:unknown)=>{if(!Array.isArray(v)||!v.every(text))bad();};
  const nullable=(v:unknown)=>{if(!(v===null||text(v)))bad();};
  const percentage=(v:unknown)=>{if(!num(v)||(typeof v==="number"&&v>100))bad();};
  const time=(v:unknown)=>{if(v===null)return;const t=object(v);keys(t,["value","unit"]);if(typeof t.value!=="number"||!num(t.value)||!["minute","hour"].includes(String(t.unit)))bad();};
  switch(i.kind){
    case "status":date(i.recordedAt);runs(i.text);break;
    case "course":if(!text(i.code))bad();nullable(i.semester);{const rs=object(i.ratings);keys(rs,["experience","usefulness","recommendation","difficulty"]);for(const k of ["experience","usefulness","recommendation","difficulty"])rating(rs[k]);}break;
    case "study-note":if(!identity(i.courseId)||!(i.parentId===null||identity(i.parentId))||!["course","assignment","summary","note","quiz","test","textbook","tool","unknown"].includes(String(i.noteType))||!Array.isArray(i.breadcrumbs))bad();date(i.date);i.breadcrumbs.forEach(link);break;
    case "post":date(i.publishedAt);break;
    case "album":date(i.date);if(!num(i.photoCount)||(typeof i.photoCount==="number"&&!Number.isInteger(i.photoCount)))bad();break;
    case "book":strings(i.authors);if(!["reading","read","wishlist","given-up","unknown"].includes(String(i.status)))bad();date(i.readingDate);for(const k of ["pagesRead","totalPages","doubanRating"])if(!num(i[k]))bad();percentage(i.progressPercent);rating(i.personalRating);if(i.externalUrl!==null)url(i.externalUrl);break;
    case "movie":nullable(i.originalTitle);nullable(i.mediaType);nullable(i.director);strings(i.actors);if(!["watched","wishlist","unknown"].includes(String(i.status)))bad();date(i.watchedDate);date(i.releaseDate);rating(i.rating);if(!num(i.doubanRating))bad();if(i.publicRating!==undefined&&!isMoviePublicRating(i.publicRating))bad();if(i.ratingSource!==undefined&&!isMovieRatingSource(i.ratingSource))bad();break;
    case "game":strings(i.platforms);if(!["clear","platinumed","playing","wishlist","unknown"].includes(String(i.status)))bad();date(i.playedDate);if(i.lastPlayedDate!==undefined)date(i.lastPlayedDate);for(const k of ["firstPlayedDate","archiveDate"])if(i[k]!==undefined)playDay(i[k]);date(i.releaseDate);time(i.playedTime);time(i.estimatedTime);percentage(i.progressPercent);rating(i.rating);break;
    case "project":date(i.period);nullable(i.role);strings(i.stack);if(!Array.isArray(i.links))bad();for(const v of i.links){const l=object(v);keys(l,["label","url"]);if(!text(l.label))bad();url(l.url);}break;
    case "page":if(i.slug!=="about"||i.pageKey!=="about"||i.cover!==null)bad();break;
    default:bad();
  }
  keys(e,["sourceKey","dataSourceId","databaseParentId","courseId","parentId","ordinal"]);
  if(!text(e.sourceKey)||e.sourceKey.length<1||e.sourceKey.length>128||/[\u0000-\u001f\u007f]/.test(e.sourceKey)||!Number.isInteger(e.ordinal)||(e.ordinal as number)<0)bad();
  for(const k of ["dataSourceId","databaseParentId","courseId","parentId"])if(!(e[k]===null||identity(e[k])))bad();
  if(detail.document!==null){const d=object(detail.document);keys(d,["blocks","toc","completeness"]);if(!["complete","partial"].includes(d.completeness as string)||!Array.isArray(d.toc))bad();blocks(d.blocks);for(const v of d.toc){const t=object(v);keys(t,["id","title","level"]);if(!identity(t.id)||!text(t.title)||![1,2,3].includes(t.level as number))bad();}}
  if(Buffer.byteLength(JSON.stringify(r))>8*1024*1024)bad();
}
export function validateMedia(x: StoredMedia): void {
  const m=object(x);keys(m,["assetId","ownerPageId","objectKey","sha256","byteSize","mime","width","height"]);
  if(typeof m.assetId!=="string"||!/^a1\.[a-f0-9]{64}$/.test(m.assetId)||!identity(m.ownerPageId)||typeof m.sha256!=="string"||!/^[a-f0-9]{64}$/.test(m.sha256)||m.objectKey!==`sha256/${m.sha256}`||!Number.isInteger(m.byteSize)||(m.byteSize as number)<1||(m.byteSize as number)>20*1024*1024||!["image/jpeg","image/png","image/webp","image/gif","image/avif"].includes(m.mime as string)||!num(m.width)||!num(m.height))bad();
}
