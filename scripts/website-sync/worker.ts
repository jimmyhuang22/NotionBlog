import { createHash,randomUUID } from "node:crypto";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { ContentBlock } from "../../contracts/content.ts";
import type { StoredMedia,RunLease } from "../../contracts/sync.ts";
import type { WebsitePolicy,WebsiteWriter } from "../../contracts/website-sync.ts";
import { parseWebsiteNotionConfig, websiteCollectionTimeZone } from "../../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository, collectWebsiteStudyBaseline, type CollectionProgress, type NotionRepositoryOptions, type PublicNotionPage } from "../../src/server/notion/website-repository.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import type { StudyDiscoveryProgress } from "../../src/server/notion/automatic-study.ts";
import { configDigest,mediaIdentity,validateMedia,validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import type { ObjectStorage } from "../../src/server/database/storage.ts";
import { verifyMediaBytes } from "../../src/server/database/storage.ts";
import type { DownloadedImage } from "../notion-sync/download.ts";
import { createWebsiteImageDownloader } from "./download.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { sourceFingerprint, validateMediaSource, type MediaSourceBinding } from "../../src/server/media/notion-source.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { imageDimensions } from "./image-dimensions.ts";
import { resolveNotionMediaSource } from "../../src/server/notion/media-source.ts";
import { captureDirectoryMetadata } from "../website-incremental-sync/discovery-baseline.ts";
import { assertFullBaselineConfig, type PreparedFullBaseline } from "../website-incremental-sync/full-baseline-artifact.ts";
import { mapBounded } from "../../src/server/notion/bounded-work.ts";
import { createMediaRefreshScope } from "./media-refresh-scope.ts";
import { collectionResumePlan } from "./collection-resume-plan.ts";
import { createCollectionReadSession } from "./collection-source-proof.ts";
import type { CollectedPage } from "./collection-capture.ts";
import { publicationOwnerChange, PublicationRevalidationError, type PublicationRevalidationProgress } from "./publication-revalidation.ts";
export async function websitePolicy(client: NotionReadClient,input: unknown,freshnessSeconds: number): Promise<WebsitePolicy> {
  if(!Number.isInteger(freshnessSeconds)||freshnessSeconds<1||freshnessSeconds>86400)throw new ContentServiceError("MISCONFIGURED","An explicit freshness budget is required.");
  const config=parseWebsiteNotionConfig(input),timeZone=websiteCollectionTimeZone(config);
  // Automatic roots need a static policy, not a second full descendant scan.
  const selected={...config,sources:config.sources.filter(s=>s.publication.mode==="allowlist")};
  const records=await createWebsiteNotionRepository({client,config:selected,timeZone}).collectRecords(false);
  return {configDigest:configDigest(config),freshnessSeconds,sources:config.sources.map(s=>({key:s.key,kind:s.kind,mode:s.publication.mode,dataSourceId:s.dataSourceId,databaseParentId:s.kind==="study-note"?s.coursePageId:null,pageId:s.pageId})),
    permits:records.filter(r=>config.sources.find(s=>s.key===r.evidence.sourceKey)!.publication.mode==="allowlist").map(r=>({id:r.detail.item.id,kind:r.detail.item.kind,sourceKey:r.evidence.sourceKey,courseId:r.evidence.courseId,parentId:r.evidence.parentId}))};
}
export function assertCompleteTraversal(blocks:ContentBlock[]) {
  for(const b of blocks){
    if(b.type==="unsupported"&&["Content block limit reached","Content nesting limit reached","Content belongs to a different parent","Repeated content block omitted","Image unavailable"].includes(b.label))throw new ContentServiceError("CONTENT_UNAVAILABLE","Website body traversal or media collection was incomplete.");
    if(b.type==="list")for(const i of b.items)assertCompleteTraversal(i.children);
    if(b.type==="toggle"||b.type==="callout")assertCompleteTraversal(b.children);
    if(b.type==="columns")for(const c of b.columns)assertCompleteTraversal(c.blocks);
  }
}
/** Separate opt-in v2 collector. It cannot call or alter the v1 worker namespace. */
export async function runWebsiteSync(options: {client: NotionReadClient;config: unknown;mode:"dry-run"|"stage"|"publish";writer?: WebsiteWriter;storage?:ObjectStorage;download?:(url:string)=>Promise<DownloadedImage>;mediaSources?:{stage(lease:RunLease,bindings:MediaSourceBinding[]):Promise<void>};maxMediaBytes?:number;maxCollectionBytes?:number;signal?:AbortSignal;onIncrementalBaseline?:(capture:PreparedFullBaseline)=>Promise<void>;onStudyDiscoveryProgress?:(progress:StudyDiscoveryProgress)=>void;collectionConcurrency?:number;onCollectionProgress?:(progress:CollectionProgress)=>void;resumeCollection?:{pages:CollectedPage[];bind(lease:RunLease):Promise<()=>void>};onResumePlan?:(plan:ReturnType<typeof collectionResumePlan>)=>Promise<void>;onResumeProgress?:(value:{reusedPages:number;recollectedPages:number;newPages:number;unseenSavedPages:number})=>void;revalidateCollectionOwners?:boolean;publicationRepair?:{maxPages:number;maxPasses:number};onPublicationRevalidation?:(value:PublicationRevalidationProgress)=>Promise<void>;captureCollection?:{save(page:CollectedPage):Promise<void>;replace?(page:CollectedPage):Promise<void>;seal(order:string[]):Promise<void>}}) {
  if(!["dry-run","stage","publish"].includes(options.mode)||(options.mode!=="dry-run"&&(!options.writer||!options.storage)))throw new ContentServiceError("MISCONFIGURED","Invalid website sync configuration.");
  // Keep existing operators at 1 GiB. An explicit override remains bounded by
  // the complete archive's 2 GiB media limit, including mixed Notion delivery.
  const concurrency=options.collectionConcurrency??1;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)throw new ContentServiceError("MISCONFIGURED","Invalid collection concurrency.");
  const maxMediaBytes=options.maxMediaBytes===undefined?1024*1024*1024:options.maxMediaBytes;
  if(!Number.isSafeInteger(maxMediaBytes)||maxMediaBytes<1||maxMediaBytes>2*1024*1024*1024)throw new ContentServiceError("MISCONFIGURED","Invalid website media byte budget.");
  const config=parseWebsiteNotionConfig(options.config),timeZone=websiteCollectionTimeZone(config),digest=configDigest(config),assets=new Map<string,StoredMedia>(),objects=new Set<string>();
  if(options.onIncrementalBaseline){
    if(options.mode!=="publish"||options.mediaSources)throw new ContentServiceError("MISCONFIGURED","Incremental baseline capture requires an explicit full storage publication.");
    assertFullBaselineConfig(config);
  }
  const metadata=options.onIncrementalBaseline?captureDirectoryMetadata(options.client,config):undefined;
  const repair=options.publicationRepair;
  if(repair&&(!options.captureCollection?.replace||options.onIncrementalBaseline||
    !Number.isSafeInteger(repair.maxPages)||repair.maxPages<1||repair.maxPages>64||
    !Number.isSafeInteger(repair.maxPasses)||repair.maxPasses<1||repair.maxPasses>2))
    throw new ContentServiceError("MISCONFIGURED","Invalid bounded publication repair.");
  let revalidationPasses=0,repairedPages=0;
  let resumeCheck: (()=>void)|undefined;
  const reads=options.captureCollection||options.resumeCollection?createCollectionReadSession(options.client,()=>check()):undefined;
  const sourceClient=metadata?.client??reads?.client??options.client;
  const saved=new Map(options.resumeCollection?.pages.map(p=>[p.record.detail.item.id,p]));
  const owners=new Map<string,PublicNotionPage>();
  const proofs=new Map<string,CollectedPage["sourceReads"]>();
  const resumeStats={reusedPages:0,recollectedPages:0,newPages:0,unseenSavedPages:saved.size};
  const bindings=new Map<string,MediaSourceBinding>(),storedObjects=new Set<string>();
  let lease: RunLease|undefined,renewal:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined,failed=false,bytes=0,published=false,sourceRefreshes=0;
  // Serialize accounting and object commits, while reads/decoding overlap.
  // A rejected commit poisons the queue: waiting pages must not retry its PUT.
  let mediaCommit:Promise<unknown>=Promise.resolve();
  const automaticStudy=config.sources.some(s=>s.publication.mode==="course-descendants");
  const check=()=>{options.signal?.throwIfAborted();resumeCheck?.();if(failed)throw new ContentServiceError("CONTENT_UNAVAILABLE","Website sync lease was lost.");};
  const download=options.download??createWebsiteImageDownloader();
  try {
    check();
    if(options.resumeCollection&&(options.mode==="dry-run"||!options.captureCollection||options.onIncrementalBaseline))throw new ContentServiceError("MISCONFIGURED","Resume requires qualified collection capture.");
    if(options.mode!=="dry-run") {
      if(config.sources.some(s=>s.publication.mode==="course-descendants"||(s.kind==="course"&&s.publication.mode==="all"))) {
        if(!options.writer!.verifyStudy)throw new ContentServiceError("MISCONFIGURED","Automatic study requires the installed study extension.");
        await options.writer!.verifyStudy();
      }
      lease=await options.writer!.begin(randomUUID(),digest);
      if(options.resumeCollection)resumeCheck=await options.resumeCollection.bind(lease);
      check();
      if(lease.configDigest!==digest||!Array.isArray(lease.deniedPageIds))throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid sync lease.");
      timer=setInterval(()=>{if(renewal)return;renewal=options.writer!.renew(lease!).catch(()=>{failed=true;}).finally(()=>{renewal=undefined;});},30000);
    }
    const ownerRepository=createWebsiteNotionRepository({client:options.client,config,timeZone,deniedPageIds:new Set(lease?.deniedPageIds??[])});
    const refreshScope=createMediaRefreshScope(id=>ownerRepository.resolveMediaOwner!(id),check,Date.now,options.revalidateCollectionOwners===true);
    const repositoryOptions: NotionRepositoryOptions={maxCollectionBytes:options.maxCollectionBytes,client:sourceClient,config,timeZone,deniedPageIds:new Set(lease?.deniedPageIds??[]),onStudyDiscoveryProgress:options.onStudyDiscoveryProgress,collectionConcurrency:concurrency,onCollectionProgress:options.onCollectionProgress,onCollectionPlan:options.resumeCollection?async(ids:string[])=>{check();const pages=options.resumeCollection!.pages;await options.onResumePlan?.(collectionResumePlan(pages,ids,reads!.pendingProofRequests(pages.map(p=>p.sourceReads!))));check();}:undefined,withCollectionPage:refreshScope.run,
      onCollectedRecord:options.captureCollection?async (record:import("../../contracts/website-sync.ts").WebsiteRecord)=>{
        check();if(!record.detail.document)throw new ContentServiceError("CONTENT_UNAVAILABLE","A website body is missing.");
        assertCompleteTraversal(record.detail.document.blocks);
        if(record.detail.item.kind==="study-note")record.detail.item.breadcrumbs=record.detail.item.breadcrumbs.filter(l=>l.href!=="/study");
        validateWebsiteRecord(record);
        const owner=record.detail.item.id;
        await options.captureCollection!.save(structuredClone({record,lease:lease??null,sourceReads:proofs.get(owner),
          media:[...assets.values()].filter(m=>m.ownerPageId===owner),bindings:[...bindings.values()].filter(b=>b.ownerPageId===owner)}));check();
      }:undefined,registerImage:async (input:import("../../src/server/notion/blocks.ts").RegisterBlockImageInput)=>{
      let url=input.url;
      if((automaticStudy||options.mediaSources)&&input.expiryTime&&Date.parse(input.expiryTime)<=Date.now()+60000) {
        // Discovery can precede encoding by a long interval. Refresh just this
        // locator through a fresh owner check; do not traverse bodies again or
        // accept a different source file under the old discovery snapshot.
        const fresh=await resolveNotionMediaSource({ownerPageId:input.ownerPageId,locator:input.blockId?{kind:"block",id:normalizeId(input.blockId)}:input.property?{kind:"property",name:input.property}:{kind:"cover"}},
          // Expiry refresh must bypass the collection memo: its discovery
          // response may contain the very signed URL that just expired.
          refreshScope,refreshScope.locatorClient(options.client,input.blockId,input.blockParentId));
        if(!fresh||fresh.sourceFingerprint!==sourceFingerprint(input.url,true))throw new ContentServiceError("CONTENT_UNAVAILABLE","The discovered source image changed or is unavailable.");
        url=fresh.url;sourceRefreshes++;
      } else if((automaticStudy||options.mediaSources)&&input.expiryTime&&(!Number.isFinite(Date.parse(input.expiryTime))||Date.parse(input.expiryTime)<=Date.now()))throw new ContentServiceError("CONTENT_UNAVAILABLE","The source image is unavailable.");
      check();const image=await download(url);check();
      const dimensions=await imageDimensions(image.bytes);check();
      const sha256=createHash("sha256").update(image.bytes).digest("hex"),assetId=mediaIdentity(input.ownerPageId,input.blockId??input.property??"cover",sha256);
      const media:StoredMedia={assetId,ownerPageId:input.ownerPageId,objectKey:`sha256/${sha256}`,sha256,byteSize:image.bytes.length,mime:image.mime,...dimensions};
      validateMedia(media);verifyMediaBytes(media,image.bytes);
      const committed=mediaCommit.then(async()=>{
        check();
        if(options.mediaSources){
          const binding:MediaSourceBinding={assetId,ownerPageId:input.ownerPageId,sha256,
            locator:input.blockId?{kind:"block",id:normalizeId(input.blockId)}:input.property?{kind:"property",name:input.property}:{kind:"cover"},
            delivery:image.transformed?"storage":"notion",sourceFingerprint:sourceFingerprint(input.url,input.expiryTime!==undefined)};
          validateMediaSource(binding,media,"v2");bindings.set(assetId,binding);
        }
        if((!assets.has(assetId)&&assets.size>=20000)||bytes+(!objects.has(media.objectKey)?media.byteSize:0)>maxMediaBytes)throw new ContentServiceError("CONTENT_UNAVAILABLE","Website media limit reached.");
        if((!options.mediaSources||image.transformed)&&!storedObjects.has(media.objectKey)&&options.mode!=="dry-run"){await options.storage!.put(media,image.bytes);check();storedObjects.add(media.objectKey);}
        if(!objects.has(media.objectKey)){objects.add(media.objectKey);bytes+=media.byteSize;}
        assets.set(assetId,media);return {id:assetId,src:`/media/v2/${assetId}`,alt:sanitizePublicText(input.alt),...dimensions};
      });
      mediaCommit=committed;
      return await committed;
    }};
    if(reads)repositoryOptions.collectPage=async(owner,ordinal)=>{
      check();const id=normalizeId(owner.page.id),old=saved.get(id);owners.set(id,structuredClone(owner));
      let reusable=!!old?.sourceReads&&old.record.detail.document?.completeness==="complete"&&old.bindings.length===old.media.length&&await reads.matches(old.sourceReads);
      if(reusable&&old){
        // Source proof covers every nested body list and linked-page read. Media
        // still needs live byte validation; hashes/unchanged URLs alone do not.
        const mediaOwner=createWebsiteNotionRepository({client:sourceClient,config,timeZone,deniedPageIds:new Set(lease?.deniedPageIds??[])});
        for(const binding of old.bindings){
          check();let fresh=await resolveNotionMediaSource(binding,mediaOwner,sourceClient);
          // A discovery memo may contain expired signed URLs. Refresh each
          // locator, but share the bounded live owner check within this page;
          // refreshScope independently checks that owner again on completion.
          if(!fresh)fresh=await resolveNotionMediaSource(binding,refreshScope,options.client);
          if(!fresh||fresh.sourceFingerprint!==binding.sourceFingerprint){reusable=false;break;}
          const media=old.media.find(m=>m.assetId===binding.assetId)!;
          const image=await download(fresh.url);check();
          if(createHash("sha256").update(image.bytes).digest("hex")!==media.sha256||image.mime!==media.mime||
            (image.transformed?"storage":"notion")!==binding.delivery){reusable=false;break;}
          verifyMediaBytes(media,image.bytes);
        }
        if(reusable){
          const committed=mediaCommit.then(async()=>{
            for(const media of old.media){
              check();const binding=old.bindings.find(b=>b.assetId===media.assetId)!;
              if((!assets.has(media.assetId)&&assets.size>=20000)||bytes+(!objects.has(media.objectKey)?media.byteSize:0)>maxMediaBytes)throw new ContentServiceError("CONTENT_UNAVAILABLE","Website media limit reached.");
              // A completed old page already committed transformed objects. Read
              // and verify them once; never issue another PUT during reuse.
              if(binding.delivery==="storage"&&!storedObjects.has(media.objectKey)){
                verifyMediaBytes(media,await options.storage!.read(media));check();storedObjects.add(media.objectKey);
              }
              if(!objects.has(media.objectKey)){objects.add(media.objectKey);bytes+=media.byteSize;}
              assets.set(media.assetId,structuredClone(media));bindings.set(media.assetId,structuredClone(binding));
            }
          });mediaCommit=committed;await committed;
          proofs.set(id,structuredClone(old.sourceReads));saved.delete(id);resumeStats.reusedPages++;resumeStats.unseenSavedPages=saved.size;options.onResumeProgress?.({...resumeStats});
          const record=structuredClone(old.record);record.evidence.ordinal=ordinal;return record;
        }
      }
      const trace=reads.trace();
      const record=await createWebsiteNotionRepository({client:trace.client,config,timeZone,registerImage:repositoryOptions.registerImage,
        deniedPageIds:new Set(lease?.deniedPageIds??[])}).collectRecord(id,{kind:owner.source.kind,ordinal});
      if(!record)throw new ContentServiceError("CONTENT_UNAVAILABLE","A selected page is no longer available.");
      proofs.set(id,trace.seal());if(old){saved.delete(id);resumeStats.recollectedPages++;}else resumeStats.newPages++;
      resumeStats.unseenSavedPages=saved.size;options.onResumeProgress?.({...resumeStats});return record;
    };
    const collection=metadata?await collectWebsiteStudyBaseline(repositoryOptions):undefined;
    const records=collection?.records??await createWebsiteNotionRepository(repositoryOptions).collectRecords(true,new Set(lease?.deniedPageIds??[]));check();
    for(const record of records){if(!record.detail.document)throw new ContentServiceError("CONTENT_UNAVAILABLE","A website body is missing.");assertCompleteTraversal(record.detail.document.blocks);if(record.detail.item.kind==="study-note")record.detail.item.breadcrumbs=record.detail.item.breadcrumbs.filter(l=>l.href!=="/study");validateWebsiteRecord(record);}
    if(reads){
      // Every pass starts AFTER body/media work with an empty independent memo.
      // Only edit revisions of still-qualified, unchanged owners may be repaired.
      // A stable final pass remains mandatory before sealing or staging anything.
      for(let pass=0;;pass++){
        revalidationPasses++;
        const finalReads=createCollectionReadSession(options.client,check);
        if(repair&&finalReads.client.listPages){
          // Complete listings from THIS final pass supply fresh entity metadata.
          // Explicit single-page/allowlist sources never enumerate siblings.
          // Resolve every selected owner and physical ancestor as before; absent
          // rows fall through to a fresh GET and still cannot inherit admission.
          const sources=[...new Set([...owners.values()].filter(owner=>
            ["all","course-descendants"].includes(owner.source.publication.mode)&&owner.page.parent.type==="data_source_id")
            .map(owner=>normalizeId((owner.page.parent as {data_source_id:string}).data_source_id)))];
          await mapBounded(sources,concurrency,id=>finalReads.client.listPages!(id));check();
        }
        const verifier=createWebsiteNotionRepository({client:finalReads.client,config,timeZone,deniedPageIds:new Set(lease?.deniedPageIds??[])});
        const changed:PublicNotionPage[]=[];let checkedPages=0;
        const emit=(phase:PublicationRevalidationProgress["phase"],change?:PublicationRevalidationProgress["change"])=>
          options.onPublicationRevalidation?.({pass:pass+1,phase,checkedPages,repairedPages,...(change?{change}:{})});
        await emit("checking");
        await mapBounded([...owners.values()],concurrency,async owner=>{
          check();const current=await verifier.resolveMediaOwner!(owner.page.id);check();checkedPages++;
          const change=publicationOwnerChange(owner,current);if(!change)return;
          await emit("changed",change);
          if(!repair||change.kind!=="revision"||pass>=repair.maxPasses||repairedPages+changed.length>=repair.maxPages)
            throw new PublicationRevalidationError(change);
          changed.push(current!);
        });
        if(!changed.length){await emit("complete");break;}
        for(const owner of changed){
          check();const id=normalizeId(owner.page.id),position=records.findIndex(r=>r.detail.item.id===id);
          if(position<0)throw new ContentServiceError("CONTENT_UNAVAILABLE","A changed collection owner is missing.");
          // Drop this owner's obsolete descriptors without deleting stored bytes.
          // Shared object accounting is rebuilt from the remaining owners.
          for(const [assetId,media] of assets)if(media.ownerPageId===id){assets.delete(assetId);bindings.delete(assetId);}
          objects.clear();bytes=0;
          for(const media of assets.values())if(!objects.has(media.objectKey)){objects.add(media.objectKey);bytes+=media.byteSize;}
          const trace=createCollectionReadSession(options.client,check).trace();
          const record=await refreshScope.run(owner,()=>createWebsiteNotionRepository({client:trace.client,config,timeZone,
            deniedPageIds:new Set(lease?.deniedPageIds??[]),registerImage:repositoryOptions.registerImage})
            .collectRecord(id,{kind:owner.source.kind,ordinal:records[position].evidence.ordinal}));
          check();
          if(!record?.detail.document)throw new PublicationRevalidationError(publicationOwnerChange(owner,null)!);
          assertCompleteTraversal(record.detail.document.blocks);
          if(record.detail.item.kind==="study-note")record.detail.item.breadcrumbs=record.detail.item.breadcrumbs.filter(l=>l.href!=="/study");
          validateWebsiteRecord(record);
          if(Buffer.byteLength(JSON.stringify(records.map((saved,index)=>index===position?record:saved)))>(options.maxCollectionBytes??16*1024*1024))
            throw new ContentServiceError("CONTENT_UNAVAILABLE","Website snapshot exceeds supported size.");
          proofs.set(id,trace.seal());
          await options.captureCollection!.replace!(structuredClone({record,lease:lease??null,sourceReads:proofs.get(id),
            media:[...assets.values()].filter(m=>m.ownerPageId===id),bindings:[...bindings.values()].filter(b=>b.ownerPageId===id)}));
          check();records[position]=record;owners.set(id,structuredClone(owner));repairedPages++;await emit("repaired");
        }
      }
    }
    await options.captureCollection?.seal(records.map(r=>r.detail.item.id));check();
    if(options.mode!=="dry-run") {
      if(metadata&&collection){
        const capture:PreparedFullBaseline={format:"incremental-prepared-baseline-v1",fullRunId:lease!.runId,configDigest:digest,
          collection,media:[...assets.values()],deniedPageIds:[...new Set(lease!.deniedPageIds.map(normalizeId))].sort(),directory:metadata.seal(records)};
        // Persist the complete same-pass input before any SQL stage/promote.
        // Caller mutation cannot alter the records or assets being published.
        await options.onIncrementalBaseline!(structuredClone(capture));check();
      }
      // Stage owners before their descriptors. A failed body or image never publishes a partial batch.
      for(const record of records){check();await options.writer!.stage(lease!,[record]);}
      const media=[...assets.values()];for(let i=0;i<media.length;i+=100){check();await options.writer!.stage(lease!,[],media.slice(i,i+100));}
      const sources=[...bindings.values()];for(let i=0;i<sources.length;i+=100){check();await options.mediaSources!.stage(lease!,sources.slice(i,i+100));check();}
      if(timer)clearInterval(timer);await renewal;check();
      if(options.mode==="publish"){await options.writer!.promote(lease!,{records:records.length,media:media.length,complete:true});published=true;}
      else await options.writer!.fail(lease!);
    }
    return {publicationRevalidation:reads?{passes:revalidationPasses,repairedPages}:undefined,collectionReads:reads?.statistics(),resume:options.resumeCollection?resumeStats:undefined,outcome:options.mode,records:records.length,media:assets.size,uniqueObjects:objects.size,mediaBytes:bytes,mediaByteLimit:maxMediaBytes,sourceRefreshes,partialDocuments:records.filter(r=>r.detail.document?.completeness==="partial").length};
  } catch(error) {if(timer)clearInterval(timer);await renewal;if(lease&&!published)await options.writer!.fail(lease).catch(()=>{});throw error;}
  finally {if(timer)clearInterval(timer);}
}
