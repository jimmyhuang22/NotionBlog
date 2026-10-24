import { rewriteStudyLinks } from "./rewrite-study-links.ts";
import type { ContentDocument, Course, CourseTree, StudyNote } from "../../../contracts/content.ts";
import type { WebsiteRecord } from "../../../contracts/website-sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { canonicalJson, configDigest, validateWebsiteRecord } from "../database/website-validation.ts";
import { normalizeId } from "./config.ts";
import { studyPreorder, studyTree } from "./study-order.ts";

/** Private worker state; numeric overrides never enter frontend DTOs. */
export interface StudyEntry { record:WebsiteRecord; override:number|null; position:number|null }
export interface StudyCheckpoint { version:string; sourceDigest:string; entries:StudyEntry[] }
export interface StudyReadOptions { document:boolean; children:boolean }
export type StudyObservation = { state:"withdrawn"; reason:"archived"|"deleted"|"out-of-scope"|"denied" } | {
  state:"active"; entry:StudyEntry; ancestors:string[];
  children?:{id:string;position:number;updatedAt:string|null}[];
};
/** A fresh source per operation. Missing/unknown pages throw, not tombstone. */
export interface StudyChangeSource {
  sourceDigest:string;
  /** Share metadata/body reads only inside one delta, never between batches. */
  openOperation?():StudyChangeSource;
  read(id:string,options:StudyReadOptions):Promise<StudyObservation>;
}
export interface StudyDelta {
  baseVersion:string; sourceDigest:string; idempotencyKey:string;
  upserts:StudyEntry[]; withdrawals:string[];
  /** Confirmed roots only; descendants inherit withdrawal in the atomic store.
   * Deny is a policy operation, never disguised as a Notion deletion. */
  withdrawalEvidence:{id:string;sourceKey:string;reason:"archived"|"deleted"|"out-of-scope"|"denied"}[];
  hrefChanges:{previous:string;current:{href:string;title:string}|null}[];
  directories:{courseId:string;tree:CourseTree|null;pages:number;maxDepth:number}[];
  reads:number;
}
export interface StudyDeltaStore {
  /** Local private cache plus a bounded server version proof, not a remote
   * full-body snapshot on every event. Caller holds the existing sync mutex. */
  loadLocal():Promise<StudyCheckpoint>;
  /** Atomically compare version/scope, enforce current deny, apply all changes
   * including incoming links outside study, and return its committed version.
   * A failed/unknown commit must not acknowledge events or advance state. */
  commit(delta:StudyDelta):Promise<{version:string}>;
  /** Atomic local file replacement only after confirmed remote commit.
   * Failure leaves events unacknowledged; recover by the commit's idempotency
   * key/journal, never by replaying a full content publication. */
  saveLocal(checkpoint:StudyCheckpoint):Promise<void>;
}
function bad():never {throw new ContentServiceError("CONTENT_UNAVAILABLE","Study changes could not be completely verified.");}
const item=(e:StudyEntry)=>e.record.detail.item as Course|StudyNote;
const course=(e:StudyEntry)=>item(e).kind==="course"?item(e).id:(item(e) as StudyNote).courseId;
const parent=(e:StudyEntry)=>e.record.evidence.parentId;
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function complete(doc:ContentDocument|null) {
  if(!doc)bad();
  const visit=(value:unknown)=>{
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(!value||typeof value!=="object")return;
    const x=value as Record<string,unknown>;
    if(x.type==="unsupported"&&["Content block limit reached","Content nesting limit reached","Content belongs to a different parent","Repeated content block omitted","Image unavailable"].includes(String(x.label)))bad();
    Object.values(x).forEach(visit);
  };visit(doc);
}
function index(state:StudyCheckpoint):Map<string,StudyEntry> {
  if(!/^[A-Za-z0-9:._-]{1,160}$/.test(state.version)||!/^[a-f0-9]{64}$/.test(state.sourceDigest)||!Array.isArray(state.entries)||state.entries.length>20000)bad();
  if(Buffer.byteLength(JSON.stringify(state))>16*1024*1024)bad();
  const result=new Map<string,StudyEntry>();
  for(const e of state.entries){
    const i=item(e);if(!["course","study-note"].includes(i.kind)||normalizeId(i.id)!==i.id||result.has(i.id))bad();
    if(e.override!==null&&!Number.isFinite(e.override))bad();
    if(e.position!==null&&(!Number.isSafeInteger(e.position)||e.position<0))bad();
    validateWebsiteRecord(e.record);complete(e.record.detail.document);result.set(i.id,e);
  }
  for(const e of result.values()){
    const i=item(e),p=parent(e);
    if(i.kind==="course"){if(p!==null||e.record.evidence.courseId!==null)bad();continue;}
    const root=result.get(i.courseId),owner=p?result.get(p):undefined;
    if(!root||item(root).kind!=="course"||!owner||course(owner)!==i.courseId||e.record.evidence.courseId!==i.courseId||
        i.parentId!==(p===i.courseId?null:p))bad();
  }
  for(const e of result.values())if(item(e).kind==="course")studyPreorder([...result.values()].filter(n=>item(n).kind==="study-note"&&course(n)===item(e).id).map(n=>({item:item(n) as StudyNote,override:n.override,bodyPosition:n.position??undefined})));
  return result;
}

