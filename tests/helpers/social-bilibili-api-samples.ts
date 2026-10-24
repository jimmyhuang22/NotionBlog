import { config } from "../../scripts/social-sync/model.ts";
/** Hypothetical public JSON/SSR fixtures; not a captured or validated platform response. */
export const apiTarget = config({version:1,publications:[{platform:"bilibili",workId:"example-video",accountId:"10001",url:"https://www.bilibili.com/video/BV0000000001/"}]})[0]!;
export const apiAt = "2026-01-02T00:00:00.000Z";
export function apiVideoSample(season=false) {
  const episode=(bvid:string,aid:number,cid:number)=>({season_id:200,bvid,aid,pages:[{cid}],arc:{aid,author:{mid:10001},state:0,videos:1,pubdate:1700000000}});
  return {bvid:apiTarget.publicationId,aid:100,owner:{mid:10001},state:0,title:"Example video",desc:"Example description",pic:"https://i0.hdslb.com/bfs/archive/example.jpg",
    pages:[{cid:1000}],videos:1,pubdate:1700000000,stat:{aid:100,view:5,like:0,reply:1,favorite:3},
    ...(season?{season_id:200,ugc_season:{id:200,mid:10001,title:"Example season",ep_count:2,cover:"https://i0.hdslb.com/bfs/archive/example.jpg",
      stat:{season_id:200,view:999,like:0,reply:12,fav:8},sections:[{season_id:200,episodes:[episode("BV0000000001",100,1000),episode("BV0000000002",101,1001)]}]}}:{})};
}
export const apiBody=(video:unknown=apiVideoSample())=>JSON.stringify({code:0,data:video});
export const apiHtml=(video:unknown=apiVideoSample())=>`<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:video})};</script>`;
export const apiSeasonTarget={platform:"bilibili" as const,kind:"season" as const,accountId:"10001",collectionId:"200",representativeUrl:apiTarget.url};
