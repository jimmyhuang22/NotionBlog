import "server-only";
import type { Metadata } from "next";
import type { AnyContent } from "../../../contracts/content.ts";
import { discoveryOptions } from "./discovery.ts";
import { getSiteConfig } from "../site/index.ts";
export function siteMetadata(siteName:string):Metadata {
  const o=discoveryOptions(process.env);
  return {title:{default:siteName,template:`%s · ${siteName}`},description:"动态与学习笔记",robots:{index:o.enabled,follow:o.enabled},...(o.enabled?{metadataBase:new URL(o.origin!),alternates:{types:{"application/rss+xml":"/feed.xml"}},openGraph:{type:"website",siteName,title:siteName}}:{})};
}
/**
 * Frontend metadata consumes the already-authorized DTO, without another provider request.
 * Next replaces `openGraph` and `alternates` from the layout as a whole rather than merging them, so the
 * site's name and its feed link are repeated here, or every content page would lose them.
 */
export function contentMetadata(item:AnyContent|null):Metadata {
  const o=discoveryOptions(process.env);
  if(!item)return {robots:{index:false,follow:false}};
  const path=item.href.split("#")[0];
  const {siteName}=getSiteConfig();
  return {title:item.title,description:item.summary??undefined,robots:{index:o.enabled,follow:o.enabled},...(o.enabled?{alternates:{canonical:path,types:{"application/rss+xml":"/feed.xml"}},openGraph:{type:"article",siteName,title:item.title,description:item.summary??undefined,url:path,...(item.cover?{images:[{url:item.cover.src,alt:item.cover.alt}]}:{})}}:{})};
}
