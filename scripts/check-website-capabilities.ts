import { websiteOrigin } from "./check-website.ts";
const origin=websiteOrigin(process.argv[2]??"http://127.0.0.1:3100"),headers={"Cache-Control":"no-store"};
async function read(path:string,status=200) {
  const response=await fetch(new URL(path,origin),{headers,redirect:"error",signal:AbortSignal.timeout(15000)});
  if(response.status!==status||!/no-store/.test(response.headers.get("cache-control")??""))throw new Error("HTTP contract failed.");
  const bytes=await response.text();if(Buffer.byteLength(bytes)>8*1024*1024)throw new Error("Response limit exceeded.");return JSON.parse(bytes);
}
async function main() {
  const identity=await read("/api/health/content"),expected=process.argv[3]??"database";
  if(!["database","notion"].includes(expected)||identity.data?.provider!==expected||(expected==="database"&&identity.data.databaseVersion!=="2"))throw new Error("Expected a real provider and matching content version.");
  const timeline=await read("/api/timeline?limit=2");if(!Array.isArray(timeline.data?.items)||typeof timeline.data.total!=="number")throw new Error("Timeline DTO failed.");
  if(timeline.data.hasMore){const next=await read(`/api/timeline?limit=2&cursor=${encodeURIComponent(timeline.data.nextCursor)}`);if(next.data.items.some((i:{id:string})=>timeline.data.items.some((j:{id:string})=>i.id===j.id)))throw new Error("Repeated timeline records.");}
  await read("/api/timeline?limit=0",400);await read("/api/search?q=x&q=y",400);await read("/api/pages/unknown",404);
  const empty=await read("/api/search?q=capability_probe_absent_123456");if(!Array.isArray(empty.data?.items)||typeof empty.data.total!=="number")throw new Error("Search DTO failed.");
  const robots=await fetch(new URL("/robots.txt",origin),{signal:AbortSignal.timeout(15000)});if(!robots.ok||!(await robots.text()).includes("Disallow: /"))throw new Error("Preview indexing was enabled.");
  console.log(JSON.stringify({capabilitiesVerified:true,provider:expected,timelineTotal:timeline.data.total,privatePreview:true}));
}
if(process.argv[1]?.endsWith("check-website-capabilities.ts"))main().catch(()=>{console.error("Website capability acceptance failed. Verify provider, freshness, source access and route version; response details are withheld.");process.exitCode=1;});
