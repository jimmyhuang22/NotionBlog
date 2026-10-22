import type { HomeFeedOptions } from "./home-feed-core.ts";
import { pageHomeFeedItems, validFeedSnapshot, hydrateHomeContent } from "./home-feed-core.ts";
import { validateCursorQuery } from "./website.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { HomeFeedV2Item, HomeFeedV2Repository, SocialTimelineWork } from "../../../contracts/social-timeline.ts";
import { MAX_SOCIAL_WORKS } from "./social-limits.ts";
import { measureContentRead, measureContentReadAsync, traceContentRead } from "../../server/content-read-timing.ts";
import { hydrateSelectedSocialCovers, type SocialCoverSnapshot } from "../../server/social/cover-hydration.ts";

export function createHomeFeedV2Repository(options:Omit<HomeFeedOptions,"social"> & {social?:()=>Promise<SocialCoverSnapshot<SocialTimelineWork>>}):HomeFeedV2Repository {
  const unavailable=()=>new ContentServiceError("CONTENT_UNAVAILABLE","Home feed is temporarily unavailable.");
  if(!["mock","notion","database"].includes(options.sources.content) || !["disabled","database"].includes(options.sources.social) ||
    (options.sources.social==="database")!==(options.social!==undefined) || typeof options.content!=="function" ||
    (options.social!==undefined && typeof options.social!=="function"))throw unavailable();
  const sources=Object.freeze({...options.sources}),timeZone=options.timeZone,readContent=options.content,readSocial=options.social;
  let formatter:Intl.DateTimeFormat;
  try{formatter=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",era:"short"});}catch{throw unavailable();}
  return {getPage:(query={})=>traceContentRead("home-feed", "unknown", async () => {
    validateCursorQuery(query);
    const [content,social]=await Promise.all([measureContentReadAsync("home-content", readContent),readSocial ? measureContentReadAsync("home-social", readSocial) : undefined]);
    const {result,total}=measureContentRead("home-compose", () => {
      validFeedSnapshot(content,20000);if(readSocial)validFeedSnapshot(social!,MAX_SOCIAL_WORKS);
      const items:HomeFeedV2Item[]=content.items.map(event=>({id:`content:${event.id}`,source:"content",provider:sources.content,occurredAt:event.occurredAt,event}));
      for(const work of social?.items??[]) {
        // Display moment includes an explicitly labelled detection activity; original work date is preserved.
        const at=work.collection?.activity?.at??work.occurredAt;
        items.push({id:`social:${work.id}`,source:"social",provider:"database",occurredAt:at===null?null:{start:at,end:null,precision:"datetime"},work});
      }
      const result=pageHomeFeedItems(items,formatter,query,["home-feed-v2",content.version,social?.version??null,sources,timeZone,query.limit??16]);
      return {result,total:items.length};
    });
    const selected = result.items.filter(item => item.source === "social").map(item => item.work);
    const [items,works] = await Promise.all([
      measureContentReadAsync("home-hydrate", () => hydrateHomeContent(result.items,content.version,options.hydrateContent)),
      social ? hydrateSelectedSocialCovers(social,selected) : [],
    ]);
    const covers = new Map(works.map(work => [work.id,work]));
    const hydrated=items.map(item=>item.source==="social"?{...item,work:covers.get(item.work.id)!}:item);
    if(Buffer.byteLength(JSON.stringify(hydrated))>24*1024*1024)throw unavailable();
    return {...result,items:hydrated,total,sources:{...sources}};
  })};
}
