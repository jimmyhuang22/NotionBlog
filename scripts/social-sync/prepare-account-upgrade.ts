import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { extensionOrigin } from "./prepare-runtime.ts";
import { prepareNativeLauncher } from "./native-launcher.ts";
import { NATIVE_HOST, validOrigin } from "./browser-bridge.ts";
import { hash, object, SocialSyncError } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";

const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
/** Reviewable, disabled files only. Preserve the installed extension's identity/key. */
export async function prepareAccountUpgrade(root:string,installedManifest:string,out:string){
  if(![root,installedManifest,out].every(p=>isAbsolute(p)&&resolve(p)===p&&!/[\n\r\0]/.test(p))||root===out)throw new SocialSyncError("USAGE");
  const bridge=object(JSON.parse(await readPrivateFile(join(root,"bridge-config.json"),4096))),old=object(JSON.parse(await readPrivateFile(installedManifest,64*1024)));
  if(!validOrigin(bridge.origin)||typeof old.key!=="string"||old.key.length>4096||extensionOrigin(Buffer.from(old.key,"base64"))!==bridge.origin)throw new SocialSyncError("BRIDGE_ORIGIN_REJECTED");
  const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),accounts=new Set([
    ...base.publications.filter(p=>p.target.platform==="bilibili").map(p=>p.target.accountId),...base.collections.map(c=>c.target.accountId)]);
  if(accounts.size!==1)throw new SocialSyncError("BILIBILI_ACCOUNT_POLICY_INVALID");
  await privateDirectory(out);const extension=join(out,"extension");await privateDirectory(extension);
  const browser=new URL("./browser/",import.meta.url);
  for(const file of ["background.js","driver.js","capture.js","bilibili-directory.js"]){await copyFile(fileURLToPath(new URL(file,browser)),join(extension,file));await chmod(join(extension,file),0o600);}
  const manifest=JSON.parse(await readFile(new URL("manifest.json",browser),"utf8"));await writeJson(join(extension,"manifest.json"),{...manifest,key:old.key});
  const launcher=await prepareNativeLauncher({directory:out,node:process.execPath,host:fileURLToPath(new URL("./native-host.ts",import.meta.url)),runtime:root,origin:bridge.origin});
  await writeJson(join(out,`${NATIVE_HOST}.json`),{name:NATIVE_HOST,description:"Fixed social refresh and account discovery",path:launcher.path,type:"stdio",allowed_origins:[bridge.origin]});
  const policy={version:1,baseScopeDigest:hash(JSON.stringify(base)),accountId:[...accounts][0],enabled:false};
  await writeJson(join(out,"bilibili-account.disabled.json"),policy);
  await writeFile(join(out,"social-bilibili.dagu.yaml"),`description: Refresh Bilibili targets
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
      exec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./cycle-cli.ts",import.meta.url)))} run ${quote(root)} bilibili
`,{mode:0o600});
  await writeJson(join(out,"account-upgrade-review.json"),{version:1,sourceCodeRoot:fileURLToPath(new URL("../../",import.meta.url)),origin:bridge.origin,
    installed:false,enabled:false,accountCount:1,baseScopeDigest:policy.baseScopeDigest,newHostPermission:"https://space.bilibili.com/*",
    existingNoteScopeUnchanged:true,newService:false,browserCadenceHours:6,checkMinutes:15,sourceRequests:0,cloudQueries:0});
  return {installed:false,enabled:false,originReused:true,accounts:1,kind:launcher.kind};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length===3&&process.argv[2]==="--help")console.log("node scripts/social-sync/prepare-account-upgrade.ts <absolute-runtime> <existing-extension-manifest> <new-private-candidate-directory>");
  else if(process.argv.length!==5){console.error("USAGE");process.exitCode=1;}
  else prepareAccountUpgrade(process.argv[2]!,process.argv[3]!,process.argv[4]!).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({code:e instanceof SocialSyncError?e.code:"PREPARE_FAILED"}));process.exitCode=1;});
}
