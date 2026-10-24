import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
const environment=new URL('../scripts/development/environment.ts',import.meta.url).href;
const nextConfig=new URL('../next.config.ts',import.meta.url).href;

test('Preview and CI retain neither production credentials nor external browser resources; production is explicit',async()=>{
 for(const target of [
  {VERCEL:'1',VERCEL_ENV:'preview'},
  {VERCEL:'1',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'staging'},
  {VERCEL:'1',VERCEL_ENV:'production',GITHUB_ACTIONS:'true'},
  {VERCEL:'1',VERCEL_ENV:'production'},
  {VERCEL:'1',VERCEL_ENV:'production',VERCEL_TARGET_ENV:'production'},
 ]){
  const script=`for(const key of ['VERCEL','VERCEL_ENV','VERCEL_TARGET_ENV','GITHUB_ACTIONS','NOTIONBLOG_DEVELOPMENT_MODE'])delete process.env[key];Object.assign(process.env,${JSON.stringify(target)},{CONTENT_PROVIDER:'database',DATABASE_READER_URL:'synthetic-private'});const {default:config}=await import(${JSON.stringify(nextConfig)});const result=config('phase-production-build');console.log(JSON.stringify({provider:process.env.CONTENT_PROVIDER,reader:!!process.env.DATABASE_READER_URL,headers:result.headers?await result.headers():[],compiledProvider:result.env?.CONTENT_PROVIDER??null}));`;
  const result=JSON.parse((await execute(process.execPath,['--input-type=module','-e',script])).stdout.trim());
  const production=target.VERCEL_ENV==='production'&&(!target.VERCEL_TARGET_ENV||target.VERCEL_TARGET_ENV==='production')&&!target.GITHUB_ACTIONS;
  assert.equal(result.provider,production?'database':'mock');assert.equal(result.reader,production);
  assert.equal(result.compiledProvider,production?null:'mock');
  const base=result.headers.find((rule:{source:string})=>rule.source==='/:path*');
  const headers=new Headers(base.headers.map((header:{key:string,value:string})=>[header.key,header.value]));
  assert.equal(headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(headers.get('Referrer-Policy'),'strict-origin-when-cross-origin');
  assert.equal(headers.get('X-Frame-Options'),'SAMEORIGIN');
  const media=result.headers.find((rule:{source:string})=>rule.source==='/media/:path*');
  assert.equal(media.headers.find((header:{key:string})=>header.key==='Referrer-Policy').value,'no-referrer');
  assert.ok(result.headers.indexOf(media)>result.headers.indexOf(base),'media policy must override the general policy');
  const policy=headers.get('Content-Security-Policy')!;
  if(production){
   assert.equal(policy,"frame-ancestors 'self'");
   assert.equal(headers.get('X-Robots-Tag'),null);
  }else {
   assert.equal(headers.get('X-Robots-Tag'),'noindex, nofollow');
   assert.match(policy,/img-src 'self' data: blob:/);assert.match(policy,/connect-src 'self' ws:\/\/127/);assert.doesNotMatch(policy,/https:\/\/|\*\.supabase/);
  }
 }
});

test('actual build wrapper excludes inherited and dotenv credentials before its Next child and descendant start',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'offline-build-'));
 try{
  await mkdir(join(root,'tests'));await mkdir(join(root,'scripts'));await mkdir(join(root,'node_modules/next/dist/bin'),{recursive:true});
  await writeFile(join(root,'.env.production.local'),'CONTENT_PROVIDER=database\nNEXT_PUBLIC_REMOTE=synthetic\nUNRELATED_SECRET=synthetic\n');
  await writeFile(join(root,'scripts/check-build-privacy.mjs'),'');
  await writeFile(join(root,'node_modules/next/dist/bin/next'),`const {parseEnv}=require('node:util'),fs=require('node:fs');for(const[k,v]of Object.entries(parseEnv(fs.readFileSync('.env.production.local','utf8'))))if(!Object.hasOwn(process.env,k))process.env[k]=v;let blocked=false;try{require('node:net').connect(5432,'fixture.invalid')}catch(e){blocked=e.code==='OFFLINE_NETWORK_BLOCKED'}const code="let blocked=false;try{require('node:net').connect(443,'fixture.invalid')}catch(e){blocked=e.code==='OFFLINE_NETWORK_BLOCKED'}console.log(JSON.stringify({blocked}))";const child=require('node:child_process').spawnSync(process.execPath,['-e',code],{encoding:'utf8'});console.log(JSON.stringify({provider:process.env.CONTENT_PROVIDER,secret:!!process.env.UNRELATED_SECRET||!!process.env.DATABASE_READER_URL||!!process.env.NEXT_PUBLIC_REMOTE,blocked,descendant:JSON.parse(child.stdout).blocked}));`);
  const launcher=new URL('../scripts/development/run.mjs',import.meta.url);
  const result=await execute(process.execPath,[launcher.pathname,'build'],{cwd:root,env:{...process.env,VERCEL:'1',VERCEL_ENV:'production',GITHUB_ACTIONS:'true',DATABASE_READER_URL:'synthetic',UNRELATED_SECRET:'synthetic'}});
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)!),{provider:'mock',secret:false,blocked:true,descendant:true});
 }finally{await rm(root,{recursive:true,force:true})}
});

