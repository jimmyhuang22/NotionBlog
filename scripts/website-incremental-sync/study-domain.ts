import type { StoredMedia } from "../../contracts/sync.ts";
import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { preparePublicationDelta, PublicationDeltaError, type PreparedPublicationDelta, type PublicationState } from "../../src/server/database/incremental-publication.ts";
import { validateMedia } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { prepareStudyDelta, type StudyChangeSource, type StudyDelta } from "../../src/server/notion/study-incremental.ts";
import { StudyCheckpointError, type StudyCheckpointStore } from "./study-checkpoint.ts";

/** Structural subsets of the public executor's ticket and receipt. */
export interface StudyDomainTicket {operationId:string;sourceKey:string;pageKey:string}
export interface StudyDomainReceipt {operationId:string;payloadDigest:string;publicationRevision:string;committed:true}
export type StudyDomainClosure={ticket:StudyDomainTicket;disposition:"never_submitted";payloadDigest:null}|
  {ticket:StudyDomainTicket;disposition:"definitively_rejected";payloadDigest:string};
export type StudyPreparation={outcome:"unchanged"}|{outcome:"review"|"retry";code:string}|{outcome:"prepared";delta:PreparedPublicationDelta};
export interface StudyDomainOptions<TTicket extends StudyDomainTicket=StudyDomainTicket> {
  store:StudyCheckpointStore;sourceKeys:readonly string[];maxReads?:number;
  frozenPageIds?:ReadonlySet<string>;
  refreshPageIds?:readonly string[];
  /** Synchronous public queue lease/generation check immediately before stage. */
  assertPreparing(ticket:TTicket):void;
  source(state:PublicationState,signal:AbortSignal):StudyChangeSource;
  /** Independent reader binding, also used during unknown-result recovery. */
  verify(receipt:StudyDomainReceipt,signal:AbortSignal):Promise<boolean>;
  /** Complete private cache lookup; no remote all-body export. */
  incomingLinks(changes:StudyDelta["hrefChanges"],state:PublicationState,signal:AbortSignal):Promise<{
    records:WebsiteRecord[];publicationRevision:string;configDigest:string;verified:true;
  }>;
  /** All referenced descriptors, including reintroduced descendants; no file bytes. */
  assets(records:WebsiteRecord[],state:PublicationState,signal:AbortSignal):Promise<{media:StoredMedia[];verified:true}>;
}
function guard(signal:AbortSignal){if(signal.aborted)throw new StudyCheckpointError("STUDY_CANCELLED");}
function proofKey(receipt:StudyDomainReceipt){return JSON.stringify([receipt.operationId,receipt.payloadDigest,receipt.publicationRevision]);}
function cancellable(source:StudyChangeSource,signal:AbortSignal):StudyChangeSource{
  return{sourceDigest:source.sourceDigest,openOperation:()=>{guard(signal);return cancellable(source.openOperation?.()??source,signal);},
    read:async(id,options)=>{guard(signal);const result=await source.read(id,options);guard(signal);return result;}};
}
function referenced(records:WebsiteRecord[]){
  const refs=new Map<string,{owner:string;width:number|null;height:number|null}>();
  for(const record of records){
    const visit=(value:unknown)=>{
      if(Array.isArray(value)){value.forEach(visit);return;}
      if(!value||typeof value!=="object")return;
      const x=value as Record<string,unknown>;
      if(typeof x.src==="string"&&x.src.startsWith("/media/v2/")){
        const id=x.id as string,ref={owner:record.detail.item.id,width:x.width as number|null,height:x.height as number|null};
        if(x.src!==`/media/v2/${id}`||!/^a1\.[a-f0-9]{64}$/.test(id)||refs.has(id)&&JSON.stringify(refs.get(id))!==JSON.stringify(ref))throw new StudyCheckpointError("STUDY_ASSET_MISMATCH");
        refs.set(id,ref);
      }
      Object.values(x).forEach(visit);
    };visit(record.detail);
  }
  return refs;
}

/** Compose these prepare/verify/finalize ports with the public publication port.
 * Preparation persists next state; finalize has no Notion or submit path. */
