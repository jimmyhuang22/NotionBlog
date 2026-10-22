import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import type { PreparedPublicationDelta } from "../../src/server/database/incremental-publication.ts";
import { preparePublicationDelta } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson, configDigest } from "../../src/server/database/website-validation.ts";
import { applyStudyDelta, validateStudyCheckpoint, type StudyCheckpoint, type StudyDelta } from "../../src/server/notion/study-incremental.ts";
import { privateDirectory } from "../notion-sync/state.ts";

const APPLICATION_ID=0x4e425343,MAX_BYTES=64*1024*1024;
export class StudyCheckpointError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name="StudyCheckpointError";this.code=code;}
}
export interface StudyVerifiedCommit {operationId:string;payloadDigest:string;publicationRevision:string;readerVerified:true}
export interface StudyBaselineProof {publicationRevision:string;configDigest:string;readerVerified:true}
function fail(code="STUDY_CHECKPOINT_INVALID"):never{throw new StudyCheckpointError(code);}
const uuid=(v:string)=>typeof v==="string"&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=(v:string)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const version=(v:string)=>typeof v==="string"&&v.split(":").length===2&&uuid(v.split(":")[0])&&/^[0-9]+$/.test(v.split(":")[1]);
function valid(state:StudyCheckpoint,digest:string){
  if(!state||!version(state.version)||state.sourceDigest!==digest)fail("STUDY_CHECKPOINT_SCOPE_MISMATCH");
  try{validateStudyCheckpoint(state);}catch{fail();}
}
function safe(error:unknown):never{
  if(error instanceof StudyCheckpointError)throw error;
  fail((error as {errcode?:number}|null)?.errcode===5?"STUDY_CHECKPOINT_BUSY":"STUDY_CHECKPOINT_UNAVAILABLE");
}
const SCHEMA=`
 CREATE TABLE scope(digest TEXT NOT NULL) STRICT;
 CREATE TABLE checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
 CREATE TABLE operations(id TEXT PRIMARY KEY,base TEXT NOT NULL,payload_digest TEXT NOT NULL,request_digest TEXT NOT NULL,
   next TEXT,next_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('prepared','applied','retired')),
   committed_revision TEXT,installed_digest TEXT) STRICT;
`;
type Row=Record<string,string|number|null>;