test('offline development replaces loaded real providers, removes credentials and blocks external transports before lookup',async()=>{
 const script=`
 const {configureDevelopmentEnvironment}=await import(${JSON.stringify(environment)});
 const env={CONTENT_PROVIDER:'database',SOCIAL_PROVIDER:'database',DATABASE_READER_URL:'private-database',SOCIAL_READER_DATABASE_URL:'private-social',NOTION_TOKEN:'private-notion',COS_SECRET_KEY:'private-cos',SITE_CONFIG_JSON:'{"avatar":"https://example.invalid/private.png"}',SITE_INDEXING_ENABLED:'true',NEXT_PUBLIC_REMOTE:'private-public',PORT:'3199'};
 const mode=configureDevelopmentEnvironment(env);
 const net=await import('node:net'),tls=await import('node:tls'),http=await import('node:http');
 let lookups=0,blocked=0;
 for(const open of [()=>net.connect({host:'example.invalid',port:5432,lookup(){lookups++}}),()=>tls.connect({host:'example.invalid',port:443}),()=>http.get('http://example.invalid/')])try{open()}catch(e){if(e.code==='OFFLINE_NETWORK_BLOCKED')blocked++;else throw e}
 try{await fetch('https://example.invalid/')}catch(e){if(e.code==='OFFLINE_NETWORK_BLOCKED')blocked++;else throw e}
 const server=http.createServer((q,s)=>s.end('local-only'));
 await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});
 const response=await fetch('http://127.0.0.1:'+server.address().port);
 const body=await response.text();server.closeAllConnections();await new Promise(r=>server.close(r));
 console.log(JSON.stringify({mode,content:env.CONTENT_PROVIDER,social:env.SOCIAL_PROVIDER,indexing:env.SITE_INDEXING_ENABLED,site:env.SITE_CONFIG_JSON,secrets:['DATABASE_READER_URL','SOCIAL_READER_DATABASE_URL','NOTION_TOKEN','COS_SECRET_KEY','NEXT_PUBLIC_REMOTE'].map(k=>env[k]),blocked,lookups,body}));`;
 const result=await execute(process.execPath,['--input-type=module','-e',script]);
 assert.deepEqual(JSON.parse(result.stdout.trim()),{mode:'offline',content:'mock',social:'mock',indexing:'false',site:'{}',secrets:['','','','',''],blocked:4,lookups:0,body:'local-only'});
});

