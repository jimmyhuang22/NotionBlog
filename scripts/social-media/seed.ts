import { randomUUID } from "node:crypto";
import { acquireLock } from "../notion-sync/state.ts";
import { hash, publicationKey, SocialSyncError } from "../social-sync/model.ts";
import { publicationReview, collectionReview, type RefreshConfig } from "../social-sync/refresh.ts";
import { collectionKey } from "../social-sync/collection.ts";
import { openStore } from "../social-sync/store.ts";
import { openCollectionStore } from "../social-sync/collection-store.ts";
import { openCoverQueue } from "./queue.ts";
import { publicationCoverSource } from "./sources.ts";
import type { CoverMode } from "../../src/server/social/covers.ts";

/** Read exact local ACKs only. No source request, uploader, or source-store migration. */
export async function seedAcknowledgedCovers(root: string, readScope: () => Promise<RefreshConfig>, mode: CoverMode) {
  const before=await readScope(),digest=hash(JSON.stringify(before));
  const releases:(()=>Promise<void>)[]=[];
  let publications:Awaited<ReturnType<typeof openStore>>=null,collections:Awaited<ReturnType<typeof openCollectionStore>>=null;
  let queue:Awaited<ReturnType<typeof openCoverQueue>>=null;
  const result={publications:0,collections:0,missingCollectionSources:0,skipped:0};
  try {
    for(const path of [...new Set([root,...(before.publications.length?[before.stateDirectories.publications]:[]),...(before.collections.length?[before.stateDirectories.collections]:[])])].sort())releases.push(await acquireLock(path,randomUUID()));
    if(hash(JSON.stringify(await readScope()))!==digest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    if(before.publications.length)publications=await openStore(before.stateDirectories.publications,true);
    if(before.collections.length)collections=await openCollectionStore(before.stateDirectories.collections,true);
    if(before.publications.length&&!publications||before.collections.length&&!collections)throw new SocialSyncError("REFRESH_STATE_MISSING");
    queue=await openCoverQueue(root);if(!queue)throw new SocialSyncError("COVER_QUEUE_UNAVAILABLE");
    for(const entry of before.publications){
      const ack=publications!.acknowledged(entry.target);
      if(!ack||ack.key!==publicationKey(entry.target)||!publicationReview(before,ack.observation).allowed){result.skipped++;continue;}
      queue.offer(publicationCoverSource(ack.observation),mode);result.publications++;
    }
    for(const entry of before.collections){
      const ack=collections!.acknowledged(entry.target);
      if(!ack||!collectionReview(before,ack.snapshot).allowed){result.skipped++;continue;}
      if(queue.acknowledgeCollection(collectionKey(entry.target),ack.sha256,ack.snapshot.observedAt,mode))result.collections++;
      else result.missingCollectionSources++;
    }
    if(hash(JSON.stringify(await readScope()))!==digest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    return result;
  }finally{
    queue?.close();publications?.close();collections?.close();
    for(const release of releases.reverse())await release();
  }
}
