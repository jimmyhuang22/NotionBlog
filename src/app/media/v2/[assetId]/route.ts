import { withPublicHttp } from "../../../../server/public-cache/http.ts";
import { getDatabaseRuntime } from "../../../../server/database/runtime.ts";
import { websiteMediaResponse } from "../../../../server/database/website-media.ts";
import { contentErrorResponse } from "../../../../lib/content/http.ts";
import { getNotionRuntime } from "../../../../server/notion/runtime.ts";
import { resolveNotionMediaSource } from "../../../../server/notion/media-source.ts";
import { readWebsiteMediaSource } from "../../../../server/database/website-media-sources.ts";
import { hybridMediaResponse, mediaProvider } from "../../../../server/media/hybrid.ts";
import { ContentServiceError } from "../../../../../contracts/repository.ts";
import { readThumbnail } from "../../../../server/database/thumbnail-index.ts";
import { thumbnailMediaResponse, thumbnailWidth, thumbnailsEnabled, thumbnailQualification } from "../../../../server/media/thumbnail.ts";
import { publishedThumbnailResponse } from "../../../../server/media/published-thumbnail.ts";
import { withMediaReadBudget } from "../../../../server/media/read-budget.ts";
export const runtime="nodejs";
async function readMedia(request:Request,context:{params:Promise<{assetId:string}>}) {
  if(process.env.CONTENT_PROVIDER!=="database"||process.env.DATABASE_CONTENT_VERSION!=="2")return new Response(null,{status:404,headers:{"Cache-Control":"private, no-store"}});
  try {
    return await withMediaReadBudget(request.signal, async () => {
      const {assetId}=await context.params;
      const {db,storage,thumbnailStorage,publishedThumbnail}=getDatabaseRuntime();
      if(mediaProvider(process.env.MEDIA_PROVIDER)==="notion"){
        let notion:ReturnType<typeof getNotionRuntime>|undefined;
        const ports = {version:"v2",read:id=>readWebsiteMediaSource(db,id),resolve:binding=>{
          const {repository,client,config}=notion??=getNotionRuntime();
          if(config.schemaVersion!==2)throw new ContentServiceError("MISCONFIGURED","Media source configuration does not match the content version.");
          return resolveNotionMediaSource(binding,repository,client);
        },storage} satisfies import("../../../../server/media/hybrid.ts").HybridMediaPorts;
        const width=thumbnailWidth(request.url,true);
        if(width&&thumbnailsEnabled(process.env.MEDIA_THUMBNAILS))return await thumbnailMediaResponse(assetId,width,{
          qualification:thumbnailQualification(process.env.MEDIA_THUMBNAIL_QUALIFICATION),
          read:(id,cap)=>readThumbnail(db,"v2",id,cap),resolve:ports.resolve,storage:thumbnailStorage,original:()=>hybridMediaResponse(assetId,ports),
        });
        return await hybridMediaResponse(assetId,ports);
      }
      if(publishedThumbnail){
        const width=thumbnailWidth(request.url);
        if(width&&thumbnailsEnabled(process.env.MEDIA_THUMBNAILS))return await publishedThumbnailResponse(assetId,width,{read:publishedThumbnail,storage});
      }
      return await websiteMediaResponse(assetId,db,storage);
    });
  }catch(error){return contentErrorResponse(error);}
}

export const GET = withPublicHttp("media", readMedia);