test('direct Next dev/build/start are isolated after dotenv without a platform production target',async()=>{
 for(const phase of ['phase-development-server','phase-production-build','phase-production-server']){
  const script=`process.env.CONTENT_PROVIDER='database';process.env.DATABASE_READER_URL='private-value';delete process.env.NOTIONBLOG_DEVELOPMENT_MODE;delete process.env.VERCEL;const {default:config}=await import(${JSON.stringify(nextConfig)});config(${JSON.stringify(phase)});console.log(JSON.stringify({provider:process.env.CONTENT_PROVIDER,reader:!!process.env.DATABASE_READER_URL}));`;
  const result=await execute(process.execPath,['--input-type=module','-e',script]);
  assert.deepEqual(JSON.parse(result.stdout.trim()),{provider:'mock',reader:false});
 }
});

test('cloud development requires a newly bounded session and preserves its real provider without fallback',async()=>{
 const script=`const{configureDevelopmentEnvironment}=await import(${JSON.stringify(environment)});const now=1000000;let rejected=0;for(const expires of [undefined,'NaN','999999','1900001'])try{configureDevelopmentEnvironment({NOTIONBLOG_DEVELOPMENT_MODE:'cloud',NOTIONBLOG_CLOUD_PREVIEW_EXPIRES:expires},now)}catch{rejected++}const env={NOTIONBLOG_DEVELOPMENT_MODE:'cloud',NOTIONBLOG_CLOUD_PREVIEW_EXPIRES:'1100000',NOTIONBLOG_CLOUD_RELAY:'[]',NOTIONBLOG_CLOUD_PREVIEW_KEYS:'[\"CONTENT_PROVIDER\"]',CONTENT_PROVIDER:'database',SOCIAL_READER_DATABASE_URL:'unselected-dotenv-secret'};console.log(JSON.stringify({rejected,mode:configureDevelopmentEnvironment(env,now),provider:env.CONTENT_PROVIDER,unexpectedReader:!!env.SOCIAL_READER_DATABASE_URL}));`;
 const r=await execute(process.execPath,['--input-type=module','-e',script]);assert.deepEqual(JSON.parse(r.stdout.trim()),{rejected:4,mode:'cloud',provider:'database',unexpectedReader:false});
});

test('offline launcher forces demos before an older checkout loads dotenv and the child inherits its transport guard',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'offline-launcher-'));
 try{
  const bin=join(root,'node_modules/next/dist/bin');await mkdir(bin,{recursive:true});
  await writeFile(join(root,'.env.local'),['DATABASE_READER_URL=fixture','NOTION_TOKEN=example','PGPASSWORD=fixture'].join('\n'));
  await writeFile(join(bin,'next'),`for(const [k,v] of Object.entries(require('node:util').parseEnv(require('node:fs').readFileSync('.env.local','utf8')))){if(!Object.hasOwn(process.env,k))process.env[k]=v}const net=require('node:net');let blocked=false;try{net.connect({host:'example.invalid',port:5432})}catch(e){blocked=e.code==='OFFLINE_NETWORK_BLOCKED'}console.log(JSON.stringify({content:process.env.CONTENT_PROVIDER,social:process.env.SOCIAL_PROVIDER,secret:!!process.env.NOTION_TOKEN||!!process.env.DATABASE_READER_URL||!!process.env.PGPASSWORD,site:process.env.SITE_CONFIG_JSON,blocked}));`);
  const launcher=new URL('../scripts/dev-offline.mjs',import.meta.url);
  const r=await execute(process.execPath,[launcher.pathname,'--port','3198'],{cwd:root,env:{...process.env,CONTENT_PROVIDER:'database',SOCIAL_PROVIDER:'database',NOTION_TOKEN:'fictional-private-reader',SITE_CONFIG_JSON:'{"name":"private"}'}});
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)!),{content:'mock',social:'mock',secret:false,site:'{}',blocked:true});
 }finally{await rm(root,{recursive:true,force:true})}
});
