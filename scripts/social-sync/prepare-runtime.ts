import { generateKeyPairSync,createHash } from "node:crypto";
import { isAbsolute,join,resolve } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { access,chmod,copyFile,readFile,writeFile } from "node:fs/promises";
import { privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { browserLinks,NATIVE_HOST } from "./browser-bridge.ts";
import { inspectRefresh } from "./refresh-state.ts";
import { SocialSyncError } from "./model.ts";
import { prepareNativeLauncher } from "./native-launcher.ts";

export function extensionOrigin(publicKey:Buffer){
  const hex=createHash("sha256").update(publicKey).digest("hex").slice(0,32);
  return "chrome-extension://"+[...hex].map(c=>String.fromCharCode(97+parseInt(c,16))).join("")+"/";
}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const cleanPath=(s:string)=>isAbsolute(s)&&resolve(s)===s&&!/[\n\r\0]/.test(s);
/** Produce reviewable SSD files only. Does not register Chrome or install/enable a schedule. */
export async function prepareRuntime(root:string,out:string){
  if(!cleanPath(root)||!cleanPath(out)||out===root)throw new SocialSyncError("USAGE");
  await privateDirectory(root);await privateDirectory(out);
  try{await access(join(out,"extension"));throw new SocialSyncError("REFRESH_PACKAGE_EXISTS");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const state=await inspectRefresh(root,"xiaohongshu");
  browserLinks(JSON.parse(await readPrivateFile(join(root,"browser-links.json"),128*1024)),state.scope.publications.filter(p=>p.target.platform==="xiaohongshu").map(p=>p.target));
  try{await access(join(root,"bridge-config.json"));throw new SocialSyncError("REFRESH_PACKAGE_EXISTS");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const {publicKey}=generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"der"},privateKeyEncoding:{type:"pkcs8",format:"der"}}),origin=extensionOrigin(publicKey);
  const extension=join(out,"extension");await privateDirectory(extension);
  const base=new URL("./browser/",import.meta.url);
  for(const name of ["background.js","driver.js","capture.js","bilibili-directory.js"]){await copyFile(fileURLToPath(new URL(name,base)),join(extension,name));await chmod(join(extension,name),0o600);}
  const manifest=JSON.parse(await readFile(new URL("manifest.json",base),"utf8"));
  await writeJson(join(extension,"manifest.json"),{...manifest,key:publicKey.toString("base64")});
  const host=fileURLToPath(new URL("./native-host.ts",import.meta.url));
  const launcher=await prepareNativeLauncher({directory:out,node:process.execPath,host,runtime:root,origin});
  await writeJson(join(out,`${NATIVE_HOST}.json`),{name:NATIVE_HOST,description:"Fixed reviewed social refresh",path:launcher.path,type:"stdio",allowed_origins:[origin]});
  await writeJson(join(root,"bridge-config.json"),{version:1,origin,enabled:false});
  const cycle=fileURLToPath(new URL("./cycle-cli.ts",import.meta.url));
  await writeJson(join(out,"schedule-draft.json"),{version:1,enabled:false,installed:false,bilibili:{periodHours:6,checkMinutes:15,cron:"*/15 * * * *",timeoutSeconds:1000,command:[process.execPath,cycle,"run",root,"bilibili"]},xiaohongshu:{periodHours:24,checkMinutes:15,driver:"Chrome extension alarm",requiresLoggedInProfile:true,maxNotesPerBatch:5,maxBatches:32}});
  // A standalone Dagu candidate; it does not replace the content/image publisher's YAML or locks.
  await writeFile(join(out,"social-bilibili.dagu.yaml"),`description: Refresh reviewed Bilibili targets
schedule: "CRON_TZ=Australia/Melbourne */15 * * * *"
timeout_sec: 1000
max_clean_up_time_sec: 30
overlap_policy: skip
hist_retention_days: 14
dotenv: []
env:
  NODE_OPTIONS: ''
  NODE_PATH: ''
steps:
  - id: refresh
    run: |
      umask 077
      exec ${quote(process.execPath)} ${quote(cycle)} run ${quote(root)} bilibili
`,{mode:0o600});
  await writeJson(join(out,"prepared.json"),{version:1,preparedAt:new Date().toISOString(),origin,scopeDigest:state.scopeDigest,notes:state.entries.length,enabled:false,installed:false,sourceCodeRoot:fileURLToPath(new URL("../../",import.meta.url))});
  return {notes:state.entries.length,enabled:false,installed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==4){console.error("Usage: node scripts/social-sync/prepare-runtime.ts <absolute-private-runtime> <absolute-private-package>");process.exitCode=1;}
  else prepareRuntime(process.argv[2],process.argv[3]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({code:e instanceof SocialSyncError?e.code:"REFRESH_PREPARE_FAILED"}));process.exitCode=1;});
}
