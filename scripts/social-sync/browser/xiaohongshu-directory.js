/** Read only rendered own-account posted cards. No cookies, signed APIs, detail tabs or comments. */
export function captureXhsDirectoryPage(expected){
  if(!/^[a-f0-9]{24}$/.test(expected.accountId)||location.origin!=="https://www.xiaohongshu.com"||location.pathname!==`/user/profile/${expected.accountId}`||location.search)return {error:"IDENTITY_MISMATCH"};
  const container=document.querySelector("#userPostedFeeds");if(!container)return {error:"DIRECTORY_NOT_READY"};
  const cards=[];
  for(const section of container.querySelectorAll("section.note-item")){
    const a=section.querySelector("a.cover[href]"),publicationId=section.getAttribute("data-note-id");
    if(!a||!publicationId)return {error:"DIRECTORY_NOT_READY"};
    const u=new URL(a.getAttribute("href"),location.origin);
    if(!/^[a-f0-9]{24}$/.test(publicationId)||u.origin!==location.origin||u.username||u.password||u.hash||
      u.pathname!==`/user/profile/${expected.accountId}/${publicationId}`||!u.searchParams.get("xsec_token"))return {error:"IDENTITY_MISMATCH"};
    cards.push({publicationId,url:u.href});
  }
  if(!cards.length)return {error:"DIRECTORY_NOT_READY"};
  return {cards,observedAt:new Date().toISOString()};
}
export function scrollXhsDirectory(expected){
  if(location.origin!=="https://www.xiaohongshu.com"||location.pathname!==`/user/profile/${expected.accountId}`||location.search)return {error:"IDENTITY_MISMATCH"};
  const sections=document.querySelectorAll("#userPostedFeeds section.note-item");sections[sections.length-1]?.scrollIntoView({block:"end"});return {scrolled:true};
}
export async function captureXhsDirectory(api,job,{now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),owned=async()=>{}}={}){
  if(!job||!/^[-a-f0-9]{36}$/.test(job.id)||!/^[a-f0-9]{24}$/.test(job.accountId)||!Array.isArray(job.knownIds)||job.knownIds.length<1||job.knownIds.length>500||
    job.knownIds.some(id=>!/^[a-f0-9]{24}$/.test(id))||Date.parse(job.expiresAt)<=now())throw Error("XHS_DIRECTORY_INVALID");
  const url=`https://www.xiaohongshu.com/user/profile/${job.accountId}`,tab=await api.tabs.create({url,active:false});if(!Number.isInteger(tab.id))throw Error("BROWSER_REQUIRED");
  const until=Math.min(now()+90000,Date.parse(job.expiresAt)),seen=new Map(),known=new Set(job.knownIds);let pages=0,lastCount=0;
  try{
    await owned(tab.id,job.accountId);
    while(now()<until){
      const current=await api.tabs.get(tab.id);if(current.status!=="complete"){await sleep(1000);continue;}
      if(current.url!==url)throw Error("SOURCE_BLOCKED");
      const rows=await api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:"MAIN",func:captureXhsDirectoryPage,args:[{accountId:job.accountId}]}),p=rows.find(r=>r.frameId===0)?.result;
      if(p?.error){if(p.error!=="DIRECTORY_NOT_READY")throw Error(p.error);await sleep(1000);continue;}
      if(!p?.cards)throw Error("XHS_DIRECTORY_INVALID");
      for(const c of p.cards)seen.set(c.publicationId,c);
      // Inspect the entire rendered page before accepting a boundary: known/pinned first cards
      // cannot hide a new card later in the same page. Missing old cards never mean deletion.
      if(p.cards.length>=30&&p.cards.slice(-5).every(c=>known.has(c.publicationId)))return {version:1,accountId:job.accountId,observedAt:p.observedAt,cards:[...seen.values()],boundaryFound:true};
      if(seen.size>300||pages>=10)throw Error("XHS_DIRECTORY_GAP");
      if(p.cards.length!==lastCount){lastCount=p.cards.length;pages++;await api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:"MAIN",func:scrollXhsDirectory,args:[{accountId:job.accountId}]});}
      await sleep(1000);
    }
    throw Error("BROWSER_TIMEOUT");
  }finally{await api.tabs.remove(tab.id).catch(()=>{});await owned(tab.id,null);}
}
