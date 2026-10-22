import { publicHttpResponse } from "../../server/public-cache/http.ts";
import { ContentServiceError,type ContentRepository } from "../../../contracts/repository.ts";
import type { SearchQuery,CursorQuery } from "../../../contracts/website.ts";
import type { ContentKind } from "../../../contracts/content.ts";
import { isContentKind } from "../../../config/features.ts";
import { contentErrorResponse } from "./http.ts";
import { withContentReadBudget } from "../../server/content-read-budget.ts";
const headers={"Cache-Control":"private, no-store","X-Robots-Tag":"noindex, nofollow"};
function query(request: Request,search=false): CursorQuery|SearchQuery {
  const values: Record<string,unknown>={};
  for(const [key,value] of new URL(request.url).searchParams) {
    if(!["limit","cursor",...(search?["q","kinds"]:[])].includes(key)||Object.hasOwn(values,key))throw new ContentServiceError("INVALID_QUERY","Unsupported or repeated query parameter.");
    if(key==="limit"){if(!/^[1-9]\d*$/.test(value))throw new ContentServiceError("INVALID_QUERY","Invalid page size.");values[key]=Number(value);}
    else if(key==="kinds"){const kinds=value.split(",");if(kinds.some(k=>!isContentKind(k)))throw new ContentServiceError("INVALID_QUERY","Invalid search kinds.");values.kinds=kinds as ContentKind[];}
    else values[key]=value;
  }
  return values as unknown as CursorQuery|SearchQuery;
}
export async function websiteQueryResponse(request: Request,repository: ContentRepository,type:"timeline"|"search") {
  try {
    const data=await withContentReadBudget(request.signal, async () => type==="timeline"?await repository.getTimeline!(query(request)):await repository.search!(query(request,true) as SearchQuery));
    const response=Response.json({data},{headers});
    return type==="search"?response:publicHttpResponse(request,response,"content");
  }catch(error){return contentErrorResponse(error);}
}
export async function sitePageResponse(request: Request,key: string,repository: ContentRepository) {
  try {
    if(new URL(request.url).searchParams.size)throw new ContentServiceError("INVALID_QUERY","Page requests do not support query parameters.");
    const data=key==="about"?await repository.getPage!(key):null;
    return data?publicHttpResponse(request,Response.json({data},{headers}),"content"):Response.json({error:{code:"NOT_FOUND",message:"Page is not available."}},{status:404,headers});
  }catch(error){return contentErrorResponse(error);}
}
