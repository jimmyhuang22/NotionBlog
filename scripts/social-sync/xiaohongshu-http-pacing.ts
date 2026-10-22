import { setTimeout as delay } from "node:timers/promises";
import { SocialSyncError } from "./model.ts";

export const XHS_HTTP_DUE_PER_CHECK = 40;
export const XHS_HTTP_SOURCE_INTERVAL_MS = 5000;

/** Shared across batches. Waiting uses no source request and remains cancellable. */
export function createHttpSourcePacer(ports:{now?:()=>number;sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>}={}){
  const now=ports.now??(()=>performance.now()),sleep=ports.sleep??((ms,signal)=>delay(ms,undefined,{signal}));
  let last:number|null=null;
  return async(signal?:AbortSignal)=>{
    if(signal?.aborted)throw new SocialSyncError("CANCELLED");
    const wait=last===null?0:Math.max(0,last+XHS_HTTP_SOURCE_INTERVAL_MS-now());
    if(wait)await sleep(wait,signal);
    if(signal?.aborted)throw new SocialSyncError("CANCELLED");
    last=now();
  };
}