/** Signals have no authority to delete/publish: read the current source first.
 * Bodies are read only for signalled/new/changed pages; dependent metadata and
 * stored AST links are updated without downloading their bodies or media. */
export async function prepareStudyDelta(checkpoint:StudyCheckpoint,pageIds:string[],source:StudyChangeSource,maxReads=200):Promise<StudyDelta> {
  const before=index(checkpoint);
  if(source.sourceDigest!==checkpoint.sourceDigest)throw new ContentServiceError("MISCONFIGURED","Study source scope changed; a new baseline is required.");
  if(!Number.isInteger(maxReads)||maxReads<1||maxReads>2000||!Array.isArray(pageIds)||pageIds.length>maxReads)bad();
  source=source.openOperation?.()??source;
  if(source.sourceDigest!==checkpoint.sourceDigest)bad();
  const current=new Map([...before].map(([id,e])=>[id,structuredClone(e)]));
  const queue=new Map<string,StudyReadOptions>(),done=new Map<string,StudyReadOptions>();
  const childLists=new Map<string,NonNullable<Extract<StudyObservation,{state:"active"}>["children"]>>();
  const removed=new Set<string>(),directlyWithdrawn=new Set<string>();
  const withdrawalReasons=new Map<string,StudyDelta["withdrawalEvidence"][number]["reason"]>();let reads=0;
  const enqueue=(value:string,document:boolean,children:boolean)=>{
    const id=normalizeId(value),completed=done.get(id);
    if(completed&&(!document||completed.document)&&(!children||completed.children))return;
    const pending=queue.get(id);queue.set(id,{document:document||pending?.document===true,children:children||pending?.children===true});
  };
  const descendants=(id:string)=>{
    const children=new Map<string,string[]>();
    for(const [key,e] of current){const p=parent(e);if(p!==null)children.set(p,[...(children.get(p)??[]),key]);}
    const ids:string[]=[],pending=[id],seen=new Set<string>();
    for(let cursor=0;cursor<pending.length;cursor++){const p=pending[cursor];if(seen.has(p))bad();seen.add(p);for(const key of children.get(p)??[]){ids.push(key);pending.push(key);}}
    return ids;
  };
  for(const id of pageIds)enqueue(id,true,true);
  while(queue.size){
    const [id,options]=queue.entries().next().value!;queue.delete(id);
    if(removed.has(id))continue;
    if(++reads>maxReads)throw new ContentServiceError("CONTENT_UNAVAILABLE","Study change read budget reached.");
    const observation=await source.read(id,options);done.set(id,{document:options.document||done.get(id)?.document===true,children:options.children||done.get(id)?.children===true});
    if(observation.state==="withdrawn"){
      if(!["archived","deleted","out-of-scope","denied"].includes(observation.reason))bad();
      directlyWithdrawn.add(id);
      if(before.has(id))withdrawalReasons.set(id,observation.reason);
      for(const key of [id,...descendants(id)]){
        const pending=queue.has(key)&&key!==id;
        current.delete(key);childLists.delete(key);
        // An independently signalled descendant may already have moved to a
        // different approved parent. Its fresh read decides; an old tree cannot
        // suppress that signal or grant the moved page publication by itself.
        if(!pending){removed.add(key);queue.delete(key);}
      }
      continue;
    }
    if(observation.state!=="active"||item(observation.entry).id!==id)bad();
    const previous=current.get(id)??before.get(id),next=structuredClone(observation.entry);
    if(previous&&parent(previous)===parent(next))next.position=previous.position;
    if(previous&&item(next).kind==="course")next.record.evidence.ordinal=previous.record.evidence.ordinal;
    if(!options.document){
      if(!previous){enqueue(id,true,true);continue;}
      // A dependent page can itself have changed while a parent/move signal is
      // being handled. Never pair its new metadata with an old cached body.
      if(item(next).updatedAt===null||item(next).updatedAt!==item(previous).updatedAt){enqueue(id,true,true);continue;}
      next.record.detail.document=previous.record.detail.document;next.record.detail.item.cover=previous.record.detail.item.cover;
    }else complete(next.record.detail.document);
    validateWebsiteRecord(next.record);
    if(!observation.ancestors.every(a=>normalizeId(a)===a)||observation.ancestors.length>24||observation.ancestors.includes(id))bad();
    const expected=parent(next);
    if((expected===null&&observation.ancestors.length)||(expected!==null&&observation.ancestors.at(-1)!==expected))bad();
    current.set(id,next);
    for(const ancestor of observation.ancestors)if(!current.has(ancestor)){
      if(!directlyWithdrawn.has(ancestor))removed.delete(ancestor);
      enqueue(ancestor,true,true);
    }
    if(!previous||parent(previous)!==parent(next)||course(previous)!==course(next)){
      if(parent(next)!==null)enqueue(parent(next)!,false,true);
      if(previous&&parent(previous)!==null)enqueue(parent(previous)!,false,true);
    }
    if(previous&&(item(previous).title!==item(next).title||parent(previous)!==parent(next)||course(previous)!==course(next)))for(const dependent of descendants(id))enqueue(dependent,false,false);
    if(options.children){
      if(!Array.isArray(observation.children)||observation.children.length>20000)bad();
      const children=observation.children,seen=new Set<string>();
      for(const child of children){
        if(normalizeId(child.id)!==child.id||seen.has(child.id)||child.id===id||!Number.isSafeInteger(child.position)||child.position<0)bad();seen.add(child.id);
        if(!directlyWithdrawn.has(child.id))removed.delete(child.id);
        const existing=current.get(child.id);
        if(!existing||parent(existing)!==id||child.updatedAt===null||item(existing).updatedAt!==child.updatedAt)enqueue(child.id,true,true);
      }
      for(const [key,e] of current)if(parent(e)===id&&!seen.has(key))enqueue(key,false,false);
      childLists.set(id,children);
    }
  }
  // Apply only after all moves have been read; stale old-parent lists must not
  // overwrite a new parent's position or silently drop an unresolved child.
  for(const [id,children] of childLists){
    if(!current.has(id))continue;
    const listed=new Set(children.map(c=>c.id));
    for(const child of children){const e=current.get(child.id);if(!e||parent(e)!==id)bad();e.position=child.position;}
    for(const [key,e] of current)if(parent(e)===id&&!listed.has(key))bad();
  }
  const hrefChanges:StudyDelta["hrefChanges"]=[];
  for(const [id,e] of before){const updated=current.get(id);if(!updated||item(updated).href!==item(e).href||item(updated).title!==item(e).title)hrefChanges.push({previous:item(e).href,current:updated?{href:item(updated).href,title:item(updated).title}:null});}
  const links=new Map(hrefChanges.map(c=>[c.previous,c.current]));
  for(const e of current.values())e.record.detail=rewriteStudyLinks(e.record.detail,links) as typeof e.record.detail;
  const courses=new Set<string>();
  for(const [id,e] of before)if(!current.has(id)||!equal(e,current.get(id)))courses.add(course(e));
  for(const [id,e] of current)if(!before.has(id)||!equal(e,before.get(id)))courses.add(course(e));
  const directories:StudyDelta["directories"]=[];
  for(const id of [...courses].sort()){
    const root=current.get(id);if(!root){directories.push({courseId:id,tree:null,pages:0,maxDepth:0});continue;}
    const notes=studyPreorder([...current.values()].filter(e=>item(e).kind==="study-note"&&course(e)===id).map(e=>({item:item(e) as StudyNote,override:e.override,bodyPosition:e.position??undefined})));
    for(const [ordinal,note] of notes.entries())current.get(note.id)!.record.evidence.ordinal=ordinal;
    const tree=studyTree(notes,id)!;
    const depth=(nodes:CourseTree["nodes"],level=1):number=>nodes.reduce((m,n)=>Math.max(m,level,depth(n.children??[],level+1)),0);
    directories.push({courseId:id,tree,pages:notes.length,maxDepth:depth(tree.nodes)});
  }
  index({...checkpoint,entries:[...current.values()]});
  const changed=[...current].filter(([id,e])=>!equal(e,before.get(id))).map(([,e])=>e);
  const changedIds=new Set(changed.map(e=>item(e).id)),emitted=new Set<string>(),upserts:StudyEntry[]=[];
  let pending=changed;
  while(pending.length){
    const next:StudyEntry[]=[];
    for(const e of pending){const p=parent(e);if(p!==null&&changedIds.has(p)&&!emitted.has(p)){next.push(e);continue;}upserts.push(e);emitted.add(item(e).id);}
    if(next.length===pending.length)bad();pending=next;
  }
  const withdrawals=[...before.keys()].filter(id=>!current.has(id)).sort();
  const withdrawalEvidence=[...withdrawalReasons].filter(([id])=>!current.has(id)).sort(([a],[b])=>a.localeCompare(b)).map(([id,reason])=>({id,sourceKey:before.get(id)!.record.evidence.sourceKey,reason}));
  const payload={baseVersion:checkpoint.version,sourceDigest:checkpoint.sourceDigest,upserts,withdrawals,withdrawalEvidence,hrefChanges,directories};
  return {...payload,idempotencyKey:configDigest(payload),reads};
}

