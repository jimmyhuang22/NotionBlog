import { nextCollectionState } from "./collection.ts";
import type { CollectionSnapshot, CollectionState } from "./collection.ts";
import { hash, SocialSyncError } from "./model.ts";

export interface CollectionAdditionContribution {
  at:string;detectedAt:string;basis:"member-published"|"addition-detected";addedVideos:number;addedParts:number;
}
export interface CollectionAdditionHistory {version:1;completeSince:string|null;contributions:CollectionAdditionContribution[]}
/** Replay only observed membership deltas; baseline members and new-BV parts are excluded. */
export function advanceCollectionAdditionHistory(history:CollectionAdditionHistory,previous:CollectionState|null,current:CollectionState):CollectionAdditionHistory {
  const events=structuredClone(history.contributions),snapshot=current.snapshot;
  if(previous)for(const member of snapshot.members){
    if(!previous.seenVideos.includes(member.id)){
      if(snapshot.target.kind==="season"){
        const published=member.publishedAt!==null&&member.publishedAt>=previous.snapshot.observedAt?member.publishedAt:null;
        events.push({at:published??snapshot.observedAt,detectedAt:snapshot.observedAt,basis:published?"member-published":"addition-detected",addedVideos:1,addedParts:0});
      }
    }else if(member.partsComplete&&previous.partBaselines[member.id]){
      const addedParts=member.parts.filter(id=>!previous.partBaselines[member.id]!.ids.includes(id)).length;
      if(addedParts)events.push({at:snapshot.observedAt,detectedAt:snapshot.observedAt,basis:"addition-detected",addedVideos:0,addedParts});
    }
  }
  const cutoff=current.activity?new Date(Date.parse(current.activity.at)-72*3600000).toISOString():null;
  const merged=new Map<string,CollectionAdditionContribution>();
  for(const event of events){
    if(cutoff&&event.at<cutoff)continue;
    const key=JSON.stringify([event.at,event.detectedAt,event.basis]),old=merged.get(key);
    if(old){old.addedVideos+=event.addedVideos;old.addedParts+=event.addedParts;}else merged.set(key,event);
  }
  const contributions=[...merged.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.detectedAt.localeCompare(b.detectedAt)||a.basis.localeCompare(b.basis));
  const completeSince=cutoff&&(history.completeSince===null||history.completeSince<cutoff)?cutoff:history.completeSince;
  return {version:1,completeSince,contributions};
}
export function replayCollectionAdditionHistory(samples:CollectionSnapshot[],expected:CollectionState):CollectionAdditionHistory|null {
  if(samples.length===0)return null;
  let state:CollectionState|null=null,history:CollectionAdditionHistory={version:1,completeSince:null,contributions:[]};
  for(const sample of samples){const next=nextCollectionState(state,sample);history=advanceCollectionAdditionHistory(history,state,next);state=next;}
  // The unmodified final state independently proves baseline/seen/part continuity.
  if(hash(JSON.stringify(state))!==hash(JSON.stringify(expected)))return null;
  if(history.contributions.length>30000||Buffer.byteLength(JSON.stringify(history))>8*1024**2)throw new SocialSyncError("COLLECTION_HISTORY_LIMIT");
  return history;
}
