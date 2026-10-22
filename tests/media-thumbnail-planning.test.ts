import assert from "node:assert/strict";
import test from "node:test";
import type { AnyContent, ContentBlock, ContentKind } from "../contracts/content.ts";
import type { PublicContentSnapshot } from "../contracts/website.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { THUMBNAIL_CAPABILITY } from "../src/server/database/thumbnail-index.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { sourceFingerprint } from "../src/server/media/notion-source.ts";
import { planThumbnailCoverage, type ThumbnailPlanningLimits, type ThumbnailPlanningInventory } from "../scripts/media-thumbnails/planning.ts";

const RUN = "00000000-0000-4000-8000-000000000001";
const NEXT = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const limits: ThumbnailPlanningLimits = {maxParents:3,maxOriginalBytes:64*1024**2,maxUploadRequests:6,
  maxUploadBodyBytes:2*1024**2,maxDurationSeconds:480,maxTotalParents:15,maxTotalOriginalBytes:128*1024**2,
  maxTotalUploadBodyBytes:10*1024**2,maxTotalDurationSeconds:2400,eligibilityReserveSeconds:120};
function fixture(specs:{kind?:ContentKind;bytes?:number;existing?:(400|800)[]}[]=[{}]) {
  const records: PublicContentSnapshot["records"] = [], cells:ThumbnailPlanningInventory["cells"] = [];
  for (const [index, spec] of specs.entries()) {
    const owner = String(index+10).padStart(32,"0"), sha256 = "a".repeat(64);
    const assetId = mediaIdentity(owner,"cover",sha256);
    const media = {assetId,ownerPageId:owner,objectKey:`sha256/${sha256}`,sha256,byteSize:spec.bytes??100,mime:"image/png" as const,width:null,height:null};
    const source = {media,binding:{assetId,ownerPageId:owner,sha256,locator:{kind:"cover" as const},delivery:"notion" as const,
      sourceFingerprint:sourceFingerprint("https://fictional-images.example.test/original.png",false)}};
    const image = {id:assetId,src:`/media/v2/${assetId}`,alt:"Fictional",width:null,height:null};
    const kind=spec.kind??"book";
    const blocks:ContentBlock[]=kind==="status"?[{id:`image-${index}`,type:"image",image,caption:[]}]:[];
    records.push({item:{id:owner,kind,cover:kind==="status"?null:image,text:[],title:"Fictional",slug:owner,
      href:`/fictional/${owner}`,summary:null,tags:[],updatedAt:null} as unknown as AnyContent,
      document:{blocks,toc:[],completeness:"complete"}});
    for (const widthCap of [400,800] as const) {
      const outputSha="b".repeat(64);
      const thumbnail = spec.existing?.includes(widthCap)?{assetId:mediaIdentity(owner,`thumbnail:${widthCap}:${assetId}`,outputSha),
        ownerPageId:owner,sha256:outputSha,objectKey:`sha256/${outputSha}`,mime:"image/webp",byteSize:80,width:100,height:100}:null;
      cells.push({assetId,widthCap,result:{thumbnailCapability:THUMBNAIL_CAPABILITY,schemaDigest:WEBSITE_SCHEMA_DIGEST,
        version:"v2",runId:RUN,source:structuredClone(source),thumbnail}});
    }
  }
  return {snapshot:{version:`${RUN}:1`,records},inventory:{format:"notionblog-thumbnail-inventory-v1" as const,version:"v2" as const,
    runId:RUN,snapshotVersion:`${RUN}:1`,qualifiedAt:new Date(NOW).toISOString(),validUntil:new Date(NOW+3600_000).toISOString(),cells},
    enabledKinds:["book","status"] as ContentKind[],limits:{...limits}};
}
const controlled = (e:unknown) => e instanceof Error && "code" in e && e.code==="CONTENT_UNAVAILABLE" && !e.message.includes(RUN);

test("coverage separates requested widths, existing metadata, execution costs and unknown bytes", async () => {
  const input=fixture([{bytes:100,existing:[400]},{bytes:200},{kind:"status",bytes:300,existing:[400,800]}]);
  const report=await planThumbnailCoverage(input,NOW);
  assert.equal(report.status,"PLANNING_ONLY");
  assert.equal(report.summary.candidateParents,3); assert.equal(report.summary.requestedUIVariants,6);
  assert.equal(report.summary.uiCoveredParents,1); assert.equal(report.summary.existingRequestedMappings,3);
  assert.equal(report.summary.uiMissingVariants,3); assert.equal(report.summary.pendingParents,2);
  assert.equal(report.summary.proposedOriginalReadUpperBoundBytes,300);
  assert.equal(report.summary.proposedPostRequestUpperBound,3);
  assert.equal(report.batches.length,1); assert.equal(report.batches[0].stats.extraVariantsBeyondUI,0);
  assert.equal(report.estimatedUploadBodyBytes,null); assert.equal(report.estimatedNewObjectBytes,null); assert.equal(report.estimatedDurationMs,null);
  assert.equal(report.batches[0].budget.requiresRuntimeBudgetGuard,true); assert.equal(report.batches[0].budget.requiresRequalification,true);
});

test("shared original SHA is counted per distinct asset and only UI-required caps are budgeted", async () => {
  const report=await planThumbnailCoverage(fixture([{kind:"status",bytes:100},{kind:"status",bytes:100}]),NOW);
  assert.equal(report.summary.pendingOriginalReadUpperBoundBytes,200,"the runner can read the same original object for two distinct parents");
  assert.equal(report.summary.requestedUIVariants,4); assert.equal(report.summary.generatorMissingVariantsForPendingParents,4);
  assert.equal(report.batches[0].stats.extraVariantsBeyondUI,0); assert.equal(report.summary.proposedPostRequestUpperBound,4);
  assert.ok(report.batches[0].widths.assets.every(asset => JSON.stringify(asset.widthCaps) === "[400,800]"));
  assert.equal(report.batches[0].budget.requiresWidthSelection,true);
});