/** Build the private ordering sidecar from a complete, currently authorised
 * publication. Reuse its bodies/media; metadata drift requires a fresh baseline
 * instead of pairing a new timestamp with an old document. */
export async function captureStudyCheckpoint(version:string,records:WebsiteRecord[],source:StudyChangeSource,maxReads=2000):Promise<StudyCheckpoint> {
  if(!Number.isInteger(maxReads)||maxReads<1||maxReads>20000||!Array.isArray(records)||records.length>maxReads)bad();
  index({version,sourceDigest:source.sourceDigest,entries:records.map(record=>({record,override:null,position:record.detail.item.kind==="study-note"?record.evidence.ordinal:null}))});
  source=source.openOperation?.()??source;
  const entries:StudyEntry[]=[];
  for(const record of records){
    if(!["course","study-note"].includes(record.detail.item.kind))bad();
    validateWebsiteRecord(record);complete(record.detail.document);
    const observation=await source.read(record.detail.item.id,{document:false,children:false});
    if(observation.state!=="active")bad();
    const entry=structuredClone(observation.entry);
    entry.record.detail.item.cover=record.detail.item.cover;
    entry.record.detail.document=record.detail.document;
    entry.record.evidence.ordinal=record.evidence.ordinal;
    if(record.detail.item.updatedAt===null||!equal(entry.record,record))bad();
    entry.position=record.detail.item.kind==="study-note"?record.evidence.ordinal:null;
    entries.push(entry);
  }
  const checkpoint={version,sourceDigest:source.sourceDigest,entries};index(checkpoint);return checkpoint;
}