export function createStudyDomainPort<TTicket extends StudyDomainTicket=StudyDomainTicket>(options:StudyDomainOptions<TTicket>){
  if(!Array.isArray(options.sourceKeys)||!options.sourceKeys.length||options.sourceKeys.length>50||new Set(options.sourceKeys).size!==options.sourceKeys.length||
    options.sourceKeys.some(s=>typeof s!=="string"||!s.length||s.length>128||/[\u0000-\u001f\u007f]/.test(s)))throw new StudyCheckpointError("STUDY_SOURCE_MISMATCH");
  const sources=new Set(options.sourceKeys),verified=new Set<string>();
  return {
    async prepare(ticket:TTicket,state:PublicationState,signal:AbortSignal):Promise<StudyPreparation>{
      guard(signal);
      if(!sources.has(ticket.sourceKey)||state.configDigest!==options.store.sourceDigest||state.schemaDigest!==WEBSITE_SCHEMA_DIGEST)return{outcome:"review",code:"STUDY_SOURCE_MISMATCH"};
      try{
        const id=normalizeId(ticket.pageKey),checkpoint=options.store.load();
        if(checkpoint.version!==state.publicationRevision)return{outcome:"review",code:"STUDY_CHECKPOINT_VERSION_CHANGED"};
        const delta=await prepareStudyDelta(checkpoint,options.refreshPageIds?[...options.refreshPageIds]:[id],cancellable(options.source(state,signal),signal),options.maxReads,options.frozenPageIds);guard(signal);
        const signalled=delta.upserts.find(e=>e.record.detail.item.id===id)?.record??checkpoint.entries.find(e=>e.record.detail.item.id===id)?.record;
        if(!signalled||signalled.evidence.sourceKey!==ticket.sourceKey)return{outcome:"review",code:"STUDY_SOURCE_MISMATCH"};
        if(delta.withdrawalEvidence.some(w=>w.reason==="denied"))return{outcome:"review",code:"STUDY_POLICY_RECONCILIATION_REQUIRED"};
        if(!delta.upserts.length&&!delta.withdrawals.length)return{outcome:"unchanged"};
        const extra=delta.hrefChanges.length?await options.incomingLinks(delta.hrefChanges,state,signal):
          {records:[],publicationRevision:state.publicationRevision,configDigest:state.configDigest,verified:true};guard(signal);
        if(extra.verified!==true||extra.publicationRevision!==state.publicationRevision||extra.configDigest!==state.configDigest||
          !Array.isArray(extra.records)||extra.records.some(r=>["course","study-note"].includes(r.detail.item.kind)))return{outcome:"review",code:"STUDY_LINK_CACHE_UNVERIFIED"};
        const records=[...delta.upserts.map(e=>e.record),...extra.records];
        if(records.length>100||delta.withdrawalEvidence.length>100)return{outcome:"review",code:"STUDY_DELTA_BUDGET_REACHED"};
        const refs=referenced(records);if(refs.size>100)return{outcome:"review",code:"STUDY_DELTA_BUDGET_REACHED"};
        const assets=refs.size?await options.assets(records,state,signal):{media:[],verified:true};guard(signal);
        if(assets.verified!==true||!Array.isArray(assets.media))return{outcome:"retry",code:"STUDY_MEDIA_PENDING"};
        const seen=new Set<string>();
        for(const media of assets.media){
          validateMedia(media);const ref=refs.get(media.assetId);
          if(seen.has(media.assetId)||!ref||ref.owner!==media.ownerPageId||ref.width!==media.width||ref.height!==media.height)return{outcome:"review",code:"STUDY_ASSET_MISMATCH"};
          seen.add(media.assetId);
        }
        if(seen.size!==refs.size)return{outcome:"retry",code:"STUDY_MEDIA_PENDING"};
        if(assets.media.length>100)return{outcome:"review",code:"STUDY_DELTA_BUDGET_REACHED"};
        const publication=preparePublicationDelta({expectedRevision:delta.baseVersion,configDigest:delta.sourceDigest,upserts:records,media:assets.media,
          withdrawals:delta.withdrawalEvidence.map(({id,sourceKey,reason})=>{
            if(reason==="denied")throw new StudyCheckpointError("STUDY_POLICY_RECONCILIATION_REQUIRED");return{id,sourceKey,reason};
          })});
        guard(signal);options.assertPreparing(ticket);guard(signal);options.store.stage(ticket.operationId,delta,publication);guard(signal);
        return{outcome:"prepared",delta:publication};
      }catch(error){
        guard(signal);
        const code=error instanceof StudyCheckpointError?error.code:error instanceof PublicationDeltaError?"STUDY_PREPARED_DELTA_INVALID":"STUDY_PREPARATION_UNAVAILABLE";
        return{outcome:["STUDY_CHECKPOINT_BUSY","STUDY_PREPARATION_UNAVAILABLE"].includes(code)?"retry":"review",code};
      }
    },
    async verify(receipt:StudyDomainReceipt,signal:AbortSignal):Promise<boolean>{
      guard(signal);const key=proofKey(receipt);verified.delete(key);
      const ok=receipt.committed===true&&await options.verify(receipt,signal);guard(signal);
      if(ok){if(verified.size>=50)throw new StudyCheckpointError("STUDY_CHECKPOINT_BUDGET_REACHED");verified.add(key);}
      return ok;
    },
    async finalize(receipt:StudyDomainReceipt,signal:AbortSignal):Promise<void>{
      guard(signal);const key=proofKey(receipt);
      if(!verified.has(key)||receipt.committed!==true)throw new StudyCheckpointError("STUDY_READER_UNVERIFIED");
      options.store.install({operationId:receipt.operationId,payloadDigest:receipt.payloadDigest,publicationRevision:receipt.publicationRevision,readerVerified:true});
      verified.delete(key);guard(signal);
    },
    async retire(proof:StudyDomainClosure,signal:AbortSignal):Promise<void>{
      guard(signal);
      if(proof.disposition==="never_submitted"&&proof.payloadDigest===null)options.store.retirePrepared(proof.ticket.operationId,null,{neverSubmitted:true});
      else if(proof.disposition==="definitively_rejected"&&typeof proof.payloadDigest==="string")options.store.retirePrepared(proof.ticket.operationId,proof.payloadDigest,{definitivelyRejected:true});
      else throw new StudyCheckpointError("STUDY_OPERATION_UNCONFIRMED");
      guard(signal);
    },
  };
}
