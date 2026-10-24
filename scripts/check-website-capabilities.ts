import { websiteOrigin } from "./check-website.ts";
const headers={"Cache-Control":"no-store"};
export async function checkWebsiteCapabilities(origin:string|URL,fetcher:typeof fetch=fetch) {
async function read(path:string,status=200) {
  const response=await fetcher(new URL(path,origin),{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
  if(response.status!==status||!/no-store/.test(response.headers.get("cache-control")??""))throw new Error("HTTP contract failed.");
  const bytes=await response.text();if(Buffer.byteLength(bytes)>8*1024*1024)throw new Error("Response limit exceeded.");return JSON.parse(bytes);
}
  const health=await fetcher(new URL("/api/health/content",origin),{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
  if(health.status!==204||!/no-store/.test(health.headers.get("cache-control")??"")||(await health.text())!=="")throw new Error("Liveness contract failed.");
  const timeline=await read("/api/timeline?limit=2");if(!Array.isArray(timeline.data?.items)||typeof timeline.data.total!=="number")throw new Error("Timeline DTO failed.");
  if(timeline.data.hasMore){const next=await read(`/api/timeline?limit=2&cursor=${encodeURIComponent(timeline.data.nextCursor)}`);if(next.data.items.some((i:{id:string})=>timeline.data.items.some((j:{id:string})=>i.id===j.id)))throw new Error("Repeated timeline records.");}
  await read("/api/timeline?limit=0",400);await read("/api/search?q=x&q=y",400);await read("/api/pages/unknown",404);
  const empty=await read("/api/search?q=capability_probe_absent_123456");if(!Array.isArray(empty.data?.items)||typeof empty.data.total!=="number")throw new Error("Search DTO failed.");
  const robots=await fetcher(new URL("/robots.txt",origin),{signal:AbortSignal.timeout(15000)});if(!robots.ok||!(await robots.text()).includes("Disallow: /"))throw new Error("Preview indexing was enabled.");
  return {capabilitiesVerified:true,providerIdentityVerified:false,timelineTotal:timeline.data.total,privatePreview:true};
}
async function main() {
  if(process.argv.length>3)throw new Error("Provider identity is no longer available from public HTTP.");
  console.log(JSON.stringify(await checkWebsiteCapabilities(websiteOrigin(process.argv[2]??"http://127.0.0.1:3100"))));
}
if(process.argv[1]?.endsWith("check-website-capabilities.ts"))main().catch(()=>{console.error("Website capability acceptance failed. Verify content access and HTTP contracts; check provider identity in the private runtime separately; response details are withheld.");process.exitCode=1;});
