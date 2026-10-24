import { endianness } from "node:os";
import { isAbsolute,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { MAX_SNAPSHOT_BYTES } from "./xiaohongshu.ts";
import { handleBrowserMessage,validOrigin } from "./browser-bridge.ts";
import { SocialSyncError } from "./model.ts";

export function nativeFrame(value:unknown){
  const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);if(body.length>MAX_SNAPSHOT_BYTES+8192)throw new SocialSyncError("BRIDGE_MESSAGE_TOO_LARGE");
  if(endianness()==="LE")header.writeUInt32LE(body.length);else header.writeUInt32BE(body.length);return Buffer.concat([header,body]);
}
/** Read one bounded frame, without waiting for EOF (Chrome keeps stdin open). */
export async function readNativeMessage(input:Readable):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    let bytes=Buffer.alloc(0),expected:number|null=null;
    const finish=(error:unknown,value?:unknown)=>{clearTimeout(timer);input.pause();input.removeListener("data",data);input.removeListener("end",end);input.removeListener("error",fail);if(error)reject(error);else resolve(value);};
    const fail=(e:unknown)=>finish(e),end=()=>fail(new SocialSyncError("BRIDGE_MESSAGE_TRUNCATED"));
    const data=(chunk:Buffer)=>{try{
      if(bytes.length+chunk.length>MAX_SNAPSHOT_BYTES+8196)throw new SocialSyncError("BRIDGE_MESSAGE_TOO_LARGE");bytes=Buffer.concat([bytes,chunk]);
      if(expected===null&&bytes.length>=4){expected=endianness()==="LE"?bytes.readUInt32LE():bytes.readUInt32BE();if(!expected||expected>MAX_SNAPSHOT_BYTES+8192)throw new SocialSyncError("BRIDGE_MESSAGE_TOO_LARGE");}
      if(expected!==null&&bytes.length>=expected+4){if(bytes.length!==expected+4)throw new SocialSyncError("BRIDGE_MESSAGE_INVALID");const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(4));finish(null,JSON.parse(text));}
    }catch(e){fail(e);}};
    const timer=setTimeout(()=>fail(new SocialSyncError("BRIDGE_MESSAGE_TIMEOUT")),10000);timer.unref();input.on("data",data);input.once("end",end);input.once("error",fail);
  });
}
export async function runNativeHost(args:string[]){
  const [root,origin]=args;
  if(args.length!==2||!root||!isAbsolute(root)||resolve(root)!==root||!validOrigin(origin))throw new SocialSyncError("BRIDGE_ORIGIN_REJECTED");
  process.umask(0o077);
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.on("SIGTERM",cancel);process.on("SIGINT",cancel);
  try {
    const message=await readNativeMessage(process.stdin);
    if(controller.signal.aborted)throw new SocialSyncError("BRIDGE_CANCELLED");
    return await handleBrowserMessage(root,origin,message,{signal:controller.signal});
  } finally {process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const respond=(value:unknown)=>process.stdout.write(nativeFrame(value),()=>process.stdin.destroy());
  runNativeHost(process.argv.slice(2)).then(respond).catch(e=>{
    const code=e instanceof SocialSyncError?e.code:e?.code==="BUSY"?"BUSY":"BRIDGE_FAILED";respond({error:code});process.exitCode=1;
  });
}
