import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { createDemo, demoId, DEMO_PNG } from "../../scripts/notion-sync/demo.ts";
import { createMediaSigner } from "../../src/server/notion/media.ts";
import { DIRECT_POLICY_CATALOG_SQL, DIRECT_POLICY_SQL } from "../../src/server/database/direct-notion-policy.ts";
import protocol from "../../database/notion-direct-deny-protocol.json" with {type:"json"};

// Child process only: inject image bytes while retaining the real route, runtime,
// SQL budget, policy reader, Notion SDK and repository. Native HTTPS is tested separately.
const marker = "__fictionalDirectDownload";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith("/notion-direct-download.ts")) return { url: "data:text/javascript," + encodeURIComponent(`export const downloadDirectImage=(...args)=>globalThis.${marker}(...args);`), shortCircuit: true };
  return next(specifier, context);
} });
const demo = createDemo(1), owner = demoId(1000), url = "https://assets.example.test/fictional.png?private-signature=fictional";
demo.config.sources[0].cover = {strategy:"native-page-cover"}; demo.pages.get(owner)!.cover = {type:"external",external:{url}};
Object.assign(process.env, {CONTENT_PROVIDER:"notion",NOTION_TOKEN:"fictional-token",MEDIA_SIGNING_SECRET:"fictional-signing",NOTION_SOURCES_JSON:JSON.stringify(demo.config),DATABASE_TLS:"verify",DATABASE_READER_ISOLATION:"off"});
delete process.env.DATABASE_READER_URL;
let queries = 0, notions = 0, images = 0, capability = true, denied = false, revision = "1:2", onDownload: (()=>void)|undefined;
const raw = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`,import.meta.url),"utf8");
const catalog = {source:raw.split("$body$")[1],definer:true,volatility:"s",language:"plpgsql",config:["search_path=pg_catalog"],arguments:"23 1009",result_type:"jsonb",
  owner_matches:true,only_function:true,reader_safe:true,callable:true,exact_acl:true};
const originalConnect = Pool.prototype.connect, originalFetch = globalThis.fetch;
try {
  Pool.prototype.connect = function(this: Pool, callback: (error:Error|null,client:PoolClient)=>void) {
    assert.equal(this.options.ssl && typeof this.options.ssl === "object" && this.options.ssl.rejectUnauthorized,true);
    const client = Object.assign(new EventEmitter(), {query:async(config:QueryConfig & {query_timeout:number})=>{
      queries++; assert.ok(config.query_timeout>0&&config.query_timeout<=8000);
      if(config.text===DIRECT_POLICY_CATALOG_SQL)return{rows:capability?[catalog]:[]};
      assert.equal(config.text,DIRECT_POLICY_SQL); assert.equal(config.values![0],1);
      return{rows:[{result:{revision,denied:config.values![1].map(()=>denied)}}]};
    },release:()=>{}});callback(null,client as unknown as PoolClient);
  } as typeof Pool.prototype.connect;
  globalThis.fetch = async input=>{
    notions++;const target = new URL(String(input));assert.equal(target.origin,"https://api.notion.com");
    const parts=target.pathname.split("/"),key=(parts[3]??"").replaceAll("-","");
    const value=parts[2]==="pages"?demo.pages.get(key):parts[2]==="data_sources"?demo.schemas.get(key):null;
    assert.ok(value);return Response.json(value);
  };
  Object.assign(globalThis,{[marker]:async (value:string,signal:AbortSignal)=>{images++;assert.equal(value,url);assert.equal(signal.aborted,false);onDownload?.();return{bytes:DEMO_PNG,mime:"image/png"};}});
  const {GET}=await import("../../src/app/media/[assetId]/route.ts");
  const asset=(await createMediaSigner("fictional-signing").registerImage({ownerPageId:owner,alt:"",url}))!;
  const context={params:Promise.resolve({assetId:asset.id})},request=()=>new Request(`https://website.example.test/media/${asset.id}`);
  assert.equal((await GET(request(),context)).status,503);assert.equal(queries,0);assert.equal(notions,0);
  process.env.DATABASE_READER_URL="postgres://fictional_reader:fictional@localhost/db";capability=false;
  assert.equal((await GET(request(),context)).status,503);assert.equal(notions,0);capability=true;
  const good=await GET(request(),context);assert.equal(good.status,200);assert.equal(good.headers.get("Location"),null);assert.deepEqual(Buffer.from(await good.arrayBuffer()),DEMO_PNG);assert.equal(images,1);
  denied=true;const before=notions;assert.equal((await GET(request(),context)).status,404);assert.equal(notions,before);assert.equal(images,1);denied=false;
  onDownload=()=>{revision="1:3";};const changed=await GET(request(),context);assert.equal(changed.status,503);assert.equal((await changed.text()).includes("private-signature"),false);
  console.log(JSON.stringify({missingBinding:true,missingCapability:true,bytes:true,withdrawal:true,versionRace:true}));
} finally { Pool.prototype.connect=originalConnect;globalThis.fetch=originalFetch;hooks.deregister(); }