test("batch and round limits defer work rather than imply permission or future completion", async () => {
  const input=fixture([{bytes:100},{bytes:200},{bytes:300}]);
  input.limits={...limits,maxParents:2,maxUploadRequests:3,maxTotalDurationSeconds:960};
  const report=await planThumbnailCoverage(input,NOW);
  assert.equal(report.batches.length,2); assert.equal(report.summary.proposedParents,2);
  assert.equal(report.summary.proposedPostRequestUpperBound,4); assert.equal(report.summary.proposedOriginalReadUpperBoundBytes,300);
  assert.equal(report.summary.reservedUploadBodyLimitBytes,4*1024**2);
  assert.equal(report.summary.reservedDurationLimitSeconds,960); assert.equal(report.deferred.length,1);
  assert.equal(report.deferred[0].reason,"ROUND_BUDGET_OR_TIME_WINDOW");
});

test("individual read/request bounds and the qualification window can leave no executable batch",async t=>{
  for(const mode of ["bytes","requests","time","round-bytes","round-parents","round-read"] as const)await t.test(mode,async()=>{
    const input=fixture([{bytes:100},{bytes:200}]);
    if(mode==="bytes")input.limits.maxOriginalBytes=90;
    if(mode==="requests")input.limits.maxUploadRequests=1;
    if(mode==="time")input.inventory.validUntil=new Date(NOW+500_000).toISOString();
    if(mode==="round-bytes")input.limits.maxTotalUploadBodyBytes=input.limits.maxUploadBodyBytes-1;
    if(mode==="round-parents")input.limits.maxTotalParents=1;
    if(mode==="round-read")input.limits.maxTotalOriginalBytes=150;
    const report=await planThumbnailCoverage(input,NOW);
    assert.equal(report.summary.proposedParents,["round-parents","round-read"].includes(mode)?1:0);
    assert.equal(report.summary.deferredParents,2-report.summary.proposedParents);
  });
});

test("old, mixed, corrupt or incomplete inventories fail anonymously without treating denial as a missing width",async t=>{
  for(const mode of ["expired","future","snapshot","null","missing","duplicate","extra","width","run","source","owner","protocol","corrupt-map"] as const)await t.test(mode,async()=>{
    const input=fixture(); const result=input.inventory.cells[0].result as Record<string,unknown>;
    if(mode==="expired")input.inventory.validUntil=new Date(NOW).toISOString();
    if(mode==="future")input.inventory.qualifiedAt=new Date(NOW+31_000).toISOString();
    if(mode==="snapshot")input.snapshot.version=`${NEXT}:1`;
    if(mode==="null")input.inventory.cells[0].result=null;
    if(mode==="missing")input.inventory.cells.pop();
    if(mode==="duplicate")input.inventory.cells[1]=structuredClone(input.inventory.cells[0]);
    if(mode==="extra")input.inventory.cells.push(structuredClone(input.inventory.cells[0]));
    if(mode==="width")input.inventory.cells[0].widthCap=401 as 400;
    if(mode==="run")result.runId=NEXT;
    if(mode==="source")(input.inventory.cells[1].result as {source:{binding:{sourceFingerprint:string}}}).source.binding.sourceFingerprint="c".repeat(64);
    if(mode==="owner")input.snapshot.records[0].item.id="00000000000000000000000000000099";
    if(mode==="protocol")result.schemaDigest="d".repeat(64);
    if(mode==="corrupt-map")result.thumbnail={ownerPageId:"private-source"};
    await assert.rejects(planThumbnailCoverage(input,NOW),controlled);
  });
});

test("strict planning limits reject invalid or elevated single-run budgets",async()=>{
  for(const value of [0,-1,Number.NaN,1024**3+1]){
    const input=fixture();input.limits.maxOriginalBytes=value;
    await assert.rejects(planThumbnailCoverage(input,NOW),controlled);
  }
  const extra=fixture();Object.assign(extra.limits,{executionAuthorized:true});
  await assert.rejects(planThumbnailCoverage(extra,NOW),controlled);
  const duration=fixture();duration.limits.maxDurationSeconds=481;
  await assert.rejects(planThumbnailCoverage(duration,NOW),controlled);
});

test("qualification timestamps reject normalized dates and end-of-day hours",async t=>{
  for(const field of ["qualifiedAt","validUntil"] as const) {
    const invalid=field==="qualifiedAt"
      ? ["2026-02-30T00:00:00Z","2025-02-29T00:00:00Z","2026-10-11T24:00:00Z","2026-10-12T00:00:00Z\n"]
      : ["2026-11-31T00:00:00Z","2027-02-29T00:00:00Z","2026-10-12T24:00:00Z","2026-10-12T01:00:00Z\n"];
    for(const value of invalid) {
      await t.test(`${field}: ${JSON.stringify(value)}`,async()=>{
        const input=fixture();input.inventory[field]=value;
        await assert.rejects(planThumbnailCoverage(input,NOW),controlled);
      });
    }
  }
});

test("qualification timestamps accept UTC microseconds without rounding the window up",async()=>{
  const input=fixture();input.inventory.qualifiedAt="2026-10-12T00:00:00.000001+00:00";
  input.inventory.validUntil="2026-10-12T01:00:00.999999Z";
  assert.equal((await planThumbnailCoverage(input,NOW)).summary.proposedParents,1);
});
