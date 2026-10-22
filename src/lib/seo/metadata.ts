import "server-only";
import type { Metadata } from "next";
import type { AnyContent } from "../../../contracts/content.ts";
import { discoveryOptions } from "./discovery.ts";
export function siteMetadata(siteName:string):Metadata {
  const o=discoveryOptions(process.env);
  return {title:{default:siteName,template:`%s · ${siteName}`},description:"动态与学习笔记",robots:{index:o.enabled,follow:o.enabled},...(o.enabled?{metadataBase:new URL(o.origin!),alternates:{types:{"application/rss+xml":"/feed.xml"}},openGraph:{type:"website",siteName,title:siteName}}:{})};
}
/** Frontend metadata consumes the already-authorized DTO, without another provider request. */
export function contentMetadata(item:AnyContent|null):Metadata {
  const o=discoveryOptions(process.env);
  if(!item)return {robots:{index:false,follow:false}};
  const path=item.href.split("#")[0];
  return {title:item.title,description:item.summary??undefined,robots:{index:o.enabled,follow:o.enabled},...(o.enabled?{alternates:{canonical:path},openGraph:{title:item.title,description:item.summary??undefined,url:path,...(item.cover?{images:[{url:item.cover.src,alt:item.cover.alt}]}:{})}}:{})};
}
