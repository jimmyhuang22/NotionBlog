import { createHash } from "node:crypto";
import type { StoredMedia, SyncRecord } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { isNotionPageHost, isTemporaryMediaUrl } from "../notion/public-text.ts";

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
  return typeof x === "string" && /^\/(?:status#[a-zA-Z0-9_-]+|study\/[a-zA-Z0-9_-]+(?:\/notes\/[a-zA-Z0-9_-]+)?)$/.test(x);
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
function rating(x: unknown) {
  if (x===null) return;
  const o=object(x); keys(o,["value","scale","label"]);
  if (!num(o.value)||!num(o.scale)||!text(o.label)) bad();
}
function image(x: unknown) {
  const o=object(x); keys(o,["id","src","alt","width","height"]);
  if (typeof o.id!=="string" || !/^a1\.[a-f0-9]{64}$/.test(o.id) || o.src!==`/media/${o.id}` || !text(o.alt) || !num(o.width) || !num(o.height)) bad();
}
function link(x: unknown) {
  const o=object(x); keys(o,["title","href"]); if (!text(o.title)||!href(o.href)) bad();
}
function runs(x: unknown) {
  if (!Array.isArray(x)) bad();
  for (const v of x) {
    const o=object(v); keys(o,["text","bold","italic","code","underline","strike","color","link"]);
    if (!text(o.text)) bad();
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
export function validateSyncRecord(record: SyncRecord): void {
  const r=object(record); keys(r,["detail","evidence"]);
  const detail=object(r.detail);keys(detail,["item","document"]);
  const i=object(detail.item), e=object(r.evidence);
  const extra=i.kind==="status"?["recordedAt","text"]:i.kind==="course"?["code","semester","ratings"]:i.kind==="study-note"?["courseId","parentId","noteType","date","breadcrumbs"]:bad();
  keys(i,["id","kind","slug","href","title","summary","tags","cover","updatedAt",...extra]);
  if(!identity(i.id)||!identity(i.slug)||!href(i.href)||!text(i.title)||!(i.summary===null||text(i.summary))||!Array.isArray(i.tags)||!i.tags.every(text)||!(i.updatedAt===null||(text(i.updatedAt)&&Number.isFinite(Date.parse(i.updatedAt)))))bad();
  const expected=i.kind==="status"?`/status#${i.id}`:i.kind==="course"?`/study/${i.slug}`:`/study/${i.courseId}/notes/${i.slug}`;
  if(i.href!==expected)bad();
  if(i.cover!==null)image(i.cover);
  if(i.kind==="status"){date(i.recordedAt);runs(i.text);}
  else if(i.kind==="course"){if(!(i.code===null||text(i.code))||!(i.semester===null||text(i.semester)))bad();const rs=object(i.ratings);keys(rs,["experience","usefulness","recommendation","difficulty"]);for(const k of ["experience","usefulness","recommendation","difficulty"])rating(rs[k]);}
  else {if(!identity(i.courseId)||!(i.parentId===null||identity(i.parentId))||!["course","assignment","summary","note","quiz","test","textbook","tool","unknown"].includes(i.noteType as string)||!Array.isArray(i.breadcrumbs))bad();date(i.date);i.breadcrumbs.forEach(link);}
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
