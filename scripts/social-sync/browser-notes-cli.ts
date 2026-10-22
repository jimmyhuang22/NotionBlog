import { isAbsolute,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { armBrowserNoteRecovery,finishBrowserNoteRecovery,inspectBrowserNoteRecovery,cancelBrowserNoteRecovery,retryBrowserNoteUpload } from "./xiaohongshu-browser-notes.ts";
import { SocialSyncError } from "./model.ts";

export async function browserNotesCli(args:string[]){
  if(args.length===1&&args[0]==="--help"){console.log("browser-notes-cli.ts status <runtime> | arm <runtime> <existing-note-id> | finish <runtime> <recovery-id> <reader-sha256> | cancel <runtime> <recovery-id> | retry-upload <runtime> <recovery-id>");return;}
  const [op,root,...rest]=args;if(!root||!isAbsolute(root)||resolve(root)!==root)throw new SocialSyncError("USAGE");process.umask(0o077);
  if(op==="status"&&rest.length===0)return inspectBrowserNoteRecovery(root);
  if(op==="arm"&&rest.length===1)return armBrowserNoteRecovery(root,rest[0]);
  if(op==="finish"&&rest.length===2)return finishBrowserNoteRecovery(root,rest[0],rest[1]);
  if(op==="cancel"&&rest.length===1)return cancelBrowserNoteRecovery(root,rest[0]);
  if(op==="retry-upload"&&rest.length===1)return retryBrowserNoteUpload(root,rest[0]);
  throw new SocialSyncError("USAGE");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)browserNotesCli(process.argv.slice(2)).then(v=>{if(v)console.log(JSON.stringify(v));}).catch(e=>{console.error(JSON.stringify({code:e instanceof SocialSyncError?e.code:e?.code==="BUSY"?"BUSY":"XHS_BROWSER_RECOVERY_FAILED"}));process.exitCode=1;});
