import type { CollectionSnapshot } from "../../scripts/social-sync/collection.ts";
import { validateCollectionSnapshot } from "../../scripts/social-sync/collection.ts";

/** Fictional metadata only; never registered as a production source. */
export function exampleCollectionSnapshot(observedAt:string,kind:"season"|"multi-part"="season"):CollectionSnapshot {
  const publishedAt="2026-01-01T00:00:00.000Z";
  return validateCollectionSnapshot({version:1,source:"bilibili-collection-ssr",target:{platform:"bilibili",kind,accountId:"10001",
    collectionId:kind==="season"?"200":"BV0000000001",representativeUrl:"https://www.bilibili.com/video/BV0000000001/"},
    title:"Example collection",observedAt,firstPublishedAt:kind==="season"?null:publishedAt,membershipComplete:true,
    members:kind==="season"?[{id:"BV0000000001",publishedAt,parts:["1000"],partsComplete:true},{id:"BV0000000002",publishedAt,parts:["1001"],partsComplete:false}]:
      [{id:"BV0000000001",publishedAt,parts:["1000","1002"],partsComplete:true}],
    metrics:{views:999,likes:0,comments:2,shares:null,collections:3,coins:null,danmaku:0},responseSha256:"0".repeat(64),websitePublicationApproved:false});
}