/** Private domain state; no source/cloud access and no queue acknowledgement. */
export class StudyCheckpointStore {
  readonly sourceDigest:string;
  private db:sqlite.DatabaseSync;
  constructor(db:sqlite.DatabaseSync,digest:string){
    if(!hash(digest))fail();
    this.db=db;this.sourceDigest=digest;
    const initialApp=Number(db.prepare("PRAGMA application_id").get()!.application_id),initialVersion=Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if(initialApp===0&&initialVersion===0){
      if(Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n))fail("STUDY_CHECKPOINT_SCHEMA_MISMATCH");
    }else{
      if(initialApp!==APPLICATION_ID||initialVersion!==1)fail("STUDY_CHECKPOINT_SCHEMA_MISMATCH");
      if(db.prepare("SELECT digest FROM scope").get()?.digest!==digest)fail("STUDY_CHECKPOINT_SCOPE_MISMATCH");
    }
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=32768;");
    this.transaction(()=>{
      const app=Number(db.prepare("PRAGMA application_id").get()!.application_id),v=Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if(app===0&&v===0){
        if(Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n))fail("STUDY_CHECKPOINT_SCHEMA_MISMATCH");
        db.exec(SCHEMA);db.prepare("INSERT INTO scope VALUES(?)").run(digest);
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`);
      }else if(app!==APPLICATION_ID||v!==1)fail("STUDY_CHECKPOINT_SCHEMA_MISMATCH");
      if(db.prepare("SELECT digest FROM scope").get()?.digest!==digest)fail("STUDY_CHECKPOINT_SCOPE_MISMATCH");
    });
  }
  close(){this.db.close();}
  private transaction<T>(fn:()=>T):T{
    try{this.db.exec("BEGIN IMMEDIATE");}catch(e){safe(e);}
    try{const result=fn();this.db.exec("COMMIT");return result;}catch(e){this.db.exec("ROLLBACK");safe(e);}
  }
  private current():StudyCheckpoint{
    const row=this.db.prepare("SELECT value,digest FROM checkpoint WHERE singleton=1").get();
    if(!row)fail("STUDY_CHECKPOINT_MISSING");
    const value=JSON.parse(String(row.value)) as StudyCheckpoint;
    valid(value,this.sourceDigest);if(configDigest(value)!==row.digest)fail();return value;
  }
  load():StudyCheckpoint{try{return this.current();}catch(e){safe(e);}}
  ownsOperation(operationId:string,payloadDigest:string):boolean{
    if(!uuid(operationId)||!hash(payloadDigest))fail();
    try{const row=this.db.prepare("SELECT payload_digest FROM operations WHERE id=?").get(operationId);
      if(row&&row.payload_digest!==payloadDigest)fail("STUDY_OPERATION_CONFLICT");return Boolean(row);
    }catch(e){safe(e);}
  }
  /** Called only from a complete verified private baseline, never a public DTO. */
  initialize(state:StudyCheckpoint,proof:StudyBaselineProof):void{
    valid(state,this.sourceDigest);
    if(proof?.readerVerified!==true||proof.publicationRevision!==state.version||proof.configDigest!==this.sourceDigest)fail("STUDY_READER_UNVERIFIED");
    this.transaction(()=>{
      if(this.db.prepare("SELECT singleton FROM checkpoint").get()){
        if(canonicalJson(this.current())===canonicalJson(state))return;
        fail("STUDY_CHECKPOINT_ALREADY_INITIALIZED");
      }
      this.db.prepare("INSERT INTO checkpoint VALUES(1,?,?)").run(JSON.stringify(state),configDigest(state));
    });
  }
  /** Durable next state BEFORE the public executor marks/sends its submission. */
  stage(operationId:string,study:StudyDelta,publication:PreparedPublicationDelta):void{
    if(!uuid(operationId))fail();
    let prepared:PreparedPublicationDelta;
    try{prepared=preparePublicationDelta(publication);}catch{fail("STUDY_PREPARED_DELTA_INVALID");}
    if(prepared.payloadDigest!==publication.payloadDigest||prepared.expectedRevision!==study.baseVersion||prepared.configDigest!==this.sourceDigest)fail("STUDY_PREPARED_DELTA_INVALID");
    this.transaction(()=>{
      const before=this.current();if(before.version!==study.baseVersion)fail("STUDY_CHECKPOINT_VERSION_CHANGED");
      const published=new Map(prepared.upserts.map(r=>[r.detail.item.id,r]));
      const changed=new Set(study.upserts.map(e=>e.record.detail.item.id));
      if(prepared.upserts.some(r=>["course","study-note"].includes(r.detail.item.kind)&&!changed.has(r.detail.item.id)))fail("STUDY_PREPARED_DELTA_INVALID");
      for(const e of study.upserts)if(canonicalJson(published.get(e.record.detail.item.id))!==canonicalJson(e.record))fail("STUDY_PREPARED_DELTA_INVALID");
      if(study.withdrawalEvidence.some(w=>w.reason==="denied")||canonicalJson(prepared.withdrawals)!==canonicalJson(study.withdrawalEvidence))fail("STUDY_PREPARED_DELTA_INVALID");
      let next:StudyCheckpoint;try{next=applyStudyDelta(before,study,before.version);}catch{fail("STUDY_PREPARED_DELTA_INVALID");}valid(next,this.sourceDigest);
      this.stageNext(operationId,before,prepared,next);
    });
  }
  /** Observe other domains before submission so their global revision does not
   * strand study state. Only existing study AST/in-link edits may be included. */
  stageOtherPublication(operationId:string,publication:PreparedPublicationDelta):void{
    if(!uuid(operationId))fail();
    let prepared:PreparedPublicationDelta;
    try{prepared=preparePublicationDelta(publication);}catch{fail("STUDY_PREPARED_DELTA_INVALID");}
    if(prepared.payloadDigest!==publication.payloadDigest||prepared.configDigest!==this.sourceDigest)fail("STUDY_PREPARED_DELTA_INVALID");
    this.transaction(()=>{
      const before=this.current();if(before.version!==prepared.expectedRevision)fail("STUDY_CHECKPOINT_VERSION_CHANGED");
      const entries=new Map(before.entries.map(e=>[e.record.detail.item.id,e]));
      if(!prepared.upserts.some(r=>!["course","study-note"].includes(r.detail.item.kind))&&!prepared.withdrawals.some(w=>!entries.has(w.id)))fail("STUDY_EXTERNAL_DELTA_REQUIRES_RECONCILIATION");
      for(const record of prepared.upserts){
        const old=entries.get(record.detail.item.id),study=["course","study-note"].includes(record.detail.item.kind);
        if(study||old){
          if(!old||!study||canonicalJson(old.record.detail.item)!==canonicalJson(record.detail.item)||canonicalJson(old.record.evidence)!==canonicalJson(record.evidence))fail("STUDY_EXTERNAL_DELTA_REQUIRES_RECONCILIATION");
          entries.set(record.detail.item.id,{...old,record});
        }
      }
      if(prepared.withdrawals.some(w=>entries.has(w.id)))fail("STUDY_EXTERNAL_DELTA_REQUIRES_RECONCILIATION");
      const next={...before,entries:[...entries.values()]};valid(next,this.sourceDigest);
      this.stageNext(operationId,before,prepared,next);
    });
  }
  private stageNext(operationId:string,before:StudyCheckpoint,prepared:PreparedPublicationDelta,next:StudyCheckpoint){
      const nextText=JSON.stringify(next),nextDigest=configDigest(next),requestDigest=configDigest(prepared);
      const old=this.db.prepare("SELECT * FROM operations WHERE id=?").get(operationId) as Row|undefined;
      if(old){
        if(old.status!=="prepared"||old.base!==before.version||old.payload_digest!==prepared.payloadDigest||old.request_digest!==requestDigest||old.next_digest!==nextDigest)fail("STUDY_OPERATION_CONFLICT");
        return;
      }
      const counts=this.db.prepare("SELECT count(*) AS total,sum(status='prepared') AS pending,coalesce(sum(length(CAST(next AS BLOB))),0) AS bytes FROM operations").get()!;
      if(Number(counts.total)>=10000||Number(counts.pending)>=8||Number(counts.bytes)+Buffer.byteLength(nextText)>MAX_BYTES)fail("STUDY_CHECKPOINT_BUDGET_REACHED");
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,'prepared',NULL,NULL)").run(operationId,before.version,prepared.payloadDigest,requestDigest,nextText,nextDigest);
  }
  /** Only the queue owner can prove an attempt was never sent or explicitly
   * rejected. Timeout, expired lease and lookup(null) are not such evidence. */
  retirePrepared(operationId:string,payloadDigest:string|null,proof:{neverSubmitted:true}|{definitivelyRejected:true}):void{
    const neverSubmitted=proof&&"neverSubmitted" in proof&&proof.neverSubmitted===true;
    if(!uuid(operationId)||!(hash(payloadDigest as string)||payloadDigest===null&&neverSubmitted)||(!neverSubmitted&&!(proof&&"definitivelyRejected" in proof&&proof.definitivelyRejected===true)))fail("STUDY_OPERATION_UNCONFIRMED");
    this.transaction(()=>{
      const row=this.db.prepare("SELECT status,payload_digest FROM operations WHERE id=?").get(operationId);
      if(!row)return;
      if(payloadDigest!==null&&row.payload_digest!==payloadDigest)fail("STUDY_OPERATION_CONFLICT");
      if(row.status==="applied")fail("STUDY_OPERATION_CONFLICT");
      this.db.prepare("UPDATE operations SET status='retired',next=NULL WHERE id=?").run(operationId);
    });
  }
  /** The caller must have independently verified this exact current receipt. */
  install(proof:StudyVerifiedCommit):"installed"|"unchanged"{
    if(proof?.readerVerified!==true||!uuid(proof.operationId)||!hash(proof.payloadDigest)||!version(proof.publicationRevision))fail("STUDY_READER_UNVERIFIED");
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM operations WHERE id=?").get(proof.operationId) as Row|undefined;
      if(!row)fail("STUDY_OPERATION_MISSING");
      if(row.payload_digest!==proof.payloadDigest)fail("STUDY_OPERATION_CONFLICT");
      if(row.status==="retired")fail("STUDY_OPERATION_RETIRED");
      const current=this.current();
      if(row.status==="applied"){
        if(row.committed_revision!==proof.publicationRevision||current.version!==proof.publicationRevision||configDigest(current)!==row.installed_digest)fail("STUDY_CHECKPOINT_VERSION_CHANGED");
        return "unchanged";
      }
      if(row.base!==current.version||proof.publicationRevision===current.version)fail("STUDY_CHECKPOINT_VERSION_CHANGED");
      const next=JSON.parse(String(row.next)) as StudyCheckpoint;valid(next,this.sourceDigest);
      if(next.version!==current.version||configDigest(next)!==row.next_digest)fail();
      next.version=proof.publicationRevision;valid(next,this.sourceDigest);const installed=configDigest(next);
      this.db.prepare("UPDATE checkpoint SET value=?,digest=? WHERE singleton=1").run(JSON.stringify(next),installed);
      this.db.prepare("UPDATE operations SET status='applied',next=NULL,committed_revision=?,installed_digest=? WHERE id=?").run(proof.publicationRevision,installed,proof.operationId);
      return "installed";
    });
  }
}
async function privateFile(path:string){
  try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))fail("STUDY_PRIVATE_STATE_INVALID");return true;}
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}
}
export async function openStudyCheckpoint(directory:string,digest:string):Promise<StudyCheckpointStore>{
  if(!hash(digest))fail();
  try{
    await privateDirectory(directory);const path=join(directory,"study.sqlite");
    if(!await privateFile(path)){const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await f.close();}
    for(const suffix of ["-journal","-wal","-shm"])await privateFile(path+suffix);
    const Constructor=(sqlite as unknown as {Database?:typeof sqlite.DatabaseSync}).Database??sqlite.DatabaseSync;
    const db=new Constructor(path,{timeout:1000,enableForeignKeyConstraints:true});
    try{return new StudyCheckpointStore(db,digest);}catch(e){db.close();throw e;}
  }catch(e){safe(e);}
}
