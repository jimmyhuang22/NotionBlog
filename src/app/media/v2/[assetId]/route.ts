import { publicCacheEnabled } from "../../../../server/public-cache/policy.ts";
import { withPublicHttp } from "../../../../server/public-cache/http.ts";
import { getDatabaseRuntime } from "../../../../server/database/runtime.ts";
import { websiteMediaResponse } from "../../../../server/database/website-media.ts";
import { contentErrorResponse } from "../../../../lib/content/http.ts";
import { getNotionRuntime } from "../../../../server/notion/runtime.ts";
import { resolveNotionMediaSource } from "../../../../server/notion/media-source.ts";
import { readWebsiteMediaSource } from "../../../../server/database/website-media-sources.ts";
import { mediaProvider } from "../../../../server/media/hybrid.ts";
import { legacyMediaResponse } from "../../../../server/media/legacy.ts";
import { ContentServiceError } from "../../../../../contracts/repository.ts";
import { readThumbnail } from "../../../../server/database/thumbnail-index.ts";
import { thumbnailWidth, thumbnailsEnabled, thumbnailQualification } from "../../../../server/media/thumbnail.ts";
import { publishedThumbnailResponse } from "../../../../server/media/published-thumbnail.ts";
import { withMediaReadBudget } from "../../../../server/media/read-budget.ts";
import { displayMediaResponse, displayWidth } from "../../../../server/self-hosted-media/response.ts";
import { databaseDisplayResponse } from "../../../../server/media/display.ts";
import { DisplayError } from "../../../../server/database/display.ts";
export const runtime="nodejs";
async function readMedia(request:Request,context:{params:Promise<{assetId:string}>}) {

  if(process.env.CONTENT_PROVIDER!=="database"||process.env.DATABASE_CONTENT_VERSION!=="2")return new Response(null,{status:404,headers:{"Cache-Control":"private, no-store"}});
  try {
    const {assetId}=await context.params;
    const {db,thumbnailDb,storage,thumbnailStorage,publishedThumbnail,displayStore,cloudDisplay}=getDatabaseRuntime();
    if(cloudDisplay)return await withMediaReadBudget(request.signal,()=>databaseDisplayResponse(assetId,displayWidth(request.url),{read:cloudDisplay.read,storage}));
    if(displayStore)return await withMediaReadBudget(request.signal,()=>displayMediaResponse(assetId,displayWidth(request.url),{
      qualify:id=>readThumbnail(thumbnailDb,"v2",id,400),store:displayStore,
    }));
    if(mediaProvider(process.env.MEDIA_PROVIDER)==="notion"){
      let notion:ReturnType<typeof getNotionRuntime>|undefined;
      const ports = {version:"v2",read:id=>readWebsiteMediaSource(db,id),resolve:binding=>{
        const {repository,client,config}=notion??=getNotionRuntime();
        if(config.schemaVersion!==2)throw new ContentServiceError("MISCONFIGURED","Media source configuration does not match the content version.");
        return resolveNotionMediaSource(binding,repository,client);
      },storage} satisfies import("../../../../server/media/hybrid.ts").HybridMediaPorts;
      const width=thumbnailWidth(request.url,true);
      return await legacyMediaResponse(request.signal,assetId,ports,width&&thumbnailsEnabled(process.env.MEDIA_THUMBNAILS)?{width,ports:{
        qualification:thumbnailQualification(process.env.MEDIA_THUMBNAIL_QUALIFICATION),
        ifNoneMatch:publicCacheEnabled()?request.headers.get("if-none-match"):null,
        read:(id,cap)=>readThumbnail(thumbnailDb,"v2",id,cap),resolve:ports.resolve,storage:thumbnailStorage,
      }}:undefined);
    }
    return await withMediaReadBudget(request.signal, async () => {
      if(publishedThumbnail){
        const width=thumbnailWidth(request.url);
        if(width&&thumbnailsEnabled(process.env.MEDIA_THUMBNAILS))return await publishedThumbnailResponse(assetId,width,{read:publishedThumbnail,storage});
      }
      return await websiteMediaResponse(assetId,db,storage);
    });
  }catch(error){return contentErrorResponse(error instanceof DisplayError?new ContentServiceError("CONTENT_UNAVAILABLE","The display image is unavailable."):error);}
}

export const GET = withPublicHttp("media", readMedia);
