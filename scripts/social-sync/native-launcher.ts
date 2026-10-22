import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access,chmod,writeFile } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { SocialSyncError } from "./model.ts";
import { NATIVE_HOST,validOrigin } from "./browser-bridge.ts";

const run=promisify(execFile);
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const cleanPath=(s:string)=>isAbsolute(s)&&resolve(s)===s&&!/[\n\r\0]/.test(s);
export const MAC_LAUNCHER_BUNDLE="NotionBlogSocialRefresh.app";
export const MAC_LAUNCHER_ID="com.notionblog.socialrefresh.launcher";
export type LauncherInput={directory:string;node:string;host:string;runtime:string;origin:string};
function validate(input:LauncherInput){
  if(![input.directory,input.node,input.host,input.runtime].every(cleanPath)||input.host.includes("\\")||!/^chrome-extension:\/\/[a-p]{32}\/$/.test(input.origin))throw new SocialSyncError("USAGE");
}
// Fixed-width octal encodes UTF-8, quotes, backslashes and shell-looking text as data.
const cString=(s:string)=>'"'+[...Buffer.from(s)].map(b=>"\\"+b.toString(8).padStart(3,"0")).join("")+'"';
export function macLauncherSource(input:LauncherInput){
  validate(input);
  return `#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <signal.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
extern char **environ;
static volatile sig_atomic_t child_pid=0;
static void forward_signal(int sig) { if(child_pid>0) kill((pid_t)child_pid,sig); }
int main(int argc,char **argv) {
  if(argc!=2 || strcmp(argv[1],${cString(input.origin)})!=0) return 64;
  umask(0077); unsetenv("NODE_OPTIONS"); unsetenv("NODE_PATH");
  sigset_t blocked,previous,empty;
  sigemptyset(&blocked); sigaddset(&blocked,SIGTERM); sigaddset(&blocked,SIGINT);
  sigemptyset(&empty);
  if(sigprocmask(SIG_BLOCK,&blocked,&previous)!=0) return 70;
  struct sigaction action={0}; action.sa_handler=forward_signal; sigemptyset(&action.sa_mask);
  if(sigaction(SIGTERM,&action,0)!=0 || sigaction(SIGINT,&action,0)!=0) return 70;
  posix_spawnattr_t attr;
  if(posix_spawnattr_init(&attr)!=0) return 70;
  if(posix_spawnattr_setsigmask(&attr,&empty)!=0 || posix_spawnattr_setflags(&attr,POSIX_SPAWN_SETSIGMASK)!=0) return 70;
  char *args[]={${cString(input.node)},${cString(input.host)},${cString(input.runtime)},argv[1],NULL};
  pid_t child; int status=0;
  int error=posix_spawn(&child,args[0],NULL,&attr,args,environ);
  posix_spawnattr_destroy(&attr);
  if(error) return 70;
  child_pid=(sig_atomic_t)child;
  sigprocmask(SIG_SETMASK,&previous,NULL);
  while(waitpid(child,&status,0)<0) { if(errno!=EINTR) return 70; }
  sigprocmask(SIG_BLOCK,&blocked,NULL); child_pid=0;
  return WIFEXITED(status)?WEXITSTATUS(status):WIFSIGNALED(status)?128+WTERMSIG(status):70;
}
`;
}
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>NotionBlog 社交刷新</string>
<key>CFBundleExecutable</key><string>native-host</string>
<key>CFBundleIdentifier</key><string>${MAC_LAUNCHER_ID}</string>
<key>CFBundleName</key><string>NotionBlog Social Refresh</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`;

/** Only builds a private candidate. Never registers Chrome, grants TCC or enables work. */
export async function prepareNativeLauncher(input:LauncherInput){
  validate(input);await privateDirectory(input.directory);
  const kind=process.platform==="darwin"?"mac-app":"shell";
  const app=join(input.directory,MAC_LAUNCHER_BUNDLE);
  const path=kind==="mac-app"?join(app,"Contents","MacOS","native-host"):join(input.directory,"native-host");
  try{await access(kind==="mac-app"?app:path);throw new SocialSyncError("REFRESH_PACKAGE_EXISTS");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  if(kind==="mac-app"){
    const contents=join(app,"Contents"),macos=join(contents,"MacOS"),source=join(input.directory,"native-launcher.c");
    await privateDirectory(app);await privateDirectory(contents);await privateDirectory(macos);
    await writeFile(source,macLauncherSource(input),{mode:0o600});
    await writeFile(join(contents,"Info.plist"),plist,{mode:0o600});
    try{
      const options={timeout:30000,maxBuffer:64*1024,env:{...process.env,NODE_OPTIONS:"",NODE_PATH:""}};
      await run("/usr/bin/clang",["-Wall","-Wextra","-Werror","-O2",source,"-o",path],options);
      await chmod(path,0o700);
      await run("/usr/bin/codesign",["--sign","-","--identifier",MAC_LAUNCHER_ID,app],options);
      await run("/usr/bin/codesign",["--verify","--strict",app],options);
    }catch{throw new SocialSyncError("REFRESH_MAC_LAUNCHER_BUILD_FAILED");}
  }else{
    await writeFile(path,`#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = ${quote(input.origin)} ] || exit 64\nunset NODE_OPTIONS NODE_PATH\nexec ${quote(input.node)} ${quote(input.host)} ${quote(input.runtime)} "$1"\n`,{mode:0o700});
  }
  await writeJson(join(input.directory,"native-launcher-review.json"),{version:1,kind,path,node:input.node,host:input.host,runtime:input.runtime,origin:input.origin,bundleIdentifier:kind==="mac-app"?MAC_LAUNCHER_ID:null,signatureVerified:kind==="mac-app",installed:false,enabled:false});
  return {kind,path};
}

/** Rebuild just a candidate adapter for an existing bridge, retaining its extension identity. */
export async function prepareExistingBridgeLauncher(root:string,out:string){
  if(!cleanPath(root)||!cleanPath(out)||root===out)throw new SocialSyncError("USAGE");
  await privateDirectory(root);
  const config=JSON.parse(await readPrivateFile(join(root,"bridge-config.json"),4096));
  if(!config||config.version!==1||!validOrigin(config.origin)||typeof config.enabled!=="boolean"||Object.keys(config).sort().join()!=="enabled,origin,version")throw new SocialSyncError("BRIDGE_ORIGIN_REJECTED");
  const launcher=await prepareNativeLauncher({directory:out,node:process.execPath,host:fileURLToPath(new URL("./native-host.ts",import.meta.url)),runtime:root,origin:config.origin});
  await writeJson(join(out,`${NATIVE_HOST}.json`),{name:NATIVE_HOST,description:"Fixed reviewed social refresh",path:launcher.path,type:"stdio",allowed_origins:[config.origin]});
  return {kind:launcher.kind,originReused:true,installed:false,enabled:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==4){console.error("Usage: node scripts/social-sync/native-launcher.ts <absolute-existing-runtime> <absolute-new-candidate-directory>");process.exitCode=1;}
  else prepareExistingBridgeLauncher(process.argv[2],process.argv[3]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({code:e instanceof SocialSyncError?e.code:"REFRESH_LAUNCHER_PREPARE_FAILED"}));process.exitCode=1;});
}
