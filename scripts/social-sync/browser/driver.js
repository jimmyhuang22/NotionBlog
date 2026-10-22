import { captureNote } from "./capture.js";

/** An injection can stall even after dispatch; closing our tab bounds the unfinished read. */
async function readBeforeDeadline(pending,remainingMs){
  let timer;
  try{return await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),remainingMs);})]);}
  finally{clearTimeout(timer);}
}

export function checkedJob(value,{allowExpired=false}={}){
  if(!value||typeof value.id!=="string"||!/^[-a-f0-9]{36}$/.test(value.id)||!Array.isArray(value.targets)||value.targets.length<1||value.targets.length>5||!Number.isFinite(Date.parse(value.expiresAt))||!allowExpired&&Date.parse(value.expiresAt)<=Date.now())throw Error("BROWSER_REQUIRED");
  const ids=new Set();
  for(const t of value.targets){
    if(!/^[a-f0-9]{24}$/.test(t.publicationId)||!/^[a-f0-9]{24}$/.test(t.accountId)||ids.has(t.publicationId)||typeof t.url!=="string"||t.url.length>4096)throw Error("IDENTITY_MISMATCH");
    const u=new URL(t.url),match=new RegExp(`^/(?:explore|discovery/item|user/profile/${t.accountId})/([a-f0-9]{24})/?$`).exec(u.pathname);
    if(u.protocol!=="https:"||u.hostname!=="www.xiaohongshu.com"||u.username||u.password||u.port||u.hash||match?.[1]!==t.publicationId)throw Error("IDENTITY_MISMATCH");ids.add(t.publicationId);
  }return value;
}
/** Visits only newly-created tabs, closes them in finally, and never traverses comments or account lists. */
export async function captureJob(api,job,{now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),owned=async()=>{},diagnostics=false}={}){
  checkedJob(job,{allowExpired:diagnostics});const snapshots=[];
  for(const target of job.targets){
    const started=now();let polls=0,lastTabStatus="unknown",frozen=null,discarded=null,lastState=null,readAttempted=false;
    const timeout=async()=>{
      if(!diagnostics)return Error("BROWSER_TIMEOUT");
      const phase=now()>=Date.parse(job.expiresAt)?"lease":readAttempted||lastTabStatus==="complete"?"note-state":"page-load";
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(target.publicationId));
      const targetDigest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
      return Object.assign(Error({lease:"BROWSER_LEASE_EXPIRED","note-state":"BROWSER_NOTE_STATE_TIMEOUT","page-load":"BROWSER_PAGE_LOAD_TIMEOUT"}[phase]),
        {diagnostic:{version:1,jobId:job.id,targetDigest,phase,waitMs:Math.min(120000,Math.max(0,now()-started)),polls,lastTabStatus,frozen,discarded,lastState}});
    };
    if(now()>=Date.parse(job.expiresAt))throw await timeout();
    const tab=await api.tabs.create({url:target.url,active:false});if(!Number.isInteger(tab.id))throw Error("BROWSER_REQUIRED");
    try{
      await owned(tab.id,target);const until=Math.min(now()+20000,Date.parse(job.expiresAt));let snapshot=null;
      while(now()<until){
        const current=await api.tabs.get(tab.id);
        polls++;lastTabStatus=["loading","complete"].includes(current.status)?current.status:"unknown";
        frozen=typeof current.frozen==="boolean"?current.frozen:null;discarded=typeof current.discarded==="boolean"?current.discarded:null;
        if(current.status==="complete"||diagnostics&&current.status==="loading"){
          let u;try{u=new URL(current.url);}catch{}
          const match=u&&new RegExp(`^/(?:explore|discovery/item|user/profile/${target.accountId})/([a-f0-9]{24})/?$`).exec(u.pathname);
          if(!u||u.protocol!=="https:"||u.hostname!=="www.xiaohongshu.com"||u.port||u.username||u.password||match?.[1]!==target.publicationId){
            if(current.status==="complete")throw Error("SOURCE_BLOCKED");
            await sleep(1000);continue;
          }
          if(diagnostics&&(frozen||discarded)){await sleep(1000);continue;}
          if(diagnostics&&now()>=until)break;
          readAttempted=true;
          const pending=api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:"MAIN",...(diagnostics?{injectImmediately:true}:{}),func:captureNote,args:[{publicationId:target.publicationId,accountId:target.accountId,...(target.requireShareable?{requireShareable:true}:{})}]});
          const rows=diagnostics?await readBeforeDeadline(pending,Math.max(0,until-now())):await pending;
          if(diagnostics&&(!rows||now()>=until))break;
          const result=rows.find(r=>r.frameId===0)?.result;
          lastState=result?.error==="NOTE_STATE_MISSING"?"NOTE_STATE_MISSING":null;
          if(result?.error&&result.error!=="NOTE_STATE_MISSING")throw Error(result.error);
          if(result&&!result.error){snapshot=result;break;}
        }
        await sleep(1000);
      }
      if(!snapshot)throw await timeout();snapshots.push(snapshot);
    }finally{await api.tabs.remove(tab.id).catch(()=>{});await owned(tab.id,null);}
    await sleep(1000);
  }return snapshots;
}
