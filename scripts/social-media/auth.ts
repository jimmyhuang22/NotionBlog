import { hasStorageRole } from "../../src/server/database/storage-role.ts";
import { SocialSyncError } from "../social-sync/model.ts";

/** One batch, one dedicated password session. No persisted access/refresh token, retry or broad key. */
export function createCoverAuthSession(env: Readonly<Record<string,string|undefined>>, role: "reader"|"writer", request: typeof fetch = fetch, signal?: AbortSignal, now=Date.now) {
  const prefix=`SOCIAL_MEDIA_STORAGE_${role.toUpperCase()}_`;
  const email=env[prefix+"EMAIL"],password=env[prefix+"PASSWORD"],userId=env[prefix+"USER_ID"],apiKey=env.SOCIAL_MEDIA_STORAGE_API_KEY;
  let auth:string;
  try {
    const url=new URL(env.SOCIAL_MEDIA_STORAGE_URL??"");
    if(!["reader","writer"].includes(role)||url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,"")!=="/storage/v1"||
      !email||email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length>4096||!userId||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(userId)||
      !apiKey||apiKey.startsWith("sb_secret_"))throw Error();
    if(!apiKey.startsWith("sb_publishable_")&&JSON.parse(Buffer.from(apiKey.split(".")[1]??"","base64url").toString()).role!=="anon")throw Error();
    auth=`${url.origin}/auth/v1`;
  }catch{throw new SocialSyncError("COVER_AUTH_CONFIG_INVALID");}
  let issued:string|undefined,pending:Promise<string>|undefined,closed=false,failed=false,closing:Promise<void>|undefined;
  const object=(x:unknown):Record<string,unknown>=>{if(!x||typeof x!=="object"||Array.isArray(x))throw Error();return x as Record<string,unknown>;};
  async function bounded(path:string,init:RequestInit,cleanup=false){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    const cancel=()=>controller.abort();if(!cleanup){signal?.addEventListener("abort",cancel,{once:true});if(signal?.aborted)cancel();}
    const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener("abort",()=>reject(Error()),{once:true}));
    try{
      if(controller.signal.aborted)throw Error();
      const response=await Promise.race([request(`${auth}${path}`,{...init,redirect:"error",cache:"no-store",signal:controller.signal}),aborted]);
      if(!response.ok||response.redirected){void response.body?.cancel().catch(()=>{});throw Error();}
      if(cleanup){await response.body?.cancel();return {};}
      if(!response.body)throw Error();
      const declared=response.headers.get("content-length");if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>65536)){void response.body.cancel().catch(()=>{});throw Error();}
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{while(true){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;size+=part.value.byteLength;if(size>65536)throw Error();chunks.push(part.value);}return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
      catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    }finally{clearTimeout(timer);if(!cleanup)signal?.removeEventListener("abort",cancel);}
  }
  async function login(){
    try{
      const value=await bounded("/token?grant_type=password",{method:"POST",headers:{apikey:apiKey!,"content-type":"application/json"},body:JSON.stringify({email,password})});
      const token=value.access_token;if(typeof token!=="string"||token.length>32768||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)||typeof value.token_type!=="string"||value.token_type.toLowerCase()!=="bearer")throw Error();
      const [header,claims]=token.split(".").slice(0,2).map(part=>object(JSON.parse(Buffer.from(part!,"base64url").toString())));
      if(!["HS256","ES256","RS256","EdDSA"].includes(String(header!.alg))||claims!.iss!==auth||claims!.sub!==userId||claims!.role!=="authenticated"||
        !(claims!.aud==="authenticated"||Array.isArray(claims!.aud)&&claims!.aud.includes("authenticated"))||
        !hasStorageRole(claims!.app_metadata,role,"social")||typeof claims!.exp!=="number"||!Number.isFinite(claims!.exp)||claims!.exp<=now()/1000+240)throw Error();
      issued=token;
      const user=await bounded("/user",{headers:{apikey:apiKey!,Authorization:`Bearer ${token}`}});
      if(user.id!==userId||user.role!=="authenticated"||user.is_anonymous===true||!hasStorageRole(user.app_metadata,role,"social"))throw Error();
      return token;
    }catch{failed=true;throw new SocialSyncError("COVER_AUTH_FAILED");}
  }
  return {
    async token(){if(closed||signal?.aborted)throw new SocialSyncError("COVER_AUTH_CLOSED");if(failed)throw new SocialSyncError("COVER_AUTH_FAILED");const token=await(pending??=login());if(closed||signal?.aborted)throw new SocialSyncError("COVER_AUTH_CLOSED");return token;},
    close(){return closing??=(async()=>{closed=true;await pending?.catch(()=>{});if(issued){const token=issued;issued=undefined;try{await bounded("/logout?scope=local",{method:"POST",headers:{apikey:apiKey!,Authorization:`Bearer ${token}`}},true);}catch{throw new SocialSyncError("COVER_AUTH_LOGOUT_FAILED");}}})();},
  };
}
