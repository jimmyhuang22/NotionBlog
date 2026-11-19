import type { ContentKind } from "../../../contracts/content.ts";
import type { ContentRepository } from "../../../contracts/repository.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { isContentKind,type ContentFeatures } from "../../../config/features.ts";
import { publicSnapshot } from "../content/website.ts";
export interface DiscoveryOptions { enabled: boolean; origin: string|null; kinds: ContentKind[] }
const defaults:ContentKind[]=["status","course","study-note","post","album","book","movie","game"];
export function discoveryOptions(env:Record<string,string|undefined>):DiscoveryOptions {
  const enabled=env.SITE_INDEXING_ENABLED==="true"&&env.CONTENT_PROVIDER!=="mock"&&["notion","database"].includes(env.CONTENT_PROVIDER??"")&&env.VERCEL_ENV!=="preview";
  let origin:string|null=null;
  try {const u=new URL(env.SITE_URL??"");if(u.protocol==="https:"&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==="/"&&!u.port&&!/^(localhost|127\.|\[|0\.)/.test(u.hostname)&&!u.hostname.endsWith(".local"))origin=u.origin;}catch{}
  let kinds=defaults;
  if(env.SITE_DISCOVERY_KINDS_JSON){try {const value:unknown=JSON.parse(env.SITE_DISCOVERY_KINDS_JSON);if(!Array.isArray(value)||value.some(k=>typeof k!=="string"||!isContentKind(k)))throw new Error();kinds=[...new Set(value)] as ContentKind[];}catch{throw new ContentServiceError("MISCONFIGURED","Invalid discovery kinds.");}}
  if(enabled&&!origin)throw new ContentServiceError("MISCONFIGURED","Public discovery requires an HTTPS site origin.");
  return {enabled,origin,kinds};
}
export const xmlEscape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"");
const section:Partial<Record<ContentKind,string>>={status:"/status",course:"/study",post:"/blog",album:"/photos",book:"/library/books",movie:"/library/movies",game:"/library/games",project:"/projects"};
export async function sitemapXml(repository:ContentRepository,features:ContentFeatures,options:DiscoveryOptions) {
  if(!options.enabled)return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
  const kinds=options.kinds.filter(k=>features[k]),snapshot=await publicSnapshot(repository,kinds),urls=new Map<string,string|null>([["/",null]]);
  for(const k of kinds)if(section[k])urls.set(section[k]!,null);
  for(const {item} of snapshot.records)if(kinds.includes(item.kind)){const path=item.href.split("#")[0];if(path.startsWith("/")&&!path.startsWith("//")&&!/[\\?]/.test(path)){const previous=urls.get(path)??null;const updated=item.updatedAt;urls.set(path,updated&&(!previous||Date.parse(updated)>Date.parse(previous))?updated:previous);}}
  if(urls.size>50000)throw new ContentServiceError("CONTENT_UNAVAILABLE","Sitemap exceeds supported size.");
  return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+[...urls].sort(([a],[b])=>a.localeCompare(b)).map(([path,date])=>`<url><loc>${xmlEscape(new URL(path,options.origin!).toString())}</loc>${date?`<lastmod>${xmlEscape(date)}</lastmod>`:""}</url>`).join("")+"</urlset>";
}
export function robotsText(options:DiscoveryOptions) {return options.enabled?`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /preview/\nSitemap: ${options.origin}/sitemap.xml\n`:"User-agent: *\nDisallow: /\n";}