export async function syncStudyChanges(store:StudyDeltaStore,source:StudyChangeSource,pageIds:string[],maxReads=200) {
  const checkpoint=await store.loadLocal(),delta=await prepareStudyDelta(checkpoint,pageIds,source,maxReads);
  if(!delta.upserts.length&&!delta.withdrawals.length)return {outcome:"unchanged" as const,version:checkpoint.version,delta};
  const receipt=await store.commit(delta);
  if(!receipt||typeof receipt.version!=="string"||!/^[A-Za-z0-9:._-]{1,160}$/.test(receipt.version)||receipt.version===checkpoint.version)bad();
  const next=applyStudyDelta(checkpoint,delta,receipt.version);await store.saveLocal(next);
  return {outcome:"committed" as const,version:receipt.version,delta};
}

/** Worker-only validation/application, reused by durable preparation and recovery. */
export function validateStudyCheckpoint(checkpoint:StudyCheckpoint):void {index(checkpoint);}
export function applyStudyDelta(checkpoint:StudyCheckpoint,delta:StudyDelta,version:string):StudyCheckpoint {
  const entries=index(checkpoint);
  if(delta.baseVersion!==checkpoint.version||delta.sourceDigest!==checkpoint.sourceDigest)bad();
  const {baseVersion,sourceDigest,upserts,withdrawals,withdrawalEvidence,hrefChanges,directories}=delta;
  if(configDigest({baseVersion,sourceDigest,upserts,withdrawals,withdrawalEvidence,hrefChanges,directories})!==delta.idempotencyKey)bad();
  const removed=new Set<string>(),updated=new Set<string>();
  for(const id of withdrawals){if(removed.has(id)||!entries.has(id))bad();removed.add(id);}
  for(const e of upserts){const id=item(e).id;if(updated.has(id)||removed.has(id))bad();updated.add(id);}
  const children=new Map<string,string[]>(),covered=new Set<string>(),roots=new Set<string>();
  for(const [id,e] of entries){const p=parent(e);if(p!==null)children.set(p,[...(children.get(p)??[]),id]);}
  for(const proof of withdrawalEvidence){
    if(roots.has(proof.id)||!entries.has(proof.id)||entries.get(proof.id)!.record.evidence.sourceKey!==proof.sourceKey||updated.has(proof.id)||!["archived","deleted","out-of-scope","denied"].includes(proof.reason))bad();
    roots.add(proof.id);const pending=[proof.id];
    for(let cursor=0;cursor<pending.length;cursor++){const id=pending[cursor];if(covered.has(id))continue;covered.add(id);pending.push(...children.get(id)??[]);}
  }
  if([...removed].some(id=>!covered.has(id))||[...covered].some(id=>!updated.has(id)&&!removed.has(id)))bad();
  removed.forEach(id=>entries.delete(id));upserts.forEach(e=>entries.set(item(e).id,e));
  const next={...checkpoint,version,entries:[...entries.values()]};index(next);return structuredClone(next);
}
