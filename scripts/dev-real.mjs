import { readFileSync,lstatSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./development/clean-environment.mjs";
import { createCloudSession, unusedLocalPort, validatePlan } from "./development/cloud-session.mjs";
const allowed=new Set(["SOCIAL_PROVIDER","SOCIAL_DISPLAY_MODE","SOCIAL_MEDIA_ENABLED","SOCIAL_COLLECTION_PLAYBACK","SOCIAL_COLLECTION_DAY_ADDITIONS","SOCIAL_READER_DATABASE_URL","SOCIAL_READER_DATABASE_TLS","SOCIAL_READER_DATABASE_CA_CERT","SOCIAL_READER_CONNECTION_MODE","SOCIAL_MEDIA_STORAGE_PROVIDER","SOCIAL_MEDIA_STORAGE_URL","SOCIAL_MEDIA_STORAGE_BUCKET","SOCIAL_MEDIA_STORAGE_API_KEY","SOCIAL_MEDIA_STORAGE_READ_TOKEN","SOCIAL_MEDIA_STORAGE_READER_EMAIL","SOCIAL_MEDIA_STORAGE_READER_PASSWORD","SOCIAL_MEDIA_STORAGE_READER_USER_ID","SOCIAL_MEDIA_COS_BUCKET","SOCIAL_MEDIA_COS_REGION","SOCIAL_MEDIA_COS_PREFIX","SOCIAL_MEDIA_COS_SECRET_ID","SOCIAL_MEDIA_COS_SECRET_KEY","SOCIAL_MEDIA_COS_SECURITY_TOKEN","SOCIAL_MEDIA_COS_CREDENTIALS_EXPIRES_AT","CONTENT_PROVIDER","MEDIA_PROVIDER","MEDIA_THUMBNAILS","CONTENT_FEATURES_JSON","DATABASE_CONTENT_VERSION","DATABASE_PUBLICATION_MODE","DATABASE_READ_PROJECTION","DATABASE_READER_URL","DATABASE_TLS","DATABASE_CA_CERT","DATABASE_MEDIA_DIRECTORY","STORAGE_PROVIDER","THUMBNAIL_STORAGE_PROVIDER","COS_BUCKET","COS_REGION","COS_PREFIX","COS_SECRET_ID","COS_SECRET_KEY","COS_SECURITY_TOKEN","COS_CREDENTIALS_EXPIRES_AT","STORAGE_URL","STORAGE_BUCKET","STORAGE_API_KEY","STORAGE_READ_TOKEN","STORAGE_READER_EMAIL","STORAGE_READER_PASSWORD","STORAGE_READER_USER_ID","NOTION_TOKEN","NOTION_API_VERSION","NOTION_SOURCES_JSON","NOTION_SOURCES_CONFIG","MEDIA_SIGNING_SECRET","SITE_CONFIG_JSON","SITE_CONFIG","SITE_NAME","SITE_URL","SITE_DISCOVERY_KINDS_JSON"]);
function privateFile(path) {
  const full=resolve(path),stat=lstatSync(full);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error("Private files must be owner-only regular files.");
  return full;
}
async function main(){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){const k=args[i];if(!["--env","--plan","--sources","--site","--provider","--port","--allow-cloud","--duration-seconds"].includes(k)||!args[i+1]||options[k])throw new Error("Invalid preview options.");options[k]=args[i+1];}
  if(options["--allow-cloud"]!=="yes"||!/^\d{1,3}$/.test(options["--duration-seconds"]??"")||Number(options["--duration-seconds"])<1||Number(options["--duration-seconds"])>900)throw new Error("Explicit bounded cloud permission is required.");
  if(!options["--env"])throw new Error("A private reader environment file is required.");
  if(!options["--plan"])throw new Error("A private fixed sample and budget plan is required.");
  const plan=validatePlan(JSON.parse(readFileSync(privateFile(options["--plan"]),"utf8")));
  const values=parseEnv(readFileSync(privateFile(options["--env"]),"utf8"));
  const env=cleanEnvironment();
  for(const [k,v] of Object.entries(values))if(allowed.has(k))env[k]=v;
  env.CONTENT_PROVIDER=options["--provider"]??values.CONTENT_PROVIDER??"database";
  if(!["database","notion"].includes(env.CONTENT_PROVIDER))throw new Error("Real preview requires a real provider.");
  if(env.DATABASE_READ_PROJECTION!==undefined&&!["legacy","scoped"].includes(env.DATABASE_READ_PROJECTION))throw new Error("Invalid preview read projection.");
  if(env.DATABASE_READ_PROJECTION==="scoped"&&(env.CONTENT_PROVIDER!=="database"||env.DATABASE_CONTENT_VERSION!=="2"))throw new Error("Scoped preview requires database v2.");
  if(env.MEDIA_PROVIDER!==undefined&&!["storage","notion"].includes(env.MEDIA_PROVIDER))throw new Error("Invalid preview media provider.");
  for(const key of ["STORAGE_PROVIDER","THUMBNAIL_STORAGE_PROVIDER"])if(env[key]!==undefined&&!["supabase","cos"].includes(env[key]))throw new Error("Invalid preview storage provider.");
  if(env.DATABASE_MEDIA_DIRECTORY&&[env.STORAGE_PROVIDER,env.THUMBNAIL_STORAGE_PROVIDER].includes("cos"))throw new Error("COS preview cannot use a local media directory.");
  if(env.CONTENT_PROVIDER==="database"&&!env.DATABASE_READER_URL)throw new Error("A restricted database reader URL is required.");
  if(env.CONTENT_PROVIDER==="notion"&&!env.NOTION_TOKEN)throw new Error("A read-only Notion integration is required.");
  if(options["--sources"]){env.NOTION_SOURCES_CONFIG=privateFile(options["--sources"]);delete env.NOTION_SOURCES_JSON;}
  if(options["--site"]){env.SITE_CONFIG=privateFile(options["--site"]);delete env.SITE_CONFIG_JSON;}
  const port=options["--port"]??"3100";if(!/^\d{4,5}$/.test(port)||Number(port)<1024||Number(port)>65535)throw new Error("Invalid local port.");
  // The preview cannot enable indexing or expose writer/owner credentials to Next.
  env.NOTIONBLOG_DEVELOPMENT_MODE="cloud";env.NOTIONBLOG_CLOUD_PREVIEW_EXPIRES=String(Date.now()+Number(options["--duration-seconds"])*1000);
  env.SITE_INDEXING_ENABLED="false";env.SITE_URL=`http://127.0.0.1:${port}`;
  let child,force;
  const kill=signal=>{if(child?.pid){try{process.kill(-child.pid,signal);}catch{ /* Already stopped. */ }}};
  const session=await createCloudSession(plan,()=>{kill('SIGTERM');force=setTimeout(()=>kill('SIGKILL'),2000);});
  env.NOTIONBLOG_CLOUD_RELAY=JSON.stringify(session.mapping);
  env.NODE_OPTIONS=`--require=${JSON.stringify(fileURLToPath(new URL('./development/cloud-network.cjs',import.meta.url)))}`;
  env.NOTIONBLOG_CLOUD_PREVIEW_KEYS=JSON.stringify(Object.keys(env));
  let deadline;
  try {
    const nextPort=await unusedLocalPort();
    if(nextPort===Number(port))throw new Error('Local port conflict.');
    await session.gateway(Number(port),nextPort);
    console.log(`Metered ${env.CONTENT_PROVIDER} preview: http://127.0.0.1:${port}; only the fixed samples are allowed.`);
    child=spawn(process.execPath,["node_modules/next/dist/bin/next","dev","--hostname","127.0.0.1","--port",String(nextPort)],{stdio:"inherit",env,detached:true});
    deadline=setTimeout(()=>{console.error("Cloud preview deadline reached; stopping this preview.");session.stop('deadline');},Number(options["--duration-seconds"])*1000);
    for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>session.stop('operator_stop'));
    const code=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});
    process.exitCode=session.state.stopped||code!==0?1:0;
  } finally {
    clearTimeout(deadline);clearTimeout(force);kill('SIGKILL');session.stop('child_exit');clearTimeout(force);
    console.log('Cloud preview counters:',JSON.stringify(session.state));
  }
}
try{await main();}catch{console.error("Real preview could not start. Verify the private reader file, fixed plan and options; credentials are withheld.");process.exitCode=1;}
